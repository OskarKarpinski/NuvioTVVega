#include "NuvioMediaProxy.h"

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cctype>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <csignal>
#include <cstring>
#include <dlfcn.h>
#include <fcntl.h>
#include <fstream>
#include <iterator>
#include <linux/falloc.h>
#include <map>
#include <memory>
#include <mutex>
#include <netinet/in.h>
#include <poll.h>
#include <sstream>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <thread>
#include <type_traits>
#include <unistd.h>
#include <utility>
#include <vector>

extern char **environ;

namespace nuviomediaproxyTurboModule {

namespace {

using com::amazon::kepler::turbomodule::JSObject;

constexpr const char* FFPROBE_BIN = "/usr/bin/ffprobe";
constexpr const char* FFMPEG_BIN = "/usr/bin/ffmpeg";

constexpr long long PRESERVE_HEAD_BYTES = 256LL * 1024 * 1024;
constexpr long long KEEP_BEHIND_BYTES = 128LL * 1024 * 1024;
constexpr long long DEFAULT_MAX_DISK_BYTES = 768LL * 1024 * 1024;
constexpr size_t CLIENT_CHUNK_BYTES = 64 * 1024;

struct ProxySession {
  std::string id;
  std::string url;
  std::string headers;
  std::string cachePath;
  std::string logPath;
  std::string localUrl;
  double sourceTotalBytes = 0;
  double estimatedTotalBytes = 0;
  double startTimeSec = 0;
  long long maxDiskBytes = DEFAULT_MAX_DISK_BYTES;
  pid_t ffmpegPid = -1;
  int serverFd = -1;
  int port = 0;
  bool stopping = false;
  bool ready = false;
  bool ffmpegDone = false;
  bool needsRestart = false;
  int ffmpegExitCode = 0;
  long long punchedUpTo = 0;
  std::string error;
  std::mutex mutex;
  std::condition_variable cv;
  std::thread serverThread;
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

/**
 * Kepler apps run in their own mount namespace. `/usr/lib` inside that
 * namespace contains the app's incompatible libav* build, so the system
 * ffprobe binary cannot resolve `av_hash_alloc, version LIBAVUTIL_56`. We ship
 * the matching libav* files next to this module and point the child at them.
 */
std::string moduleDirectory() {
  Dl_info info{};
  if (dladdr(reinterpret_cast<void*>(&moduleDirectory), &info) != 0 && info.dli_fname != nullptr) {
    const std::string path = info.dli_fname;
    const auto slash = path.find_last_of('/');
    if (slash != std::string::npos) {
      return path.substr(0, slash);
    }
  }
  // dladdr can fail when the module was loaded from a generated link map.
  // Fall back to the mapping recorded by the kernel for this process.
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
  return std::string("/usr/lib");
}

bool directoryHasLibavutil(const std::string& directory) {
  const std::string path = directory + "/libavutil.so.56";
  if (access(path.c_str(), R_OK) != 0) {
    return false;
  }
  // The app's own libavutil has a different ABI. Verify the exported symbol is
  // really there instead of trusting the SONAME alone.
  std::ifstream file(path, std::ios::binary);
  if (!file) {
    return false;
  }
  const std::string content{std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
  return content.find("av_hash_alloc") != std::string::npos;
}

std::string libraryDirectory() {
  const std::string module = moduleDirectory();
  const std::vector<std::string> candidates = {
      module,
      module + "/lib",
      module + "/../lib/armv7",
      "/opt/apps/com.nuvio.tv.vega/lib/armv7",
      "/tmp/nuvio-libs",
      "/usr/lib",
  };
  for (const auto& candidate : candidates) {
    if (directoryHasLibavutil(candidate)) {
      return candidate;
    }
  }
  return module;
}

std::vector<std::string> sanitizedEnvironment(const std::string& libraryDirectory) {
  std::vector<std::string> environment;
  bool hasPath = false;
  for (char** entry = environ; entry != nullptr && *entry != nullptr; ++entry) {
    const std::string item = *entry;
    if (item.rfind("LD_LIBRARY_PATH=", 0) == 0 || item.rfind("LD_PRELOAD=", 0) == 0 ||
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
  environment.push_back("LD_LIBRARY_PATH=" + libraryDirectory + ":/usr/lib:/lib");
  return environment;
}

void execChild(const std::vector<std::string>& argv) {
  const std::string libraries = libraryDirectory();
  const std::string diagnostic =
      "[proxy-env] module=" + moduleDirectory() + " libs=" + libraries + "\n";
  write(STDERR_FILENO, diagnostic.data(), diagnostic.size());

  // Kepler launches apps in secure mode, so the dynamic linker can ignore
  // LD_LIBRARY_PATH for children. Invoke the loader with an explicit
  // --library-path, which is honoured regardless of AT_SECURE.
  constexpr const char* LOADER = "/lib/ld-linux-armhf.so.3";
  std::vector<std::string> command;
  if (access(LOADER, X_OK) == 0) {
    command.push_back(LOADER);
    command.push_back("--library-path");
    command.push_back(libraries + ":/usr/lib:/lib");
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

/**
 * Runs a child process and captures both streams. ffprobe writes its real
 * failure reason (HTTP status, protocol error, etc.) to stderr, so hiding it
 * would leave the app with only "ffprobe failed for media source".
 */
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
          sink.append(buffer, std::min<size_t>(static_cast<size_t>(count), maxBytes - sink.size()));
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
    if (headers[index] == '\r' && index + 1 < headers.size() && headers[index + 1] == '\n') {
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
  while (begin < input.size() && std::isspace(static_cast<unsigned char>(input[begin]))) {
    ++begin;
  }
  size_t end = input.size();
  while (end > begin && std::isspace(static_cast<unsigned char>(input[end - 1]))) {
    --end;
  }
  return input.substr(begin, end - begin);
}

bool isSafeAudioCodec(const std::string& codec) {
  static const char* const safe[] = {
      "aac", "mp3", "flac", "opus", "alac", "vorbis", "pcm_s16le", "pcm_s24le"};
  for (const char* item : safe) {
    if (codec == item) {
      return true;
    }
  }
  return false;
}

double parseBitrate(const std::string& text) {
  if (text.empty() || text == "N/A") {
    return 0;
  }
  try {
    const double value = std::stod(trim(text));
    return std::isfinite(value) && value > 0 ? value : 0;
  } catch (...) {
    return 0;
  }
}

void selectTracks(
    const std::string& url,
    const std::string& headers,
    double sourceTotalBytes,
    int& videoIndex,
    std::vector<int>& audioIndexes,
    bool& useAllAudio,
    double& sourceBytes,
    double& estimatedTotalBytes,
    std::string& error) {
  videoIndex = -1;
  useAllAudio = true;
  sourceBytes = 0;
  estimatedTotalBytes = sourceTotalBytes;

  std::vector<std::string> probeArgv = {
      FFPROBE_BIN, "-v", "error", "-show_entries",
      "stream=index,codec_name,codec_type,bit_rate:format=bit_rate,size",
      "-of", "csv=p=0"};
  if (!headers.empty()) {
    probeArgv.push_back("-headers");
    probeArgv.push_back(headers);
  }
  probeArgv.push_back(url);

  std::string output;
  std::string errorOutput;
  const int probeExit = runCapture(probeArgv, output, errorOutput, 256 * 1024);
  if (probeExit != 0) {
    std::string detail = trim(errorOutput.empty() ? output : errorOutput);
    if (detail.size() > 512) {
      detail = detail.substr(0, 512);
    }
    error = "ffprobe failed for media source (exit " + std::to_string(probeExit) + ")";
    if (!detail.empty()) {
      error += ": " + detail;
    }
    return;
  }

  std::vector<int> safeAudio;
  double allVideoBitrate = 0;
  double allAudioBitrate = 0;
  double selectedBitrate = 0;
  double formatBitrate = 0;

  std::istringstream lines(output);
  std::string line;
  while (std::getline(lines, line)) {
    line = trim(line);
    if (line.empty()) {
      continue;
    }
    std::istringstream fields(line);
    std::string first;
    std::string second;
    std::string third;
    std::string fourth;
    std::getline(fields, first, ',');
    std::getline(fields, second, ',');
    std::getline(fields, third, ',');
    std::getline(fields, fourth, ',');

    if (trim(third).empty() && trim(fourth).empty()) {
      // Vega's ffprobe prints `format` as `size,bit_rate`, not as a stream row.
      // A 2 GB file still fits in an int, so stoi() would silently accept it as
      // a bogus stream index unless the row shape is checked first.
      sourceBytes = parseBitrate(first);
      formatBitrate = parseBitrate(second);
      if (formatBitrate > sourceBytes) {
        std::swap(sourceBytes, formatBitrate);
      }
      continue;
    }

    int index = -1;
    try {
      index = std::stoi(trim(first));
    } catch (...) {
      // Vega's ffprobe prints the format section as size,bit_rate. Guard against
      // a reversed order on other builds by comparing magnitudes.
      sourceBytes = parseBitrate(first);
      formatBitrate = parseBitrate(second);
      if (formatBitrate > sourceBytes) {
        std::swap(sourceBytes, formatBitrate);
      }
      continue;
    }
    const std::string codec = trim(second);
    const std::string type = trim(third);
    const double bitrate = parseBitrate(fourth);

    if (type == "video") {
      if (videoIndex < 0) {
        videoIndex = index;
      }
      allVideoBitrate += bitrate;
      selectedBitrate += bitrate;
    } else if (type == "audio") {
      allAudioBitrate += bitrate;
      if (isSafeAudioCodec(codec)) {
        safeAudio.push_back(index);
        selectedBitrate += bitrate;
      }
    }
  }

  if (!safeAudio.empty()) {
    audioIndexes = safeAudio;
    useAllAudio = false;
  } else {
    selectedBitrate += allAudioBitrate;
  }

  const double totalBitrate = allVideoBitrate + allAudioBitrate > 0
      ? allVideoBitrate + allAudioBitrate
      : formatBitrate;
  const double effectiveSourceBytes = sourceBytes > 0 ? sourceBytes : sourceTotalBytes;
  if (effectiveSourceBytes > 0) {
    double estimate = effectiveSourceBytes;
    if (totalBitrate > 0 && selectedBitrate > 0) {
      estimate = std::min(estimate, effectiveSourceBytes * selectedBitrate / totalBitrate);
    }
    if (estimate > 0) {
      estimatedTotalBytes = estimate;
    }
  }
}

std::string safeSessionId(const std::string& input) {
  std::string result;
  for (const char item : input) {
    result.push_back(std::isalnum(static_cast<unsigned char>(item)) ? item : '_');
  }
  return result.empty() ? std::string("session") : result;
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

void monitorProcess(const std::shared_ptr<ProxySession>& session) {
  int status = 0;
  pid_t result = -1;
  do {
    result = waitpid(session->ffmpegPid, &status, 0);
  } while (result < 0 && errno == EINTR);
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    session->ffmpegDone = true;
    session->ffmpegExitCode = result > 0 && WIFEXITED(status) ? WEXITSTATUS(status) : -1;
    if (session->ffmpegExitCode != 0 && session->error.empty()) {
      session->error = "ffmpeg exited with code " + std::to_string(session->ffmpegExitCode);
    }
  }
  session->cv.notify_all();
}

bool waitForBytes(const std::shared_ptr<ProxySession>& session, long long needed) {
  while (true) {
    bool stopped = false;
    bool done = false;
    {
      std::lock_guard<std::mutex> lock(session->mutex);
      stopped = session->stopping;
      done = session->ffmpegDone;
    }
    if (stopped) {
      return false;
    }
    const long long size = fileSize(session->cachePath);
    if (size < 0) {
      return false;
    }
    if (size >= needed || (done && size >= 0)) {
      return true;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
  }
}

void trimCache(const std::shared_ptr<ProxySession>& session, long long servedEnd) {
  long long keepFrom = servedEnd - KEEP_BEHIND_BYTES;
  if (keepFrom <= PRESERVE_HEAD_BYTES) {
    return;
  }
  long long page = 4096;
  long long alignedEnd = (keepFrom / page) * page;
  long long punched = 0;
  long long limit = 0;
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    punched = std::max(session->punchedUpTo, PRESERVE_HEAD_BYTES);
    limit = session->maxDiskBytes;
  }
  if (alignedEnd <= punched) {
    return;
  }

  const int fd = open(session->cachePath.c_str(), O_RDWR);
  if (fd >= 0) {
    const int rc = fallocate(
        fd, FALLOC_FL_PUNCH_HOLE | FALLOC_FL_KEEP_SIZE,
        static_cast<off_t>(punched), static_cast<off_t>(alignedEnd - punched));
    close(fd);
    if (rc == 0) {
      std::lock_guard<std::mutex> lock(session->mutex);
      session->punchedUpTo = alignedEnd;
    }
  }

  const long long size = fileSize(session->cachePath);
  const long long punchedNow = [&] {
    std::lock_guard<std::mutex> lock(session->mutex);
    return session->punchedUpTo;
  }();
  const long long diskBytes = std::max<long long>(0, size - punchedNow);
  if (limit > 0 && diskBytes > limit) {
    bool signaled = false;
    {
      std::lock_guard<std::mutex> lock(session->mutex);
      if (session->error.empty()) {
        session->error = "cache disk limit exceeded (" + std::to_string(diskBytes) + " bytes)";
        signaled = true;
      }
    }
    if (signaled && session->ffmpegPid > 0) {
      kill(session->ffmpegPid, SIGTERM);
    }
  }
}

void sendAll(int fd, const char* data, size_t length) {
  size_t sent = 0;
  while (sent < length) {
    const ssize_t count = send(fd, data + sent, length - sent, MSG_NOSIGNAL);
    if (count <= 0) {
      if (count < 0 && (errno == EINTR || errno == EAGAIN)) {
        continue;
      }
      return;
    }
    sent += static_cast<size_t>(count);
  }
}

void sendStatus(int fd, int code, const std::string& reason, const std::string& headers) {
  std::ostringstream response;
  response << "HTTP/1.1 " << code << " " << reason << "\r\n"
           << headers
           << "Content-Length: 0\r\n"
           << "Connection: close\r\n\r\n";
  const std::string text = response.str();
  sendAll(fd, text.data(), text.size());
}

void handleClient(const std::shared_ptr<ProxySession>& session, int fd) {
  std::string request;
  char buffer[4096];
  while (request.size() < 16 * 1024) {
    const ssize_t count = recv(fd, buffer, sizeof(buffer), 0);
    if (count <= 0) {
      close(fd);
      return;
    }
    request.append(buffer, static_cast<size_t>(count));
    if (request.find("\r\n\r\n") != std::string::npos) {
      break;
    }
  }

  std::string rangeHeader;
  std::istringstream lines(request);
  std::string line;
  while (std::getline(lines, line)) {
    if (!line.empty() && line.back() == '\r') {
      line.pop_back();
    }
    if (line.rfind("Range:", 0) == 0) {
      rangeHeader = trim(line.substr(6));
    }
  }

  bool hasRange = false;
  long long start = 0;
  long long end = -1;
  if (rangeHeader.rfind("bytes=", 0) == 0) {
    const std::string spec = rangeHeader.substr(6);
    const size_t dash = spec.find('-');
    if (dash != std::string::npos) {
      try {
        start = std::stoll(trim(spec.substr(0, dash)));
        const std::string endText = trim(spec.substr(dash + 1));
        end = endText.empty() ? -1 : std::stoll(endText);
        hasRange = start >= 0 && (end < 0 || end >= start);
      } catch (...) {
        hasRange = false;
      }
    }
  }

  const long long available = fileSize(session->cachePath);
  if (available < 0) {
    sendStatus(fd, 503, "Service Unavailable", "Content-Type: video/x-matroska\r\n");
    close(fd);
    return;
  }

  long long total = 0;
  bool done = false;
  long long punched = 0;
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    done = session->ffmpegDone;
    punched = session->punchedUpTo;
    total = done
        ? available
        : static_cast<long long>(std::max<double>(session->estimatedTotalBytes, available));
  }
  if (total <= 0) {
    total = std::max<long long>(available, 1);
  }

  if (hasRange && start >= total) {
    if (!done && available > 0) {
      // The remux may end smaller than the source; wait briefly and re-check.
      std::this_thread::sleep_for(std::chrono::milliseconds(100));
      std::lock_guard<std::mutex> lock(session->mutex);
      done = session->ffmpegDone;
      if (done) {
        total = available;
      }
    }
    if (start >= total && done) {
      const std::string headers =
          "Content-Range: bytes */" + std::to_string(total) + "\r\n"
          "Content-Type: video/x-matroska\r\n";
      sendStatus(fd, 416, "Range Not Satisfiable", headers);
      close(fd);
      return;
    }
  }

  if (hasRange && start < punched) {
    {
      std::lock_guard<std::mutex> lock(session->mutex);
      session->needsRestart = true;
    }
    const std::string headers =
        "Content-Range: bytes */" + std::to_string(total) + "\r\n"
        "X-Nuvio-Cache-Restart: 1\r\n"
        "Content-Type: video/x-matroska\r\n";
    sendStatus(fd, 416, "Range Not Satisfiable", headers);
    close(fd);
    return;
  }

  if (!hasRange) {
    if (!waitForBytes(session, 1)) {
      close(fd);
      return;
    }
    start = 0;
    end = std::max<long long>(fileSize(session->cachePath) - 1, 0);
  } else {
    if (end < 0 || end >= total) {
      end = total - 1;
    }
    // An open-ended request must not block until the whole (multi-GB) remux is
    // written. Serve the bytes that exist now; the player will ask for more as
    // it consumes the stream.
    const long long availableNow = fileSize(session->cachePath);
    if (end >= availableNow) {
      if (availableNow <= 0 && !waitForBytes(session, 1)) {
        close(fd);
        return;
      }
      end = std::min(end, fileSize(session->cachePath) - 1);
    }
  }

  if (!waitForBytes(session, std::min(end + 1, total))) {
    close(fd);
    return;
  }

  const long long actualAvailable = fileSize(session->cachePath);
  const long long actualEnd = std::min(end, actualAvailable - 1);
  if (actualEnd < start) {
    const std::string headers =
        "Content-Range: bytes */" + std::to_string(total) + "\r\n"
        "Content-Type: video/x-matroska\r\n";
    sendStatus(fd, 416, "Range Not Satisfiable", headers);
    close(fd);
    return;
  }

  std::ostringstream header;
  header << "HTTP/1.1 206 Partial Content\r\n"
         << "Content-Type: video/x-matroska\r\n"
         << "Accept-Ranges: bytes\r\n"
         << "Cache-Control: no-store\r\n"
         << "Content-Range: bytes " << start << "-" << actualEnd << "/" << total << "\r\n"
         << "Content-Length: " << (actualEnd - start + 1) << "\r\n"
         << "Connection: close\r\n\r\n";
  const std::string headerText = header.str();
  sendAll(fd, headerText.data(), headerText.size());

  const int file = open(session->cachePath.c_str(), O_RDONLY);
  if (file < 0) {
    close(fd);
    return;
  }
  long long offset = start;
  while (offset <= actualEnd) {
    if (!waitForBytes(session, offset + 1)) {
      break;
    }
    const size_t wanted = static_cast<size_t>(
        std::min<long long>(static_cast<long long>(CLIENT_CHUNK_BYTES), actualEnd - offset + 1));
    char chunk[CLIENT_CHUNK_BYTES];
    const ssize_t count = pread(file, chunk, wanted, static_cast<off_t>(offset));
    if (count <= 0) {
      if (count < 0 && errno == EINTR) {
        continue;
      }
      break;
    }
    sendAll(fd, chunk, static_cast<size_t>(count));
    offset += count;
  }
  close(file);
  close(fd);
  trimCache(session, offset);
}

void serverLoop(const std::shared_ptr<ProxySession>& session) {
  signal(SIGPIPE, SIG_IGN);
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) {
    return;
  }
  int reuse = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
  sockaddr_in address {};
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = 0;
  if (bind(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) != 0 ||
      listen(fd, 16) != 0) {
    close(fd);
    return;
  }
  sockaddr_in bound {};
  socklen_t boundLength = sizeof(bound);
  getsockname(fd, reinterpret_cast<sockaddr*>(&bound), &boundLength);

  {
    std::lock_guard<std::mutex> lock(session->mutex);
    session->serverFd = fd;
    session->port = ntohs(bound.sin_port);
    session->localUrl = "http://127.0.0.1:" + std::to_string(session->port) + "/stream.mkv";
    session->ready = true;
  }
  session->cv.notify_all();

  while (true) {
    sockaddr_in clientAddress {};
    socklen_t clientLength = sizeof(clientAddress);
    const int client = accept(fd, reinterpret_cast<sockaddr*>(&clientAddress), &clientLength);
    if (client < 0) {
      if (errno == EINTR && !session->stopping) {
        continue;
      }
      break;
    }
    std::thread(handleClient, session, client).detach();
  }
  close(fd);
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    if (session->serverFd == fd) {
      session->serverFd = -1;
    }
  }
}

} // namespace

NuvioMediaProxy::NuvioMediaProxy() {
  // Self-check at module load: the child process must be able to resolve the
  // bundled FFmpeg libraries. The report is written to /tmp so it can be read
  // back from the device without having to start playback.
  std::string output;
  std::string errorOutput;
  const int code = runCapture({FFPROBE_BIN, "-version"}, output, errorOutput, 8192);
  std::ofstream report("/tmp/nuvio-selftest.log", std::ios::trunc);
  report << "code=" << code << "\n"
         << "output=" << output.substr(0, 512) << "\n"
         << "error=" << errorOutput.substr(0, 2048) << "\n";
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
  const double sourceTotalBytes = valueOr<double>(config, "totalBytes", 0);
  const double startTimeSec = valueOr<double>(config, "startTimeSec", 0);
  const double maxDiskBytesValue =
      valueOr<double>(config, "maxDiskBytes", static_cast<double>(DEFAULT_MAX_DISK_BYTES));

  JSObject result;
  result["localUrl"] = std::string("");
  result["port"] = 0.0;
  result["cachePath"] = std::string("");
  result["logPath"] = std::string("");
  result["sourceBytes"] = 0.0;
  if (sessionId.empty() || url.empty()) {
    result["error"] = std::string("Missing sessionId or url");
    return result;
  }

  {
    std::lock_guard<std::mutex> lock(gSessionsMutex);
    const auto existing = gSessions.find(sessionId);
    if (existing != gSessions.end()) {
      result["localUrl"] = existing->second->localUrl;
      result["port"] = static_cast<double>(existing->second->port);
      result["cachePath"] = existing->second->cachePath;
      result["logPath"] = existing->second->logPath;
      result["sourceBytes"] = existing->second->sourceTotalBytes;
      return result;
    }
  }

  auto session = std::make_shared<ProxySession>();
  session->id = sessionId;
  session->url = url;
  session->headers = headers;
  session->sourceTotalBytes = sourceTotalBytes;
  session->startTimeSec = std::max<double>(0, startTimeSec);
  session->maxDiskBytes = maxDiskBytesValue > 0
      ? static_cast<long long>(maxDiskBytesValue)
      : DEFAULT_MAX_DISK_BYTES;
  const std::string idPart = safeSessionId(sessionId);
  session->cachePath = "/tmp/nuvio-proxy-" + idPart + ".mkv";
  session->logPath = "/tmp/nuvio-proxy-" + idPart + ".log";
  unlink(session->cachePath.c_str());
  unlink(session->logPath.c_str());

  int videoIndex = -1;
  std::vector<int> audioIndexes;
  bool useAllAudio = true;
  double sourceBytes = 0;
  double estimatedTotalBytes = sourceTotalBytes;
  std::string selectError;
  selectTracks(url, headers, sourceTotalBytes, videoIndex, audioIndexes, useAllAudio,
               sourceBytes, estimatedTotalBytes, selectError);
  if (!selectError.empty()) {
    result["error"] = selectError;
    return result;
  }
  session->sourceTotalBytes = sourceBytes > 0 ? sourceBytes : sourceTotalBytes;
  session->estimatedTotalBytes = estimatedTotalBytes;

  std::vector<std::string> ffmpegArgv = {
      FFMPEG_BIN, "-hide_banner", "-loglevel", "error", "-nostdin", "-y"};
  if (!headers.empty()) {
    ffmpegArgv.push_back("-headers");
    ffmpegArgv.push_back(headers);
  }
  if (session->startTimeSec > 0) {
    ffmpegArgv.push_back("-ss");
    std::ostringstream startText;
    startText << std::fixed << session->startTimeSec;
    ffmpegArgv.push_back(startText.str());
  }
  ffmpegArgv.push_back("-i");
  ffmpegArgv.push_back(url);
  ffmpegArgv.push_back("-map");
  ffmpegArgv.push_back(videoIndex >= 0 ? "0:" + std::to_string(videoIndex) : "0:v:0");
  if (useAllAudio) {
    ffmpegArgv.push_back("-map");
    ffmpegArgv.push_back("0:a?");
  } else {
    for (const int index : audioIndexes) {
      ffmpegArgv.push_back("-map");
      ffmpegArgv.push_back("0:" + std::to_string(index));
    }
  }
  ffmpegArgv.push_back("-map");
  ffmpegArgv.push_back("0:s?");
  ffmpegArgv.push_back("-c:v");
  ffmpegArgv.push_back("copy");
  ffmpegArgv.push_back("-c:a");
  ffmpegArgv.push_back("copy");
  ffmpegArgv.push_back("-c:s");
  ffmpegArgv.push_back("copy");
  // No SeekHead/Cues pointing at the end of a still-growing file: the native
  // player would request those byte ranges before preroll and give up.
  ffmpegArgv.push_back("-write_index");
  ffmpegArgv.push_back("0");
  ffmpegArgv.push_back("-f");
  ffmpegArgv.push_back("matroska");
  ffmpegArgv.push_back("pipe:1");

  const pid_t pid = fork();
  if (pid < 0) {
    result["error"] = std::string("Unable to start ffmpeg");
    return result;
  }
  if (pid == 0) {
    int input = open("/dev/null", O_RDONLY);
    if (input >= 0) {
      dup2(input, STDIN_FILENO);
      close(input);
    }
    int output = open(session->cachePath.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (output >= 0) {
      dup2(output, STDOUT_FILENO);
      close(output);
    }
    int log = open(session->logPath.c_str(), O_WRONLY | O_CREAT | O_APPEND, 0644);
    if (log >= 0) {
      dup2(log, STDERR_FILENO);
      close(log);
    }
    execChild(ffmpegArgv);
  }
  session->ffmpegPid = pid;

  session->serverThread = std::thread(serverLoop, session);
  session->monitorThread = std::thread(monitorProcess, session);

  {
    std::unique_lock<std::mutex> lock(session->mutex);
    session->cv.wait_for(lock, std::chrono::seconds(5), [&session] { return session->ready; });
  }
  if (!session->ready) {
    {
      std::lock_guard<std::mutex> lock(session->mutex);
      session->stopping = true;
    }
    kill(session->ffmpegPid, SIGTERM);
    if (session->serverThread.joinable()) {
      session->serverThread.join();
    }
    if (session->monitorThread.joinable()) {
      session->monitorThread.join();
    }
    unlink(session->cachePath.c_str());
    result["error"] = std::string("Local range server failed to start");
    return result;
  }

  {
    std::lock_guard<std::mutex> lock(gSessionsMutex);
    gSessions[sessionId] = session;
  }

  result["localUrl"] = session->localUrl;
  result["port"] = static_cast<double>(session->port);
  result["cachePath"] = session->cachePath;
  result["logPath"] = session->logPath;
  result["sourceBytes"] = session->sourceTotalBytes;
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
  {
    std::lock_guard<std::mutex> lock(session->mutex);
    session->stopping = true;
  }
  session->cv.notify_all();
  if (session->serverFd >= 0) {
    shutdown(session->serverFd, SHUT_RDWR);
  }
  if (session->ffmpegPid > 0) {
    kill(session->ffmpegPid, SIGTERM);
  }
  if (session->serverThread.joinable()) {
    session->serverThread.join();
  }
  if (session->monitorThread.joinable()) {
    session->monitorThread.join();
  }
  unlink(session->cachePath.c_str());
  unlink(session->logPath.c_str());
  return true;
}

JSObject NuvioMediaProxy::proxyStatus(std::string sessionId) {
  JSObject result;
  result["state"] = std::string("missing");
  result["bytesWritten"] = 0.0;
  result["diskBytes"] = 0.0;
  result["punchedBytes"] = 0.0;
  result["exitCode"] = 0.0;
  result["error"] = std::string("");
  result["needsRestart"] = false;
  {
    std::ifstream report("/tmp/nuvio-selftest.log");
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
  const long long size = std::max<long long>(fileSize(session->cachePath), 0);
  result["bytesWritten"] = static_cast<double>(size);
  result["diskBytes"] = static_cast<double>(std::max<long long>(0, size - session->punchedUpTo));
  result["punchedBytes"] = static_cast<double>(session->punchedUpTo);
  result["exitCode"] = static_cast<double>(session->ffmpegExitCode);
  result["error"] = session->error;
  result["needsRestart"] = session->needsRestart;
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
  return readTail(session->logPath, 16 * 1024);
}

} // namespace nuviomediaproxyTurboModule
