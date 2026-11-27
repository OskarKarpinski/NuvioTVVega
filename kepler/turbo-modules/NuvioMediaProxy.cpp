#include "NuvioMediaProxy.h"

#include <algorithm>
#include <cerrno>
#include <cctype>
#include <chrono>
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

/** One ffmpeg run never writes more than this to the device. */
constexpr long long MAX_SEGMENT_BYTES = 192LL * 1024 * 1024;
/** A playback file smaller than this is not safe to hand to the native demuxer. */
constexpr long long MIN_PLAYBACK_BYTES = 128LL * 1024;
constexpr long long LOG_TAIL_BYTES = 8 * 1024;

struct ProxySession {
  std::string id;
  std::string url;
  std::string headers;
  /** The only local file ever handed to the native player. */
  std::string cachePath;
  std::string logPath;
  std::string localUrl;

  /** Current segment: a single size-bounded MKV built straight from the URL. */
  std::string segmentTmpPath;
  std::string segmentLogPath;
  std::string previousLogPath;
  size_t segmentLogOffset = 0;
  pid_t segmentPid = -1;
  std::thread segmentMonitorThread;

  bool ready = false;
  bool segmentDone = false;
  bool endOfStream = false;
  bool segmentCancelled = false;
  int segmentExitCode = 0;
  int playbackGeneration = 0;
  int generationInFlight = -1;
  int requestedGeneration = 0;
  std::string playbackDiagnostic;

  int audioTrackIndex = -1;
  int audioTrackCount = 0;
  bool stopping = false;
  std::string error;
  /** JSON array of audio streams discovered from the segment's stream list. */
  std::string audioTracksJson = "[]";
  std::vector<std::string> tempFiles;
  std::vector<std::string> logFiles;

  std::mutex mutex;
  /** Serializes process teardown/launch; never held while joining a thread. */
  std::mutex transitionMutex;
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

/** Mirrors newly written segment diagnostics into the logPath exposed to JS. */
void appendLogUpdatesLocked(const std::shared_ptr<ProxySession>& session) {
  const std::string& path = session->segmentLogPath;
  if (path.empty()) {
    return;
  }
  const long long size = fileSize(path);
  if (size < 0) {
    return;
  }
  size_t& offset = session->segmentLogOffset;
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
}

/** Combined tail: previous segment diagnostics first, then the newest run. */
std::string combinedLogTailLocked(const std::shared_ptr<ProxySession>& session) {
  appendLogUpdatesLocked(session);
  const std::string previous = trim(readTail(session->previousLogPath, LOG_TAIL_BYTES / 2));
  const std::string current = trim(readTail(session->segmentLogPath, LOG_TAIL_BYTES / 2));
  if (previous.empty()) {
    return current;
  }
  if (current.empty()) {
    return previous;
  }
  return "previous: " + previous + "\nsegment: " + current;
}

std::string currentPhaseLocked(const std::shared_ptr<ProxySession>& session) {
  if (!session->error.empty()) {
    return "error";
  }
  if (session->generationInFlight >= 0 && !session->segmentDone) {
    return "preparing";
  }
  if (session->ready) {
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
  // While building, the temp file is the progress signal; once ready, only the
  // published file matters. Missing sessions report zero.
  const bool building = session->generationInFlight >= 0 && !session->segmentDone;
  const std::string& progressPath =
      building ? session->segmentTmpPath : session->cachePath;
  result["bytesWritten"] = static_cast<double>(
      (building || session->ready)
          ? std::max<long long>(fileSize(progressPath), 0)
          : 0);
  result["exitCode"] = static_cast<double>(session->segmentExitCode);
  result["error"] = session->error;
  result["log"] = combinedLogTailLocked(session);
  result["audioTracks"] = session->audioTracksJson;
  result["selfTest"] = readSelfTest();
  result["playbackGeneration"] = static_cast<double>(session->playbackGeneration);
  result["generationInFlight"] = static_cast<double>(session->generationInFlight);
  result["segmentDone"] = static_cast<double>(session->segmentDone ? 1 : 0);
  result["endOfStream"] = static_cast<double>(session->endOfStream ? 1 : 0);
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
  result["exitCode"] = 0.0;
  result["error"] = std::string("");
  result["log"] = std::string("");
  result["audioTracks"] = std::string("[]");
  result["selfTest"] = readSelfTest();
  result["playbackGeneration"] = 0.0;
  result["generationInFlight"] = -1.0;
  result["segmentDone"] = 0.0;
  result["endOfStream"] = 0.0;
  result["playbackDiagnostic"] = std::string("");
  return result;
}

JSObject errorResult(const std::string& message) {
  JSObject result = baseResult("error");
  result["error"] = message;
  return result;
}

/**
 * Launches one bundled ffmpeg run. Stdout is discarded, stderr goes to this
 * segment's own log; the MKV is written to a temp path until it is complete.
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
    int log = open(stderrPath.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (log >= 0) {
      dup2(log, STDERR_FILENO);
      close(log);
    }
    execChild(argv);
  }
  return pid;
}

/**
 * One ffmpeg invocation fetches one bounded segment straight from the remote
 * URL. There is no local master and no HTTP range handling of our own: -ss
 * before -i asks ffmpeg to seek in the source, and -fs caps the output size.
 */
std::vector<std::string> buildSegmentCommand(const std::string& url,
                                             const std::string& headers,
                                             double startTimeSec,
                                             int audioTrackIndex,
                                             int audioTrackCount,
                                             const std::string& outputPath) {
  // Info level is needed once: ffmpeg prints the input stream languages/titles
  // before remuxing. -nostats keeps the diagnostic log free of progress spam.
  std::vector<std::string> argv = {
      bundledPath(FFMPEG_BINARY), "-hide_banner", "-loglevel", "info",
      "-nostats", "-nostdin", "-y"};
  if (!headers.empty()) {
    argv.push_back("-headers");
    argv.push_back(headers);
  }
  if (startTimeSec > 0.05) {
    std::ostringstream startText;
    startText << std::fixed << std::max<double>(0, startTimeSec);
    argv.push_back("-ss");
    argv.push_back(startText.str());
  }
  argv.push_back("-i");
  argv.push_back(url);
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
  // Leave exactly one default audio track so Vega does not reconfigure its
  // pipeline in a loop. Without a track count there is nothing to select.
  if (audioTrackCount > 0) {
    int selected = 0;
    if (audioTrackIndex >= 0) {
      selected = std::min(audioTrackIndex, audioTrackCount - 1);
    }
    argv.push_back("-disposition:a");
    argv.push_back("0");
    std::ostringstream defaultSpecifier;
    defaultSpecifier << "-disposition:a:" << selected;
    argv.push_back(defaultSpecifier.str());
    argv.push_back("default");
  }
  argv.push_back("-fs");
  argv.push_back(std::to_string(MAX_SEGMENT_BYTES));
  argv.push_back("-f");
  argv.push_back("matroska");
  argv.push_back(outputPath);
  return argv;
}

void monitorProcess(const std::shared_ptr<ProxySession>& session,
                    pid_t pid,
                    int generation,
                    const std::string& tmpPath,
                    const std::string& logPath);

/**
 * Kills the active segment and joins its monitor. Called only by the holder of
 * transitionMutex; the session mutex is never held during the join.
 */
void stopSegmentProcess(const std::shared_ptr<ProxySession>& session) {
  pid_t pid = -1;
  bool joinable = false;
  bool joinFromSelf = false;
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    pid = session->segmentPid;
    session->segmentPid = -1;
    if (pid > 0) {
      session->segmentCancelled = true;
    }
    joinable = session->segmentMonitorThread.joinable();
    joinFromSelf = joinable &&
                   session->segmentMonitorThread.get_id() == std::this_thread::get_id();
  }
  if (pid > 0 && pid != getpid()) {
    kill(pid, SIGTERM);
  }
  if (joinable && !joinFromSelf) {
    session->segmentMonitorThread.join();
  }
}

/** Rebuilds one bounded segment from the network; never reads a local master. */
bool beginSegment(const std::shared_ptr<ProxySession>& session,
                  double startTimeSec,
                  int audioTrackIndex,
                  int audioTrackCount,
                  int generation) {
  std::lock_guard<std::mutex> transition(session->transitionMutex);
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    if (session->stopping || generation < session->requestedGeneration) {
      return false;
    }
    session->requestedGeneration = generation;
  }

  // The old process must be reaped before its paths/state can be replaced.
  stopSegmentProcess(session);

  const std::string idPart = safeSessionId(session->id);
  const std::string tmpPath = "/tmp/nuvio-proxy-" + idPart +
                              "-segment-" + std::to_string(generation) + ".tmp.mkv";
  const std::string logPath = "/tmp/nuvio-proxy-" + idPart +
                              "-segment-" + std::to_string(generation) + ".log";
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    if (session->stopping) {
      return false;
    }
    appendLogUpdatesLocked(session);
    session->previousLogPath = session->segmentLogPath;
    unlink(tmpPath.c_str());
    session->segmentTmpPath = tmpPath;
    session->segmentLogPath = logPath;
    session->segmentLogOffset = 0;
    session->tempFiles.push_back(tmpPath);
    session->logFiles.push_back(logPath);
    session->generationInFlight = generation;
    session->segmentDone = false;
    session->endOfStream = false;
    session->segmentCancelled = false;
    session->segmentExitCode = 0;
    session->playbackDiagnostic.clear();
    session->error.clear();
  }

  const std::vector<std::string> argv = buildSegmentCommand(
      session->url, session->headers, startTimeSec,
      audioTrackIndex, audioTrackCount, tmpPath);
  const pid_t pid = launchStage(argv, "/dev/null", logPath);
  if (pid < 0) {
    const std::string error =
        std::string("Unable to start bundled ffmpeg: ") + strerror(errno);
    std::lock_guard<std::mutex> lock(session->mutex);
    session->error = error;
    session->playbackDiagnostic = error;
    session->generationInFlight = -1;
    session->segmentDone = true;
    return false;
  }
  bool stopped = false;
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    session->segmentPid = pid;
    stopped = session->stopping;
  }
  if (stopped) {
    // stopProxy ran between launch and monitor creation: reap the child here.
    kill(pid, SIGTERM);
    int status = 0;
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
    }
    std::lock_guard<std::mutex> lock(session->mutex);
    session->segmentPid = -1;
    session->segmentDone = true;
    session->generationInFlight = -1;
    return false;
  }
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    session->segmentMonitorThread =
        std::thread(monitorProcess, session, pid, generation, tmpPath, logPath);
  }
  return true;
}

void monitorProcess(const std::shared_ptr<ProxySession>& session,
                    pid_t pid,
                    int generation,
                    const std::string& tmpPath,
                    const std::string& logPath) {
  int status = 0;
  pid_t result = -1;
  do {
    result = waitpid(pid, &status, 0);
  } while (result < 0 && errno == EINTR);

  const int exitCode = result > 0 && WIFEXITED(status) ? WEXITSTATUS(status) : -1;
  const std::vector<AudioTrackMetadata> tracks =
      parseAudioTracks(readTail(logPath, LOG_TAIL_BYTES));

  {
    std::lock_guard<std::mutex> lock(session->mutex);
    if (session->segmentPid == pid) {
      session->segmentPid = -1;
    }
    session->segmentExitCode = exitCode;
    session->segmentDone = true;
    // Keep the finished generation here: it identifies which build the
    // `segmentDone` flag and `playbackDiagnostic` refer to. The next
    // beginSegment overwrites it after joining this monitor.
    const int inFlight = session->generationInFlight;
    session->audioTracksJson = audioTracksToJson(tracks);

    if (session->stopping || session->segmentCancelled || inFlight != generation) {
      // Superseded by a newer preparePlayback or stopped: never fatal.
      session->segmentCancelled = false;
      session->endOfStream = false;
      session->playbackDiagnostic = "Segment generation " +
                                    std::to_string(generation) +
                                    " was superseded before completion";
      return;
    }

    const long long size = fileSize(tmpPath);
    if (exitCode == 0 && size >= MIN_PLAYBACK_BYTES) {
      if (::rename(tmpPath.c_str(), session->cachePath.c_str()) == 0) {
        session->ready = true;
        session->playbackGeneration = generation;
        session->endOfStream = false;
        session->playbackDiagnostic.clear();
      } else {
        session->endOfStream = false;
        session->playbackDiagnostic =
            std::string("Unable to publish segment: ") + strerror(errno);
      }
    } else if (exitCode == 0) {
      // Clean EOF close to the start of the source: keep any older complete
      // playback file and report end of stream, not a fatal error.
      session->endOfStream = true;
      session->playbackDiagnostic =
          "Segment produced only " + std::to_string(std::max<long long>(size, 0)) +
          " bytes (expected at least " + std::to_string(MIN_PLAYBACK_BYTES) + ")";
      unlink(tmpPath.c_str());
    } else {
      // A failed seek/audio switch is recoverable; only invalid config is fatal.
      session->endOfStream = false;
      session->playbackDiagnostic = ffmpegFailure(logPath, exitCode);
    }
  }
}

void cleanupFiles(const std::shared_ptr<ProxySession>& session) {
  std::vector<std::string> paths;
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    paths.push_back(session->cachePath);
    paths.push_back(session->logPath);
    paths.push_back(session->previousLogPath);
    paths.push_back(session->segmentTmpPath);
    paths.push_back(session->segmentLogPath);
    paths.insert(paths.end(), session->tempFiles.begin(), session->tempFiles.end());
    paths.insert(paths.end(), session->logFiles.begin(), session->logFiles.end());
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
  std::lock_guard<std::mutex> transition(session->transitionMutex);
  stopSegmentProcess(session);
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
  session->audioTrackIndex = audioTrack >= 0 ? static_cast<int>(audioTrack) : -1;
  session->audioTrackCount = audioTracks > 0 ? static_cast<int>(audioTracks) : 0;
  const std::string idPart = safeSessionId(sessionId);
  session->cachePath = "/tmp/nuvio-proxy-" + idPart + ".mkv";
  session->localUrl = "file://" + session->cachePath;
  session->logPath = "/tmp/nuvio-proxy-" + idPart + ".log";

  cleanupFiles(session);

  {
    std::lock_guard<std::mutex> lock(gSessionsMutex);
    gSessions[sessionId] = session;
  }

  // One invocation, one bounded segment, generation 1. Returns immediately.
  beginSegment(session, startTimeSec, session->audioTrackIndex,
               session->audioTrackCount, 1);
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

  const int generation = generationValue > 0 ? static_cast<int>(generationValue) : 1;
  beginSegment(session, startTimeSec,
               audioTrack >= 0 ? static_cast<int>(audioTrack) : -1,
               audioTracks > 0 ? static_cast<int>(audioTracks) : 0,
               generation);
  // No master gate and no fatal error on rebuild: a failed seek/audio switch is
  // recoverable, and any older complete segment remains usable.
  return statusObject(session);
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
    if (it != gSessions.end()) {
      session = it->second;
    }
  }
  if (!session) {
    return std::string();
  }
  std::lock_guard<std::mutex> lock(session->mutex);
  return combinedLogTailLocked(session);
}

} // namespace nuviomediaproxyTurboModule
