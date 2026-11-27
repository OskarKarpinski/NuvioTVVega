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

/** A playback file smaller than this is not safe to hand to the native demuxer. */
constexpr long long MIN_PLAYBACK_BYTES = 128LL * 1024;
constexpr long long LOG_TAIL_BYTES = 8 * 1024;

struct ProxySession {
  std::string id;
  std::string url;
  std::string headers;
  /** Stage 2 output: the only path ever given to the native player. */
  std::string cachePath;
  std::string logPath;
  std::string localUrl;

  /** Stage 1: one complete, seekable master MKV downloaded from the URL. */
  std::string masterPath;
  std::string masterTmpPath;
  std::string masterLogPath;
  bool masterComplete = false;
  bool masterDone = false;
  int masterExitCode = 0;
  pid_t masterPid = -1;
  std::thread masterMonitorThread;
  size_t masterLogOffset = 0;

  /** Stage 2: local-only remux of the master into a complete playback file. */
  std::string playbackTmpPath;
  std::string playbackLogPath;
  bool playbackReady = false;
  bool playbackAttempted = false;
  bool playbackDone = false;
  int playbackExitCode = 0;
  int playbackGeneration = 0;
  int playbackInFlightGeneration = 0;
  int playbackRequestedGeneration = 0;
  std::string playbackDiagnostic;
  pid_t playbackPid = -1;
  std::thread playbackMonitorThread;
  size_t playbackLogOffset = 0;

  double startTimeSec = 0;
  int audioTrackIndex = -1;
  int audioTrackCount = 0;
  int discoveredAudioCount = 0;
  bool stopping = false;
  std::string error;
  /** JSON array of audio streams discovered from the master's stream list. */
  std::string audioTracksJson = "[]";
  std::vector<std::string> tempFiles;

  std::mutex mutex;
  /** Serializes process teardown/launch; never held while joining a thread. */
  std::mutex transitionMutex;
  std::condition_variable cv;
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

std::string ffmpegFailure(const std::string& logPath, int exitCode) {
  const std::string log = trim(readTail(logPath, LOG_TAIL_BYTES));
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

std::string readSelfTest() {
  std::ifstream report(SELF_TEST_PATH);
  if (!report) {
    return std::string("missing");
  }
  return std::string{std::istreambuf_iterator<char>(report),
                     std::istreambuf_iterator<char>()};
}

void appendBytesToFile(const std::string& path, const std::string& data) {
  if (data.empty()) {
    return;
  }
  const int fd = open(path.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
  if (fd < 0) {
    return;
  }
  size_t written = 0;
  while (written < data.size()) {
    const ssize_t count =
        write(fd, data.data() + written, data.size() - written);
    if (count > 0) {
      written += static_cast<size_t>(count);
    } else if (count < 0 && errno == EINTR) {
      continue;
    } else {
      break;
    }
  }
  close(fd);
}

/** Mirrors newly written stage logs into the single logPath exposed to JS. */
void appendLogUpdatesLocked(const std::shared_ptr<ProxySession>& session) {
  const auto append = [&](const std::string& path, size_t& offset) {
    const long long size = fileSize(path);
    if (size < 0) {
      return;
    }
    if (static_cast<long long>(offset) > size) {
      offset = 0;
    }
    if (size <= static_cast<long long>(offset)) {
      return;
    }
    std::ifstream input(path, std::ios::binary);
    if (!input) {
      return;
    }
    input.seekg(static_cast<std::streamoff>(offset), std::ios::beg);
    std::string chunk(static_cast<size_t>(size) - offset, '\0');
    input.read(&chunk[0], static_cast<std::streamsize>(chunk.size()));
    chunk.resize(static_cast<size_t>(input.gcount()));
    if (!chunk.empty()) {
      appendBytesToFile(session->logPath, chunk);
    }
    offset = static_cast<size_t>(size);
  };
  append(session->masterLogPath, session->masterLogOffset);
  append(session->playbackLogPath, session->playbackLogOffset);
}

/** Combined tail: stage 1 diagnostics first, then the newest stage 2 output. */
std::string combinedLogTailLocked(const std::shared_ptr<ProxySession>& session) {
  appendLogUpdatesLocked(session);
  const std::string master = trim(readTail(session->masterLogPath, LOG_TAIL_BYTES / 2));
  const std::string playback = trim(readTail(session->playbackLogPath, LOG_TAIL_BYTES / 2));
  if (master.empty()) {
    return playback;
  }
  if (playback.empty()) {
    return master;
  }
  return "master: " + master + "\nplayback: " + playback;
}

std::string currentPhaseLocked(const std::shared_ptr<ProxySession>& session) {
  if (!session->error.empty()) {
    return "error";
  }
  if (session->playbackAttempted && !session->playbackDone) {
    return "remuxing";
  }
  if (session->playbackReady) {
    return "ready";
  }
  return "preparing";
}

/** Builds every field shared by startProxy, preparePlayback and proxyStatus. */
JSObject statusLocked(const std::shared_ptr<ProxySession>& session) {
  JSObject result;
  const std::string phase = currentPhaseLocked(session);
  result["localUrl"] = session->localUrl;
  result["cachePath"] = session->cachePath;
  result["logPath"] = session->logPath;
  result["state"] = phase;
  result["phase"] = phase;
  result["bytesWritten"] =
      static_cast<double>(session->playbackReady
                              ? std::max<long long>(fileSize(session->cachePath), 0)
                              : 0);
  result["masterBytes"] = static_cast<double>(std::max<long long>(
      std::max(fileSize(session->masterPath), fileSize(session->masterTmpPath)), 0));
  result["masterComplete"] = static_cast<double>(session->masterComplete ? 1 : 0);
  result["masterExitCode"] = static_cast<double>(session->masterExitCode);
  result["playbackExitCode"] = static_cast<double>(session->playbackExitCode);
  // The last attempted stage is the meaningful one for callers.
  result["exitCode"] = static_cast<double>(
      session->playbackAttempted ? session->playbackExitCode : session->masterExitCode);
  result["error"] = session->error;
  result["log"] = combinedLogTailLocked(session);
  result["audioTracks"] = session->audioTracksJson;
  result["selfTest"] = readSelfTest();
  result["playbackGeneration"] = static_cast<double>(session->playbackGeneration);
  result["playbackInFlightGeneration"] =
      static_cast<double>(session->playbackInFlightGeneration);
  result["playbackDone"] = static_cast<double>(session->playbackDone ? 1 : 0);
  result["playbackReady"] = static_cast<double>(session->playbackReady ? 1 : 0);
  result["playbackDiagnostic"] = session->playbackDiagnostic;
  return result;
}

JSObject statusObject(const std::shared_ptr<ProxySession>& session) {
  std::lock_guard<std::mutex> lock(session->mutex);
  return statusLocked(session);
}

JSObject baseResult(const std::string& state) {
  JSObject result;
  result["localUrl"] = std::string("");
  result["cachePath"] = std::string("");
  result["logPath"] = std::string("");
  result["state"] = state;
  result["phase"] = state;
  result["bytesWritten"] = 0.0;
  result["masterBytes"] = 0.0;
  result["masterComplete"] = 0.0;
  result["masterExitCode"] = 0.0;
  result["playbackExitCode"] = 0.0;
  result["exitCode"] = 0.0;
  result["error"] = std::string("");
  result["log"] = std::string("");
  result["audioTracks"] = std::string("[]");
  result["selfTest"] = readSelfTest();
  result["playbackGeneration"] = 0.0;
  result["playbackInFlightGeneration"] = 0.0;
  result["playbackDone"] = 0.0;
  result["playbackReady"] = 0.0;
  result["playbackDiagnostic"] = std::string("");
  return result;
}

JSObject errorResult(const std::string& message) {
  JSObject result = baseResult("error");
  result["error"] = message;
  return result;
}

/**
 * Launches one bundled ffmpeg stage. The output file is created by us before
 * exec so a crash cannot leave a partial file at a path the player will read.
 */
pid_t launchStage(const std::vector<std::string>& argv,
                  const std::string& stdoutPath,
                  const std::string& stderrPath) {
  const pid_t pid = fork();
  if (pid < 0) {
    return -1;
  }
  if (pid == 0) {
    int input = open("/dev/null", O_RDONLY);
    if (input >= 0) {
      dup2(input, STDIN_FILENO);
      close(input);
    }
    int output = open(stdoutPath.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (output >= 0) {
      dup2(output, STDOUT_FILENO);
      close(output);
    }
    int log = open(stderrPath.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (log >= 0) {
      dup2(log, STDERR_FILENO);
      close(log);
    }
    execChild(argv);
  }
  return pid;
}

/**
 * Stage 1 downloads and normalizes the remote source exactly once. There is no
 * -ss and no HTTP range seeking: ffmpeg must produce a complete, seekable MKV
 * before stage 2 is allowed to touch it.
 */
std::vector<std::string> buildMasterCommand(const std::shared_ptr<ProxySession>& session) {
  // Info level is needed once: ffmpeg prints the input stream languages/titles
  // before remuxing. -nostats keeps that diagnostic log free of progress spam.
  std::vector<std::string> argv = {
      bundledPath(FFMPEG_BINARY), "-hide_banner", "-loglevel", "info",
      "-nostats", "-nostdin", "-y"};
  if (!session->headers.empty()) {
    argv.push_back("-headers");
    argv.push_back(session->headers);
  }
  argv.push_back("-i");
  argv.push_back(session->url);
  argv.push_back("-map");
  argv.push_back("0:v:0");
  argv.push_back("-map");
  argv.push_back("0:a?");
  argv.push_back("-map");
  argv.push_back("0:s?");
  // Every audio stream becomes Opus, a format Vega decodes in software, so
  // playback never depends on guessing what the platform supports.
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
  argv.push_back("-f");
  argv.push_back("matroska");
  argv.push_back(session->masterTmpPath);
  return argv;
}

/**
 * Stage 2 only reads the completed local master. -ss before -i lets ffmpeg seek
 * in that local file, and the dispositions leave exactly one default audio
 * track so Vega does not reconfigure its pipeline in a loop.
 */
std::vector<std::string> buildPlaybackCommand(const std::shared_ptr<ProxySession>& session,
                                              double startTimeSec,
                                              int audioTrackIndex,
                                              int audioTrackCount,
                                              const std::string& outputPath) {
  std::vector<std::string> argv = {
      bundledPath(FFMPEG_BINARY), "-hide_banner", "-loglevel", "info",
      "-nostats", "-nostdin", "-y"};
  std::ostringstream startText;
  startText << std::fixed << std::max<double>(0, startTimeSec);
  argv.push_back("-ss");
  argv.push_back(startText.str());
  argv.push_back("-i");
  argv.push_back(session->masterPath);
  argv.push_back("-map");
  argv.push_back("0:v:0");
  argv.push_back("-map");
  argv.push_back("0:a?");
  argv.push_back("-map");
  argv.push_back("0:s?");
  argv.push_back("-c");
  argv.push_back("copy");
  // The master's own stream list wins over the caller's hint when present.
  const int effectiveCount = session->discoveredAudioCount > 0
                                 ? session->discoveredAudioCount
                                 : audioTrackCount;
  if (effectiveCount > 0) {
    int selected = 0;
    if (audioTrackIndex >= 0) {
      selected = std::min(audioTrackIndex, effectiveCount - 1);
    }
    argv.push_back("-disposition:a");
    argv.push_back("0");
    std::ostringstream defaultSpecifier;
    defaultSpecifier << "-disposition:a:" << selected;
    argv.push_back(defaultSpecifier.str());
    argv.push_back("default");
  }
  argv.push_back("-f");
  argv.push_back("matroska");
  argv.push_back(outputPath);
  return argv;
}

void monitorProcess(const std::shared_ptr<ProxySession>& session,
                    pid_t pid,
                    bool masterStage,
                    int generation);

void stopPlaybackProcess(const std::shared_ptr<ProxySession>& session) {
  pid_t pid = -1;
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    pid = session->playbackPid;
    session->playbackPid = -1;
  }
  if (pid > 0 && pid != getpid()) {
    kill(pid, SIGTERM);
  }
  if (session->playbackMonitorThread.joinable() &&
      session->playbackMonitorThread.get_id() != std::this_thread::get_id()) {
    session->playbackMonitorThread.join();
  }
}

/** Starts (or restarts) the local-only stage 2, never touching the network. */
bool beginPlayback(const std::shared_ptr<ProxySession>& session,
                   double startTimeSec,
                   int audioTrackIndex,
                   int audioTrackCount,
                   int generation) {
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    if (session->stopping || !session->masterComplete || !session->error.empty() ||
        generation < session->playbackRequestedGeneration) {
      return false;
    }
    session->playbackRequestedGeneration = generation;
  }

  std::lock_guard<std::mutex> transition(session->transitionMutex);
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    if (session->stopping || !session->masterComplete) {
      return false;
    }
  }
  // A previous remux must be gone before its output path can be replaced.
  stopPlaybackProcess(session);

  const std::string idPart = safeSessionId(session->id);
  const std::string tmpPath = "/tmp/nuvio-proxy-" + idPart +
                              "-playback-" + std::to_string(generation) + ".tmp.mkv";
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    if (session->stopping) {
      return false;
    }
    unlink(tmpPath.c_str());
    session->playbackTmpPath = tmpPath;
    session->tempFiles.push_back(tmpPath);
    session->playbackInFlightGeneration = generation;
    session->playbackAttempted = true;
    session->playbackDone = false;
    session->playbackExitCode = 0;
    session->playbackDiagnostic.clear();
  }

  const std::vector<std::string> argv = buildPlaybackCommand(
      session, startTimeSec, audioTrackIndex, audioTrackCount, tmpPath);
  const pid_t pid = launchStage(argv, tmpPath, session->playbackLogPath);
  if (pid < 0) {
    const std::string error =
        std::string("Unable to start local remux: ") + strerror(errno);
    std::lock_guard<std::mutex> lock(session->mutex);
    session->playbackDone = true;
    session->error = error;
    return false;
  }
  bool stopped = false;
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    session->playbackPid = pid;
    stopped = session->stopping;
  }
  if (stopped) {
    // stopProxy ran between launch and monitor creation: reap the child here.
    kill(pid, SIGTERM);
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
    }
    std::lock_guard<std::mutex> lock(session->mutex);
    session->playbackPid = -1;
    session->playbackDone = true;
    return false;
  }
  session->playbackMonitorThread = std::thread(monitorProcess, session, pid, false, generation);
  return true;
}

void monitorProcess(const std::shared_ptr<ProxySession>& session,
                    pid_t pid,
                    bool masterStage,
                    int generation) {
  int status = 0;
  pid_t result = -1;
  do {
    result = waitpid(pid, &status, 0);
  } while (result < 0 && errno == EINTR);

  const int exitCode = result > 0 && WIFEXITED(status) ? WEXITSTATUS(status) : -1;

  bool shouldBeginPlayback = false;
  double startTimeSec = 0;
  int audioTrackIndex = -1;
  int audioTrackCount = 0;
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    if (masterStage) {
      session->masterDone = true;
      session->masterExitCode = exitCode;
      if (session->stopping) {
        session->cv.notify_all();
        return;
      }
      if (exitCode != 0) {
        session->error = ffmpegFailure(session->masterLogPath, exitCode);
      } else {
        const std::vector<AudioTrackMetadata> tracks =
            parseAudioTracks(readTail(session->masterLogPath, LOG_TAIL_BYTES));
        session->audioTracksJson = audioTracksToJson(tracks);
        session->discoveredAudioCount =
            tracks.empty() ? session->audioTrackCount : static_cast<int>(tracks.size());
        if (fileSize(session->masterTmpPath) <= 0 ||
            ::rename(session->masterTmpPath.c_str(), session->masterPath.c_str()) != 0) {
          session->error = "Master download did not produce a usable MKV";
        } else {
          session->masterComplete = true;
        }
      }
      if (session->error.empty()) {
        shouldBeginPlayback = true;
        startTimeSec = session->startTimeSec;
        audioTrackIndex = session->audioTrackIndex;
        audioTrackCount = session->audioTrackCount;
      }
    } else {
      session->playbackExitCode = exitCode;
      if (session->stopping ||
          generation != session->playbackInFlightGeneration) {
        // Superseded by a newer preparePlayback: its result is a diagnostic.
        session->playbackDiagnostic = "Playback generation " +
                                      std::to_string(generation) +
                                      " was superseded before completion";
        session->cv.notify_all();
        return;
      }
      session->playbackDone = true;
      const std::string tmpPath = session->playbackTmpPath;
      const long long size = fileSize(tmpPath);
      if (exitCode == 0 && size >= MIN_PLAYBACK_BYTES) {
        if (::rename(tmpPath.c_str(), session->cachePath.c_str()) == 0) {
          session->playbackReady = true;
          session->playbackGeneration = generation;
          session->playbackDiagnostic.clear();
        } else {
          session->playbackDiagnostic =
              std::string("Unable to publish playback file: ") + strerror(errno);
        }
      } else if (exitCode != 0) {
        session->playbackDiagnostic = ffmpegFailure(session->playbackLogPath, exitCode);
      } else {
        session->playbackDiagnostic =
            "Local remux produced only " + std::to_string(std::max<long long>(size, 0)) +
            " bytes (expected at least " + std::to_string(MIN_PLAYBACK_BYTES) + ")";
      }
      // A failed local remux is recoverable: an older playback file may still
      // be playing, and the caller can retry from the local master. Only a
      // failed master download is a fatal session error.
    }
  }
  session->cv.notify_all();

  // Called outside the mutex: beginPlayback may join the old stage 2 thread.
  if (shouldBeginPlayback) {
    beginPlayback(session, startTimeSec, audioTrackIndex, audioTrackCount, 1);
  }
}

void cleanupFiles(const std::shared_ptr<ProxySession>& session) {
  std::vector<std::string> paths;
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    paths.push_back(session->cachePath);
    paths.push_back(session->masterPath);
    paths.push_back(session->masterTmpPath);
    paths.push_back(session->masterLogPath);
    paths.push_back(session->playbackLogPath);
    paths.push_back(session->logPath);
    paths.insert(paths.end(), session->tempFiles.begin(), session->tempFiles.end());
  }
  for (const auto& path : paths) {
    if (!path.empty()) {
      unlink(path.c_str());
    }
  }
}

void stopSession(const std::shared_ptr<ProxySession>& session) {
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    session->stopping = true;
  }
  session->cv.notify_all();

  pid_t masterPid = -1;
  pid_t playbackPid = -1;
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    masterPid = session->masterPid;
    playbackPid = session->playbackPid;
    session->masterPid = -1;
    session->playbackPid = -1;
  }
  if (masterPid > 0 && masterPid != getpid()) {
    kill(masterPid, SIGTERM);
  }
  if (playbackPid > 0 && playbackPid != getpid()) {
    kill(playbackPid, SIGTERM);
  }
  // The master monitor can call beginPlayback; it sees stopping and skips it.
  if (session->masterMonitorThread.joinable() &&
      session->masterMonitorThread.get_id() != std::this_thread::get_id()) {
    session->masterMonitorThread.join();
  }
  {
    std::lock_guard<std::mutex> transition(session->transitionMutex);
    if (session->playbackMonitorThread.joinable() &&
        session->playbackMonitorThread.get_id() != std::this_thread::get_id()) {
      session->playbackMonitorThread.join();
    }
  }
  cleanupFiles(session);
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

  if (sessionId.empty() || url.empty()) {
    return errorResult("Missing sessionId or url");
  }

  {
    std::lock_guard<std::mutex> lock(gSessionsMutex);
    const auto existing = gSessions.find(sessionId);
    if (existing != gSessions.end()) {
      return statusObject(existing->second);
    }
  }

  const std::string binary = bundledPath(FFMPEG_BINARY);
  if (access(binary.c_str(), X_OK) != 0) {
    return errorResult("Bundled ffmpeg is missing or not executable: " + binary);
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
  session->localUrl = "file://" + session->cachePath;
  session->logPath = "/tmp/nuvio-proxy-" + idPart + ".log";
  session->masterPath = "/tmp/nuvio-proxy-" + idPart + "-master.mkv";
  session->masterTmpPath = "/tmp/nuvio-proxy-" + idPart + "-master.tmp.mkv";
  session->masterLogPath = "/tmp/nuvio-proxy-" + idPart + "-master.log";
  session->playbackLogPath = "/tmp/nuvio-proxy-" + idPart + "-playback.log";
  session->tempFiles.push_back(session->masterTmpPath);

  cleanupFiles(session);

  {
    std::lock_guard<std::mutex> lock(gSessionsMutex);
    gSessions[sessionId] = session;
  }

  const std::vector<std::string> argv = buildMasterCommand(session);
  const pid_t pid = launchStage(argv, session->masterTmpPath, session->masterLogPath);
  if (pid < 0) {
    const std::string error =
        std::string("Unable to start bundled ffmpeg: ") + strerror(errno);
    {
      std::lock_guard<std::mutex> lock(session->mutex);
      session->error = error;
      session->masterDone = true;
    }
    return statusObject(session);
  }
  bool stopped = false;
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    session->masterPid = pid;
    stopped = session->stopping;
  }
  if (stopped) {
    kill(pid, SIGTERM);
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
    }
    std::lock_guard<std::mutex> lock(session->mutex);
    session->masterPid = -1;
    session->masterDone = true;
    return errorResult("Session was stopped");
  }
  session->masterMonitorThread = std::thread(monitorProcess, session, pid, true, 0);

  // Return immediately: no preroll wait, no file exposure before completion.
  return statusObject(session);
}

JSObject NuvioMediaProxy::preparePlayback(JSObject config) {
  const std::string sessionId = valueOr<std::string>(config, "sessionId", "");
  const double startTimeSec = valueOr<double>(config, "startTimeSec", 0);
  const double audioTrack = valueOr<double>(config, "audioTrackIndex", -1);
  const double audioTracks = valueOr<double>(config, "audioTrackCount", 0);
  const double generationValue = valueOr<double>(config, "generation", 1);

  std::shared_ptr<ProxySession> session;
  {
    std::lock_guard<std::mutex> lock(gSessionsMutex);
    const auto it = gSessions.find(sessionId);
    if (it != gSessions.end()) {
      session = it->second;
    }
  }
  if (!session) {
    return errorResult("Unknown sessionId: " + sessionId);
  }

  {
    std::lock_guard<std::mutex> lock(session->mutex);
    if (!session->masterComplete || session->masterExitCode != 0) {
      JSObject result = statusLocked(session);
      if (session->error.empty()) {
        result["error"] = std::string("Local master is not complete yet");
      }
      return result;
    }
  }

  const int generation = generationValue > 0 ? static_cast<int>(generationValue) : 1;
  const bool started = beginPlayback(session, startTimeSec,
                                     audioTrack >= 0 ? static_cast<int>(audioTrack) : -1,
                                     audioTracks > 0 ? static_cast<int>(audioTracks) : 0,
                                     generation);
  JSObject result = statusObject(session);
  if (!started) {
    std::lock_guard<std::mutex> lock(session->mutex);
    if (session->error.empty()) {
      result["error"] = std::string("Unable to start local playback remux");
    }
  }
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
  return true;
}

JSObject NuvioMediaProxy::proxyStatus(std::string sessionId) {
  std::shared_ptr<ProxySession> session;
  {
    std::lock_guard<std::mutex> lock(gSessionsMutex);
    const auto it = gSessions.find(sessionId);
    if (it != gSessions.end()) {
      session = it->second;
    }
  }
  if (!session) {
    return baseResult("missing");
  }
  return statusObject(session);
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
  std::lock_guard<std::mutex> lock(session->mutex);
  return combinedLogTailLocked(session);
}

} // namespace nuviomediaproxyTurboModule
