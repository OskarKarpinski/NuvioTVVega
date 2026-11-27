#include "NuvioMediaProxy.h"

#include <algorithm>
#include <cerrno>
#include <cctype>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <fcntl.h>
#include <fstream>
#include <iterator>
#include <map>
#include <memory>
#include <mutex>
#include <poll.h>
#include <sstream>
#include <string>
#include <sys/stat.h>
#include <sys/wait.h>
#include <thread>
#include <type_traits>
#include <unistd.h>
#include <vector>

extern char **environ;

namespace nuviomediaproxyTurboModule {

namespace {

using com::amazon::kepler::turbomodule::JSObject;

/**
 * Only the ffmpeg binary shipped inside the package is used. The Kepler app
 * sandbox has its own /usr/lib with an incompatible libav* build, so calling
 * the system binary there fails with unresolved ABI symbols.
 */
// The packaging tool only ships executable ELFs whose names look like shared
// libraries, so the bundled ffmpeg binary is staged under a .so name. It is
// launched through the bundled loader, not dlopen()ed.
constexpr const char* FFMPEG_BINARY = "libnuvioffmpeg.so";
constexpr const char* LOADER_BINARY = "ld-linux-armhf.so.3";
constexpr const char* SELF_TEST_PATH = "/tmp/nuvio-selftest.log";

/** Enough of a Matroska file for the native demuxer to report metadata. */
constexpr long long MIN_PREROLL_BYTES = 128LL * 1024;
constexpr std::chrono::milliseconds PREROLL_DEADLINE{4000};
constexpr long long LOG_TAIL_BYTES = 8 * 1024;

struct ProxySession {
  std::string id;
  std::string url;
  std::string headers;
  std::string cachePath;
  std::string logPath;
  std::string localUrl;
  double startTimeSec = 0;
  int audioTrackIndex = -1;
  int audioTrackCount = 0;
  pid_t ffmpegPid = -1;
  bool stopping = false;
  bool ready = false;
  bool ffmpegDone = false;
  int ffmpegExitCode = 0;
  std::string error;
  /** JSON array of audio streams discovered from ffmpeg's input stream list. */
  std::string audioTracksJson = "[]";
  std::mutex mutex;
  std::condition_variable cv;
  std::thread monitorThread;
};

std::mutex gSessionsMutex;
std::map<std::string, std::shared_ptr<ProxySession>> gSessions;

template <typename T>
T valueOr(const JSObject& object, const char* key, T fallback) {
  const auto it = object.find(key);
  if (it == object.end()) {
    return fallback;
  }
  const auto& value = it->second;
  if constexpr (std::is_same_v<T, std::string>) {
    if (const auto* ptr = std::get_if<std::string>(&value)) {
      return *ptr;
    }
  } else if constexpr (std::is_same_v<T, double>) {
    if (const auto* ptr = std::get_if<double>(&value)) {
      return *ptr;
    }
    if (const auto* ptr = std::get_if<int64_t>(&value)) {
      return static_cast<double>(*ptr);
    }
    if (const auto* ptr = std::get_if<uint32_t>(&value)) {
      return static_cast<double>(*ptr);
    }
    if (const auto* ptr = std::get_if<int32_t>(&value)) {
      return static_cast<double>(*ptr);
    }
  }
  return fallback;
}

std::vector<char*> argvPointers(std::vector<std::string>& argv) {
  std::vector<char*> pointers;
  pointers.reserve(argv.size() + 1);
  for (auto& arg : argv) {
    pointers.push_back(const_cast<char*>(arg.c_str()));
  }
  pointers.push_back(nullptr);
  return pointers;
}

/** Directory that contains libNuvioMediaProxy.so and the bundled tools. */
std::string moduleDirectory() {
  Dl_info info{};
  if (dladdr(reinterpret_cast<void*>(&moduleDirectory), &info) != 0 &&
      info.dli_fname != nullptr) {
    const std::string path = info.dli_fname;
    const auto slash = path.find_last_of('/');
    if (slash != std::string::npos) {
      return path.substr(0, slash);
    }
  }
  std::ifstream maps("/proc/self/maps");
  std::string line;
  while (std::getline(maps, line)) {
    const auto at = line.find("libNuvioMediaProxy.so");
    if (at == std::string::npos) {
      continue;
    }
    const auto space = line.find_first_of(" \t", at);
    if (space != std::string::npos) {
      const std::string path = line.substr(at, space - at);
      const auto slash = path.find_last_of('/');
      if (slash != std::string::npos) {
        return path.substr(0, slash);
      }
    }
  }
  return std::string("/pkg/lib/armv7");
}

std::string bundledPath(const char* name) {
  return moduleDirectory() + "/" + name;
}

std::vector<std::string> sanitizedEnvironment(const std::string& libraries) {
  std::vector<std::string> environment;
  bool hasPath = false;
  for (char** entry = environ; entry != nullptr && *entry != nullptr; ++entry) {
    const std::string item = *entry;
    if (item.rfind("LD_LIBRARY_PATH=", 0) == 0 ||
        item.rfind("LD_PRELOAD=", 0) == 0 ||
        item.rfind("LD_AUDIT=", 0) == 0) {
      continue;
    }
    if (item.rfind("PATH=", 0) == 0) {
      hasPath = true;
      environment.push_back("PATH=/usr/bin:/bin");
    } else {
      environment.push_back(item);
    }
  }
  if (!hasPath) {
    environment.push_back("PATH=/usr/bin:/bin");
  }
  // Bundled libraries take precedence; the trailing system directories only
  // provide the C runtime (libc/libm), which every ELF binary needs.
  environment.push_back("LD_LIBRARY_PATH=" + libraries + ":/lib:/usr/lib");
  return environment;
}

/**
 * Launches the bundled ffmpeg through the bundled dynamic loader. Kepler runs
 * the app with AT_SECURE, where LD_LIBRARY_PATH is ignored for children, so an
 * explicit --library-path is required to keep the app's libav* out of the way.
 */
void execChild(const std::vector<std::string>& argv) {
  const std::string libraries = moduleDirectory();
  std::vector<std::string> command;

  const std::string loader = bundledPath(LOADER_BINARY);
  if (access(loader.c_str(), X_OK) == 0) {
    command.push_back(loader);
    command.push_back("--library-path");
    command.push_back(libraries + ":/lib:/usr/lib");
  }
  command.insert(command.end(), argv.begin(), argv.end());

  auto pointers = argvPointers(command);
  auto environment = sanitizedEnvironment(libraries);
  std::vector<char*> environmentPointers;
  environmentPointers.reserve(environment.size() + 1);
  for (auto& item : environment) {
    environmentPointers.push_back(const_cast<char*>(item.c_str()));
  }
  environmentPointers.push_back(nullptr);

  execve(pointers[0], pointers.data(), environmentPointers.data());
  const std::string message =
      std::string("execve failed for ") + argv[0] + ": " + strerror(errno) + "\n";
  write(STDERR_FILENO, message.data(), message.size());
  _exit(127);
}

/** Runs a short-lived bundled child and captures both output streams. */
int runCapture(
    const std::vector<std::string>& argv,
    std::string& output,
    std::string& errorOutput,
    size_t maxBytes) {
  int outPipe[2] = {-1, -1};
  int errPipe[2] = {-1, -1};
  if (pipe(outPipe) != 0) {
    return -1;
  }
  if (pipe(errPipe) != 0) {
    close(outPipe[0]);
    close(outPipe[1]);
    return -1;
  }

  const pid_t pid = fork();
  if (pid < 0) {
    close(outPipe[0]);
    close(outPipe[1]);
    close(errPipe[0]);
    close(errPipe[1]);
    return -1;
  }
  if (pid == 0) {
    close(outPipe[0]);
    close(errPipe[0]);
    dup2(outPipe[1], STDOUT_FILENO);
    dup2(errPipe[1], STDERR_FILENO);
    close(outPipe[1]);
    close(errPipe[1]);
    int devNull = open("/dev/null", O_RDONLY);
    if (devNull >= 0) {
      dup2(devNull, STDIN_FILENO);
      close(devNull);
    }
    execChild(argv);
  }

  close(outPipe[1]);
  close(errPipe[1]);
  struct pollfd fds[2] = {
      {outPipe[0], POLLIN, 0},
      {errPipe[0], POLLIN, 0},
  };
  char buffer[4096];
  while (fds[0].fd >= 0 || fds[1].fd >= 0) {
    const int ready = poll(fds, 2, -1);
    if (ready < 0) {
      if (errno == EINTR) {
        continue;
      }
      break;
    }
    for (size_t index = 0; index < 2; ++index) {
      if (fds[index].fd < 0 ||
          (fds[index].revents & (POLLIN | POLLHUP | POLLERR)) == 0) {
        continue;
      }
      const ssize_t count = read(fds[index].fd, buffer, sizeof(buffer));
      if (count > 0) {
        std::string& sink = index == 0 ? output : errorOutput;
        if (sink.size() < maxBytes) {
          sink.append(buffer,
                      std::min<size_t>(static_cast<size_t>(count), maxBytes - sink.size()));
        }
      } else if (count == 0 || errno != EINTR) {
        close(fds[index].fd);
        fds[index].fd = -1;
      }
    }
  }

  int status = 0;
  while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
  }
  return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

std::string normalizeHeaderBlock(const std::string& headers) {
  std::string normalized;
  normalized.reserve(headers.size());
  for (size_t index = 0; index < headers.size(); ++index) {
    if (headers[index] == '\r' && index + 1 < headers.size() &&
        headers[index + 1] == '\n') {
      normalized.push_back('\n');
      ++index;
    } else {
      normalized.push_back(headers[index]);
    }
  }
  return normalized;
}

std::string trim(const std::string& input) {
  size_t begin = 0;
  while (begin < input.size() &&
         std::isspace(static_cast<unsigned char>(input[begin]))) {
    ++begin;
  }
  size_t end = input.size();
  while (end > begin &&
         std::isspace(static_cast<unsigned char>(input[end - 1]))) {
    --end;
  }
  return input.substr(begin, end - begin);
}

std::string toLowerCopy(const std::string& input) {
  std::string result = input;
  std::transform(result.begin(), result.end(), result.begin(), [](unsigned char c) {
    return static_cast<char>(std::tolower(c));
  });
  return result;
}

std::string safeSessionId(const std::string& input) {
  std::string result;
  for (const char item : input) {
    result.push_back(std::isalnum(static_cast<unsigned char>(item)) ? item : '_');
  }
  return result.empty() ? std::string("session") : result;
}

struct AudioTrackMetadata {
  int index = 0;
  std::string language;
  std::string title;
  std::string sourceCodec;
  std::string sourceChannels;
  int sampleRate = 0;
  bool isDefault = false;
};

std::string jsonEscape(const std::string& value) {
  std::string result;
  for (const unsigned char c : value) {
    switch (c) {
      case '"': result += "\\\""; break;
      case '\\': result += "\\\\"; break;
      case '\n': result += "\\n"; break;
      case '\r': result += "\\r"; break;
      case '\t': result += "\\t"; break;
      default:
        if (c < 0x20) {
          char buffer[7];
          std::snprintf(buffer, sizeof(buffer), "\\u%04x", c);
          result += buffer;
        } else {
          result.push_back(static_cast<char>(c));
        }
    }
  }
  return result;
}

/**
 * ffmpeg lists every input stream before it writes a single frame. Reading that
 * list lets the web UI show the real language/title of each audio track even
 * when the native player only exposes anonymous AudioTrack objects.
 */
std::vector<AudioTrackMetadata> parseAudioTracks(const std::string& log) {
  std::vector<AudioTrackMetadata> tracks;
  std::vector<std::string> lines;
  std::istringstream split(log);
  std::string raw;
  while (std::getline(split, raw)) {
    lines.push_back(trim(raw));
  }

  int ordinal = 0;
  for (size_t i = 0; i < lines.size(); ++i) {
    const std::string& line = lines[i];
    if (line.find("Stream mapping:") != std::string::npos) {
      break;
    }
    const size_t marker = line.find("Stream #");
    const size_t audio = line.find(": Audio:");
    if (marker == std::string::npos || audio == std::string::npos || audio < marker) {
      continue;
    }

    AudioTrackMetadata track;
    track.index = ordinal++;
    track.isDefault = line.find("(default)") != std::string::npos;

    const std::string prefix = line.substr(marker + 8, audio - marker - 8);
    const size_t lastColon = prefix.find_last_of(':');
    const std::string spec =
        lastColon == std::string::npos ? prefix : prefix.substr(lastColon + 1);
    const size_t open = spec.find('(');
    if (open != std::string::npos) {
      const size_t close = spec.find(')', open + 1);
      if (close != std::string::npos) {
        track.language = trim(spec.substr(open + 1, close - open - 1));
      }
    }

    const size_t detailsStart = audio + 8;
    size_t detailsEnd = line.find(',', detailsStart);
    if (detailsEnd == std::string::npos) {
      detailsEnd = line.size();
    }
    track.sourceCodec = trim(line.substr(detailsStart, detailsEnd - detailsStart));
    const std::string details = line.substr(detailsStart);

    const size_t hz = details.find(" Hz");
    if (hz != std::string::npos) {
      size_t digitsStart = hz;
      while (digitsStart > 0 && std::isdigit(static_cast<unsigned char>(details[digitsStart - 1]))) {
        --digitsStart;
      }
      track.sampleRate = std::atoi(details.substr(digitsStart, hz - digitsStart).c_str());
      const size_t channelsStart = details.find(", ", hz);
      if (channelsStart != std::string::npos) {
        const size_t channelsEnd = details.find(',', channelsStart + 2);
        const size_t length =
            channelsEnd == std::string::npos ? std::string::npos : channelsEnd - channelsStart - 2;
        track.sourceChannels = trim(details.substr(channelsStart + 2, length));
      }
    }

    for (size_t j = i + 1; j < lines.size(); ++j) {
      const std::string& metaLine = lines[j];
      if (metaLine.find("Stream #") != std::string::npos ||
          metaLine.find("Stream mapping:") != std::string::npos) {
        break;
      }
      const size_t separator = metaLine.find(':');
      if (separator == std::string::npos) {
        continue;
      }
      const std::string key = toLowerCopy(trim(metaLine.substr(0, separator)));
      const std::string value = trim(metaLine.substr(separator + 1));
      if (key == "title" && !value.empty()) {
        track.title = value;
      } else if (key == "language" && !value.empty()) {
        track.language = value;
      }
    }
    tracks.push_back(track);
  }
  return tracks;
}

std::string audioTracksToJson(const std::vector<AudioTrackMetadata>& tracks) {
  std::ostringstream out;
  out << '[';
  for (size_t i = 0; i < tracks.size(); ++i) {
    const AudioTrackMetadata& track = tracks[i];
    if (i > 0) {
      out << ',';
    }
    out << "{\"index\":" << track.index
        << ",\"language\":\"" << jsonEscape(track.language) << '"'
        << ",\"title\":\"" << jsonEscape(track.title) << '"'
        << ",\"sourceCodec\":\"" << jsonEscape(track.sourceCodec) << '"'
        << ",\"sourceChannels\":\"" << jsonEscape(track.sourceChannels) << '"'
        << ",\"sampleRate\":" << track.sampleRate
        << ",\"default\":" << (track.isDefault ? "true" : "false")
        << '}';
  }
  out << ']';
  return out.str();
}

long long fileSize(const std::string& path) {
  struct stat info {};
  if (stat(path.c_str(), &info) != 0) {
    return -1;
  }
  return static_cast<long long>(info.st_size);
}

std::string readTail(const std::string& path, size_t maxBytes) {
  std::ifstream input(path, std::ios::binary);
  if (!input) {
    return std::string();
  }
  input.seekg(0, std::ios::end);
  const std::streamoff size = input.tellg();
  const size_t length = size > 0 ? static_cast<size_t>(size) : 0;
  const size_t start = length > maxBytes ? length - maxBytes : 0;
  input.seekg(static_cast<std::streamoff>(start), std::ios::beg);
  std::string text(length - start, '\0');
  if (!text.empty()) {
    input.read(&text[0], static_cast<std::streamsize>(text.size()));
  }
  return text;
}

std::string ffmpegFailure(const std::shared_ptr<ProxySession>& session, int exitCode) {
  const std::string log = trim(readTail(session->logPath, LOG_TAIL_BYTES));
  std::string reason = "ffmpeg exited with code " + std::to_string(exitCode);

  std::vector<std::string> lines;
  std::istringstream stream(log);
  std::string line;
  while (std::getline(stream, line)) {
    const std::string text = trim(line);
    if (!text.empty()) {
      lines.push_back(text);
    }
  }

  const auto isGeneric = [](const std::string& text) {
    const std::string lower = toLowerCopy(text);
    return lower.find("conversion failed") != std::string::npos ||
           lower.find("error occurred when decoding") != std::string::npos;
  };
  const auto isDiagnostic = [](const std::string& text) {
    const std::string lower = toLowerCopy(text);
    static const char* const markers[] = {
        "error", "failed", "invalid", "denied", "forbidden", "not found",
        "no such file", "unsupported", "cannot", "could not", "timed out",
        "timeout", "connection", "server returned", "bad request",
        "permission", "no space", "broken pipe", "unable", "refused",
        "reset by peer", "404", "403", "500"};
    for (const char* marker : markers) {
      if (lower.find(marker) != std::string::npos) {
        return true;
      }
    }
    return false;
  };

  std::string detail;
  for (auto it = lines.rbegin(); it != lines.rend(); ++it) {
    if (!isGeneric(*it) && isDiagnostic(*it)) {
      detail = *it;
      break;
    }
  }
  if (detail.empty()) {
    for (auto it = lines.rbegin(); it != lines.rend(); ++it) {
      if (!isGeneric(*it)) {
        detail = *it;
        break;
      }
    }
  }
  if (!detail.empty()) {
    if (detail.size() > 400) {
      detail = detail.substr(detail.size() - 400);
    }
    reason += ": " + detail;
  } else {
    reason += " (no stderr detail captured)";
  }
  return reason;
}

void monitorProcess(const std::shared_ptr<ProxySession>& session) {
  int status = 0;
  pid_t result = -1;
  do {
    result = waitpid(session->ffmpegPid, &status, 0);
  } while (result < 0 && errno == EINTR);

  const int exitCode = result > 0 && WIFEXITED(status) ? WEXITSTATUS(status) : -1;
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    session->ffmpegDone = true;
    session->ffmpegExitCode = exitCode;
    if (exitCode != 0 && session->error.empty()) {
      session->error = ffmpegFailure(session, exitCode);
    }
  }
  session->cv.notify_all();
}

/**
 * Builds the remux command. There is deliberately no codec allow-list: every
 * audio stream is normalized to Opus, a format the Vega pipeline decodes in
 * software, so playback never depends on guessing what the player supports.
 * Video and subtitles are copied without re-encoding.
 */
std::vector<std::string> buildCommand(const std::shared_ptr<ProxySession>& session) {
  const std::string binary = bundledPath(FFMPEG_BINARY);
  // Info level is needed once: ffmpeg prints the input stream languages/titles
  // before remuxing. -nostats keeps that diagnostic log free of progress spam.
  std::vector<std::string> argv = {
      binary, "-hide_banner", "-loglevel", "info", "-nostats", "-nostdin", "-y"};
  if (!session->headers.empty()) {
    argv.push_back("-headers");
    argv.push_back(session->headers);
  }
  if (session->startTimeSec > 0) {
    std::ostringstream startText;
    startText << std::fixed << session->startTimeSec;
    argv.push_back("-ss");
    argv.push_back(startText.str());
  }
  argv.push_back("-i");
  argv.push_back(session->url);
  argv.push_back("-map");
  argv.push_back("0:v:0");
  argv.push_back("-map");
  argv.push_back("0:a?");
  argv.push_back("-map");
  argv.push_back("0:s?");
  argv.push_back("-c:v");
  argv.push_back("copy");
  argv.push_back("-c:a");
  argv.push_back("libopus");
  argv.push_back("-b:a");
  argv.push_back("128k");
  argv.push_back("-ac");
  argv.push_back("2");
  argv.push_back("-c:s");
  argv.push_back("copy");
  // Mark the requested track as the default in the Matroska header. The native
  // player honours FlagDefault even when its runtime enable/disable API is
  // unreliable, so an audio switch survives the remux for every source.
  if (session->audioTrackIndex >= 0 && session->audioTrackIndex < session->audioTrackCount) {
    for (int i = 0; i < session->audioTrackCount; ++i) {
      std::ostringstream specifier;
      specifier << "-disposition:a:" << i;
      argv.push_back(specifier.str());
      argv.push_back(i == session->audioTrackIndex ? "default" : "0");
    }
  }
  // A SeekHead/Cues index would point at the end of a still-growing file; the
  // native demuxer would request those ranges before preroll and give up.
  argv.push_back("-write_index");
  argv.push_back("0");
  argv.push_back("-f");
  argv.push_back("matroska");
  argv.push_back("pipe:1");
  return argv;
}

/** Waits until a readable MKV prefix exists or the remux has stopped. */
bool waitForPreroll(const std::shared_ptr<ProxySession>& session) {
  const auto deadline = std::chrono::steady_clock::now() + PREROLL_DEADLINE;
  while (std::chrono::steady_clock::now() < deadline) {
    const long long size = fileSize(session->cachePath);
    if (size >= MIN_PREROLL_BYTES) {
      return true;
    }
    bool stopped = false;
    bool done = false;
    {
      std::lock_guard<std::mutex> lock(session->mutex);
      stopped = session->stopping;
      done = session->ffmpegDone;
    }
    if (stopped || done) {
      return false;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(25));
  }
  return false;
}

void stopSession(const std::shared_ptr<ProxySession>& session) {
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    session->stopping = true;
  }
  session->cv.notify_all();
  if (session->ffmpegPid > 0) {
    kill(session->ffmpegPid, SIGTERM);
  }
  if (session->monitorThread.joinable()) {
    session->monitorThread.join();
  }
}

} // namespace

NuvioMediaProxy::NuvioMediaProxy() {
  // Verifies that the packaged binary resolves only the packaged libav* build.
  std::string output;
  std::string errorOutput;
  const int code = runCapture({bundledPath(FFMPEG_BINARY), "-version"}, output,
                              errorOutput, 8192);
  std::ofstream report(SELF_TEST_PATH, std::ios::trunc);
  report << "code=" << code << "\n"
         << "binary=" << bundledPath(FFMPEG_BINARY) << "\n"
         << "error=" << trim(errorOutput).substr(0, 2048) << "\n";
}

NuvioMediaProxy::~NuvioMediaProxy() noexcept {
  std::vector<std::string> ids;
  {
    std::lock_guard<std::mutex> lock(gSessionsMutex);
    for (const auto& entry : gSessions) {
      ids.push_back(entry.first);
    }
  }
  for (const auto& id : ids) {
    stopProxy(id);
  }
}

JSObject NuvioMediaProxy::startProxy(JSObject config) {
  const std::string sessionId = valueOr<std::string>(config, "sessionId", "");
  const std::string url = valueOr<std::string>(config, "url", "");
  const std::string headers = normalizeHeaderBlock(valueOr<std::string>(config, "headers", ""));
  const double startTimeSec = valueOr<double>(config, "startTimeSec", 0);
  const double audioTrack = valueOr<double>(config, "audioTrackIndex", -1);
  const double audioTracks = valueOr<double>(config, "audioTrackCount", 0);

  JSObject result;
  result["localUrl"] = std::string("");
  result["cachePath"] = std::string("");
  result["logPath"] = std::string("");
  if (sessionId.empty() || url.empty()) {
    result["error"] = std::string("Missing sessionId or url");
    return result;
  }

  {
    std::lock_guard<std::mutex> lock(gSessionsMutex);
    const auto existing = gSessions.find(sessionId);
    if (existing != gSessions.end()) {
      result["localUrl"] = existing->second->localUrl;
      result["cachePath"] = existing->second->cachePath;
      result["logPath"] = existing->second->logPath;
      return result;
    }
  }

  const std::string binary = bundledPath(FFMPEG_BINARY);
  if (access(binary.c_str(), X_OK) != 0) {
    result["error"] = "Bundled ffmpeg is missing or not executable: " + binary;
    return result;
  }

  auto session = std::make_shared<ProxySession>();
  session->id = sessionId;
  session->url = url;
  session->headers = headers;
  session->startTimeSec = std::max<double>(0, startTimeSec);
  session->audioTrackIndex = audioTrack >= 0 ? static_cast<int>(audioTrack) : -1;
  session->audioTrackCount = audioTracks > 0 ? static_cast<int>(audioTracks) : 0;
  const std::string idPart = safeSessionId(sessionId);
  session->cachePath = "/tmp/nuvio-proxy-" + idPart + ".mkv";
  session->logPath = "/tmp/nuvio-proxy-" + idPart + ".log";
  unlink(session->cachePath.c_str());
  unlink(session->logPath.c_str());

  const std::vector<std::string> argv = buildCommand(session);
  const pid_t pid = fork();
  if (pid < 0) {
    result["error"] = "Unable to start bundled ffmpeg: " + std::string(strerror(errno));
    return result;
  }
  if (pid == 0) {
    int input = open("/dev/null", O_RDONLY);
    if (input >= 0) {
      dup2(input, STDIN_FILENO);
      close(input);
    }
    int output =
        open(session->cachePath.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (output >= 0) {
      dup2(output, STDOUT_FILENO);
      close(output);
    }
    int log = open(session->logPath.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (log >= 0) {
      dup2(log, STDERR_FILENO);
      close(log);
    }
    execChild(argv);
  }

  session->ffmpegPid = pid;
  session->monitorThread = std::thread(monitorProcess, session);

  if (!waitForPreroll(session)) {
    std::string error;
    {
      std::lock_guard<std::mutex> lock(session->mutex);
      error = session->ffmpegExitCode == 0
          ? std::string("ffmpeg produced no playable data within 4 seconds")
          : ffmpegFailure(session, session->ffmpegExitCode);
    }
    stopSession(session);
    {
      // stopSession may terminate ffmpeg; keep the original, precise reason.
      std::lock_guard<std::mutex> lock(session->mutex);
      session->error = error;
    }
    unlink(session->cachePath.c_str());
    result["error"] = error;
    return result;
  }

  {
    std::lock_guard<std::mutex> lock(session->mutex);
    session->audioTracksJson =
        audioTracksToJson(parseAudioTracks(readTail(session->logPath, LOG_TAIL_BYTES)));
    session->ready = true;
    session->localUrl = "file://" + session->cachePath;
  }
  {
    std::lock_guard<std::mutex> lock(gSessionsMutex);
    gSessions[sessionId] = session;
  }

  result["localUrl"] = session->localUrl;
  result["cachePath"] = session->cachePath;
  result["logPath"] = session->logPath;
  result["audioTracks"] = session->audioTracksJson;
  return result;
}

bool NuvioMediaProxy::stopProxy(std::string sessionId) {
  std::shared_ptr<ProxySession> session;
  {
    std::lock_guard<std::mutex> lock(gSessionsMutex);
    const auto it = gSessions.find(sessionId);
    if (it == gSessions.end()) {
      return false;
    }
    session = it->second;
    gSessions.erase(it);
  }
  stopSession(session);
  unlink(session->cachePath.c_str());
  unlink(session->logPath.c_str());
  return true;
}

JSObject NuvioMediaProxy::proxyStatus(std::string sessionId) {
  JSObject result;
  result["state"] = std::string("missing");
  result["bytesWritten"] = 0.0;
  result["exitCode"] = 0.0;
  result["error"] = std::string("");
  result["log"] = std::string("");
  result["audioTracks"] = std::string("[]");
  {
    std::ifstream report(SELF_TEST_PATH);
    if (report) {
      result["selfTest"] = std::string{std::istreambuf_iterator<char>(report),
                                       std::istreambuf_iterator<char>()};
    } else {
      result["selfTest"] = std::string("missing");
    }
  }
  std::shared_ptr<ProxySession> session;
  {
    std::lock_guard<std::mutex> lock(gSessionsMutex);
    const auto it = gSessions.find(sessionId);
    if (it == gSessions.end()) {
      return result;
    }
    session = it->second;
  }
  std::lock_guard<std::mutex> lock(session->mutex);
  result["state"] = session->ffmpegDone ? std::string("complete") : std::string("streaming");
  result["bytesWritten"] = static_cast<double>(std::max<long long>(fileSize(session->cachePath), 0));
  result["exitCode"] = static_cast<double>(session->ffmpegExitCode);
  result["log"] = trim(readTail(session->logPath, LOG_TAIL_BYTES));
  result["audioTracks"] = session->audioTracksJson;
  // Rebuild the message when the monitor observed the exit before ffmpeg had
  // flushed its last diagnostic line, so errors always carry the real reason.
  if (session->ffmpegDone && session->ffmpegExitCode != 0 && session->error.empty()) {
    result["error"] = ffmpegFailure(session, session->ffmpegExitCode);
  } else {
    result["error"] = session->error;
  }
  return result;
}

std::string NuvioMediaProxy::readProxyLog(std::string sessionId) {
  std::shared_ptr<ProxySession> session;
  {
    std::lock_guard<std::mutex> lock(gSessionsMutex);
    const auto it = gSessions.find(sessionId);
    if (it == gSessions.end()) {
      return std::string();
    }
    session = it->second;
  }
  return readTail(session->logPath, LOG_TAIL_BYTES);
}

} // namespace nuviomediaproxyTurboModule
