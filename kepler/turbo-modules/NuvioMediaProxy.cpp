#include "NuvioMediaProxy.h"

#include <algorithm>
#include <cerrno>
#include <cctype>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <csignal>
#include <cstring>
#include <fcntl.h>
#include <fstream>
#include <linux/falloc.h>
#include <map>
#include <memory>
#include <mutex>
#include <netinet/in.h>
#include <sstream>
#include <string>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <thread>
#include <type_traits>
#include <unistd.h>
#include <vector>

namespace nuviomediaproxyTurboModule {

namespace {

using com::amazon::kepler::turbomodule::JSObject;

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

bool runCapture(const std::vector<std::string>& argv, std::string& output, size_t maxBytes) {
  int pipefd[2];
  if (pipe(pipefd) != 0) {
    return false;
  }
  const pid_t pid = fork();
  if (pid < 0) {
    close(pipefd[0]);
    close(pipefd[1]);
    return false;
  }
  if (pid == 0) {
    close(pipefd[0]);
    dup2(pipefd[1], STDOUT_FILENO);
    close(pipefd[1]);
    int devNull = open("/dev/null", O_RDONLY);
    if (devNull >= 0) {
      dup2(devNull, STDIN_FILENO);
      close(devNull);
    }
    auto pointers = argvPointers(const_cast<std::vector<std::string>&>(argv));
    execvp(pointers[0], pointers.data());
    _exit(127);
  }
  close(pipefd[1]);
  char buffer[4096];
  while (output.size() < maxBytes) {
    const ssize_t count = read(
        pipefd[0], buffer,
        std::min<size_t>(sizeof(buffer), maxBytes - output.size()));
    if (count <= 0) {
      break;
    }
    output.append(buffer, static_cast<size_t>(count));
  }
  close(pipefd[0]);
  int status = 0;
  while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {
  }
  return WIFEXITED(status) && WEXITSTATUS(status) == 0;
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
      "ffprobe", "-v", "error", "-show_entries",
      "stream=index,codec_name,codec_type,bit_rate:format=bit_rate,size",
      "-of", "csv=p=0"};
  if (!headers.empty()) {
    probeArgv.push_back("-headers");
    probeArgv.push_back(headers);
  }
  probeArgv.push_back(url);

  std::string output;
  if (!runCapture(probeArgv, output, 256 * 1024)) {
    error = "ffprobe failed for media source";
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

    int index = -1;
    try {
      index = std::stoi(trim(first));
    } catch (...) {
      // Format section: bit_rate,size.
      formatBitrate = parseBitrate(first);
      sourceBytes = parseBitrate(second);
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
  if (effectiveSourceBytes > 0 && totalBitrate > 0 && selectedBitrate > 0) {
    double estimate = effectiveSourceBytes * selectedBitrate / totalBitrate;
    estimate = std::min(estimate, effectiveSourceBytes);
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
  } else if (end < 0 || end >= total) {
    end = total - 1;
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

NuvioMediaProxy::NuvioMediaProxy() = default;

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
  const std::string headers = valueOr<std::string>(config, "headers", "");
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
      "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y"};
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
    auto pointers = argvPointers(ffmpegArgv);
    execvp(pointers[0], pointers.data());
    _exit(127);
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
