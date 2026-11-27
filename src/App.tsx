import {WebView} from '@amazon-devices/webview';
import * as React from 'react';
import {useCallback, useRef, useState} from 'react';
import {BackHandler, Dimensions, StyleSheet, View} from 'react-native';
import {
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
} from '@amazon-devices/react-native-kepler';
import {Video} from '@amazon-devices/react-native-w3cmedia';
import NuvioMediaProxy from './turbo-modules/nuviomediaproxy';
import {formatProxyHeaders} from './mediaSourceProbe';
import {
  SslErrorData,
  WebViewErrorEvent,
  WebViewHttpErrorEvent,
  WebViewMessageEvent,
  WebViewNavigationEvent,
} from '@amazon-devices/webview/dist/types/WebViewTypes';

const INJECTED_PRELOAD_JS = `
  (function () {
    window.__NUVIO_PLATFORM__ = "vega";
    window.__NUVIO_VEGA_EVENT_QUEUE__ = window.__NUVIO_VEGA_EVENT_QUEUE__ || [];
    window.__NUVIO_VEGA_DELIVER_EVENT__ = function (eventObj) {
      var bridge = window.__NUVIO_VEGA_PLAYER__;
      if (bridge && typeof bridge._handleNativeEvent === "function") {
        try {
          bridge._handleNativeEvent(eventObj);
          return true;
        } catch (error) {
          window.__NUVIO_VEGA_EVENT_QUEUE__.push({event: eventObj, error: String(error)});
        }
      } else {
        window.__NUVIO_VEGA_EVENT_QUEUE__.push({event: eventObj});
      }
      if (window.__NUVIO_VEGA_EVENT_QUEUE__.length > 20) {
        window.__NUVIO_VEGA_EVENT_QUEUE__.shift();
      }
      return false;
    };
    window.__NUVIO_VEGA_DRAIN_EVENTS__ = function () {
      var queue = window.__NUVIO_VEGA_EVENT_QUEUE__ || [];
      window.__NUVIO_VEGA_EVENT_QUEUE__ = [];
      queue.forEach(function (entry) {
        if (!entry || !entry.event) return;
        try { window.__NUVIO_VEGA_DELIVER_EVENT__(entry.event); } catch (_) {}
      });
      return true;
    };
  })();
  true;
`;

const {width: WINDOW_WIDTH, height: WINDOW_HEIGHT} = Dimensions.get('window');

const NATIVE_PREROLL_TIMEOUT_MS = 15000;
const MAX_NATIVE_LOGS = 40;
const PROXY_MAX_DISK_BYTES = 768 * 1024 * 1024;
const MAX_PROXY_LOG_CHARS = 8000;
const WEBVIEW_MAIN_URL = 'file:///pkg/assets/web/index.html';

/**
 * WebView onError/onHttpError also fires for failed subresources (poster images,
 * thumbnails, fonts). Those are not playback failures: only the app document
 * loading problem should be escalated to the player error screen.
 */
export const isMainWebviewDocument = (url?: string | null): boolean => {
  if (!url) {
    return true;
  }
  const normalized = url.split(/[?#]/)[0];
  return normalized === WEBVIEW_MAIN_URL || normalized === 'about:blank';
};

export const App = () => {
  const webRef = useRef<any>(null);
  const videoRef = useRef<any>(null);
  const [videoUrl, setVideoUrl] = useState<string>('');
  // Only proxy URLs may reach <Video>. A source is prepared first, then the
  // native player is mounted with the local URL as its initial src.
  const [sourcePendingToken, setSourcePendingToken] = useState<number>(0);
  const [playbackKey, setPlaybackKey] = useState<number>(0);
  const customHeadersRef = useRef<Record<string, string> | null>(null);

  // Every source is routed through the on-device proxy. The native player only
  // ever sees http://127.0.0.1:<port>/stream.mkv, never the remote URL.
  const proxySessionRef = useRef<string | null>(null);
  const lastProxySessionRef = useRef<string | null>(null);
  const proxyPollRef = useRef<any>(null);
  const proxyLogTailRef = useRef<string>('');
  const restartProxyAtRef = useRef<
    (timeSec: number, headersOverride?: Record<string, string> | null, notifySeeked?: boolean) => Promise<void>
  >(async () => {});

  const sourceUrlRef = useRef<string>('');
  const sourceHeadersRef = useRef<Record<string, string> | null>(null);
  const sourceTotalBytesRef = useRef<number>(0);
  // ffmpeg starts each remux at time 0, so positions reported to the web UI
  // must be offset by the requested source start time.
  const sourceBaseTimeRef = useRef<number>(0);

  const pendingSourceRef = useRef<{
    url: string;
    headers: Record<string, string> | null;
    generation: number;
  } | null>(null);
  const sourceGenerationRef = useRef<number>(0);
  const preparingSourceRef = useRef<boolean>(false);
  const [showCaptions, setShowCaptions] = useState<boolean>(true);
  const seekTimeoutRef = useRef<any>(null);
  const prerollWatchdogRef = useRef<any>(null);
  const hasPlayedOrCanPlayRef = useRef<boolean>(false);
  const isSeekingRef = useRef<boolean>(false);
  const targetSeekSecRef = useRef<number>(0);
  const targetLocalSecRef = useRef<number>(0);
  const nativeLogsRef = useRef<Array<string>>([]);
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  const pushNativeLog = useCallback((tag: string, detail?: string) => {
    try {
      const target = videoRef.current;
      const rs = target?.readyState ?? '-';
      const ns = target?.networkState ?? '-';
      const ts = new Date().toISOString().slice(11, 23);
      const entry = `${ts} [${tag}] rs=${rs} ns=${ns}${detail ? ` ${detail}` : ''}`;
      console.info(`[VegaPlayer] ${entry}`);
      const logs = nativeLogsRef.current;
      logs.push(entry);
      if (logs.length > MAX_NATIVE_LOGS) {
        logs.splice(0, logs.length - MAX_NATIVE_LOGS);
      }
    } catch (_) {
      // Ignore logging errors.
    }
  }, []);

  const clearPrerollWatchdog = useCallback(() => {
    if (prerollWatchdogRef.current) {
      clearTimeout(prerollWatchdogRef.current);
      prerollWatchdogRef.current = null;
    }
  }, []);

  const captureProxyLog = useCallback(() => {
    const sessionId = proxySessionRef.current || lastProxySessionRef.current;
    if (!sessionId) {
      return;
    }
    try {
      const log = NuvioMediaProxy.readProxyLog(sessionId);
      if (log) {
        proxyLogTailRef.current = log.slice(-MAX_PROXY_LOG_CHARS);
      }
    } catch (err: any) {
      console.warn('[VegaPlayer] readProxyLog failed:', err);
    }
  }, []);

  const stopProxyPolling = useCallback(() => {
    if (proxyPollRef.current) {
      clearInterval(proxyPollRef.current);
      proxyPollRef.current = null;
    }
  }, []);

  const stopProxyPlayback = useCallback(() => {
    stopProxyPolling();
    const sessionId = proxySessionRef.current;
    proxySessionRef.current = null;
    if (sessionId) {
      captureProxyLog();
      lastProxySessionRef.current = sessionId;
      try {
        NuvioMediaProxy.stopProxy(sessionId);
        pushNativeLog('proxy_stopped', `session=${sessionId}`);
      } catch (err: any) {
        console.warn('[VegaPlayer] stopProxy failed:', err);
      }
    }
  }, [captureProxyLog, pushNativeLog, stopProxyPolling]);

  const sendEventToWeb = useCallback((eventObj: any) => {
    try {
      const serialized = JSON.stringify(eventObj);
      const script = `try { window.__NUVIO_VEGA_DELIVER_EVENT__ && window.__NUVIO_VEGA_DELIVER_EVENT__(${serialized}); } catch(_) {}; true;`;
      if (webRef.current?.injectJavaScript) {
        webRef.current.injectJavaScript(script);
      }
    } catch (e) {
      console.warn('[Vega] sendEventToWeb error:', e);
    }
  }, []);

  const extractAudioTracks = useCallback(() => {
    const tracks: Array<{index: number; id: string; kind: string; label: string; language: string; enabled: boolean}> = [];
    try {
      const list = videoRef.current?.audioTracks;
      if (list && typeof list.length === 'number') {
        for (let i = 0; i < list.length; i++) {
          const item = list[i];
          if (item) {
            tracks.push({
              index: i,
              id: item.id || String(i),
              kind: item.kind || 'main',
              label: item.label || item.language || '',
              language: item.language || 'und',
              enabled: Boolean(item.enabled),
            });
          }
        }
      }
    } catch (e) {
      console.warn('[Vega] extractAudioTracks error:', e);
    }
    return tracks;
  }, []);

  const extractTextTracks = useCallback(() => {
    const tracks: Array<{index: number; label: string; language: string; mode: string}> = [];
    try {
      const list = videoRef.current?.textTracks;
      if (list && typeof list.length === 'number') {
        for (let i = 0; i < list.length; i++) {
          const item = list[i];
          if (item) {
            tracks.push({
              index: i,
              label: item.label || item.language || `Subtitle ${i + 1}`,
              language: item.language || 'und',
              mode: item.mode || 'disabled',
            });
          }
        }
      }
    } catch (e) {
      console.warn('[Vega] extractTextTracks error:', e);
    }
    return tracks;
  }, []);

  const forwardNativeError = useCallback(
    (reason: string, message: string, code: number = 4, extra: Record<string, any> = {}) => {
      const target = videoRef.current;
      const diagnosticLogs = [...nativeLogsRef.current];
      pushNativeLog('forwardError', `${reason}: ${message}`);
      sendEventToWeb({
        name: 'error',
        error: message,
        code,
        details: {
          reason,
          message,
          code,
          readyState: target?.readyState ?? 0,
          networkState: target?.networkState ?? 0,
          duration: target?.duration ?? 0,
          audioTracks: extractAudioTracks(),
          textTracks: extractTextTracks(),
          diagnosticLogs,
          proxyLog: proxyLogTailRef.current,
          sourceUrl: sourceUrlRef.current,
          ...extra,
        },
      });
    },
    [extractAudioTracks, extractTextTracks, pushNativeLog, sendEventToWeb],
  );

  const reportNativeActionFailure = useCallback(
    (action: string, err: any) => {
      const message = err?.message || err?.name || String(err || `${action} failed`);
      console.warn(`[VegaPlayer] ${action} failed:`, err);
      forwardNativeError('native-action-failure', `${action}: ${message}`, 4, {action});
    },
    [forwardNativeError],
  );

  const reportedTime = useCallback(() => {
    const value = Number(videoRef.current?.currentTime ?? 0);
    return Number.isFinite(value)
      ? sourceBaseTimeRef.current + Math.max(0, value)
      : sourceBaseTimeRef.current;
  }, []);

  const reportedDuration = useCallback(() => {
    const value = Number(videoRef.current?.duration ?? 0);
    if (!Number.isFinite(value) || value <= 0) {
      return 0;
    }
    return sourceBaseTimeRef.current + value;
  }, []);

  const startPrerollWatchdog = useCallback(
    (url: string) => {
      clearPrerollWatchdog();
      prerollWatchdogRef.current = setTimeout(() => {
        prerollWatchdogRef.current = null;
        if (hasPlayedOrCanPlayRef.current) {
          return;
        }
        const target = videoRef.current;
        // Do not treat readyState >= 2 as success: the GStreamer pipeline can
        // expose metadata and then stall forever before canplay/playing.
        pushNativeLog(
          'preroll_timeout',
          `dur=${target?.duration ?? '-'} audio=${extractAudioTracks().length}`,
        );
        console.warn('[VegaPlayer] Native preroll timeout:', {
          url,
          readyState: Number(target?.readyState ?? 0),
          networkState: Number(target?.networkState ?? 0),
          duration: target?.duration,
          diagnosticLogs: [...nativeLogsRef.current],
        });
        try {
          target?.pause?.();
        } catch (_) {
          // The watchdog still reports the original failure if pausing fails.
        }
        forwardNativeError(
          'native-preroll-timeout',
          'Vega native player preroll timeout (pipeline stalled before canplay)',
          4,
          {
            url,
            readyState: Number(target?.readyState ?? 0),
            networkState: Number(target?.networkState ?? 0),
            duration: target?.duration ?? 0,
            audioTracks: extractAudioTracks(),
            textTracks: extractTextTracks(),
          },
        );
      }, NATIVE_PREROLL_TIMEOUT_MS);
    },
    [clearPrerollWatchdog, extractAudioTracks, extractTextTracks, forwardNativeError, pushNativeLog],
  );

  const startProxySession = useCallback(
    async (
      url: string,
      headers: Record<string, string> | null,
      totalBytes: number,
      startTimeSec: number,
      generation: number,
    ) => {
      const sessionId = `nuvio-${Date.now()}-${generation}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      pushNativeLog(
        'proxy_start',
        `time=${startTimeSec.toFixed(1)} total=${totalBytes} headers=${Object.keys(headers || {}).join(',')}`,
      );
      const result = NuvioMediaProxy.startProxy({
        sessionId,
        url,
        headers: formatProxyHeaders(headers),
        totalBytes,
        startTimeSec,
        maxDiskBytes: PROXY_MAX_DISK_BYTES,
      });
      if (result?.error || !result?.localUrl) {
        throw new Error(result?.error || 'Proxy did not return a local URL');
      }
      if (generation !== sourceGenerationRef.current) {
        NuvioMediaProxy.stopProxy(sessionId);
        return null;
      }
      pushNativeLog(
        'proxy_ready',
        `port=${result.port} path=${result.cachePath} source=${result.sourceBytes ?? 0}`,
      );
      return {
        sessionId,
        localUrl: result.localUrl,
        sourceBytes: Number(result.sourceBytes ?? 0),
      };
    },
    [pushNativeLog],
  );

  const startProxyPolling = useCallback(
    (sessionId: string, generation: number, url: string) => {
      stopProxyPolling();
      proxyPollRef.current = setInterval(() => {
        if (generation !== sourceGenerationRef.current || sessionId !== proxySessionRef.current) {
          stopProxyPolling();
          return;
        }
        try {
          const status = NuvioMediaProxy.proxyStatus(sessionId);
          if (status?.needsRestart) {
            stopProxyPolling();
            clearPrerollWatchdog();
            restartProxyAtRef.current(reportedTime());
            return;
          }
          const failed =
            Boolean(status?.error) ||
            (status?.state === 'complete' && Number(status?.exitCode ?? 0) !== 0);
          if (failed) {
            stopProxyPolling();
            clearPrerollWatchdog();
            captureProxyLog();
            stopProxyPlayback();
            forwardNativeError('proxy-stream-failed', status?.error || `Proxy stream failed (exit ${status?.exitCode ?? 'unknown'})`, 4, {
              url,
              diskBytes: status?.diskBytes ?? 0,
              exitCode: status?.exitCode ?? 0,
            });
          }
        } catch (err: any) {
          console.warn('[VegaPlayer] proxyStatus failed:', err);
        }
      }, 1000);
    },
    [
      captureProxyLog,
      clearPrerollWatchdog,
      forwardNativeError,
      reportedTime,
      stopProxyPlayback,
      stopProxyPolling,
    ],
  );

  const applyProxySource = useCallback(
    async (
      url: string,
      headers: Record<string, string> | null,
      totalBytes: number,
      startTimeSec: number,
      generation: number,
    ) => {
      stopProxyPlayback();
      const session = await startProxySession(url, headers, totalBytes, startTimeSec, generation);
      if (!session || generation !== sourceGenerationRef.current) {
        return;
      }
      proxySessionRef.current = session.sessionId;
      lastProxySessionRef.current = session.sessionId;
      sourceBaseTimeRef.current = startTimeSec;
      sourceUrlRef.current = url;
      sourceHeadersRef.current = headers;
      sourceTotalBytesRef.current = session.sourceBytes || totalBytes;
      hasPlayedOrCanPlayRef.current = false;
      targetLocalSecRef.current = 0;
      // Mount the native player directly on the proxy URL. It must never see
      // the remote URL, not even for a single frame while ffprobe runs.
      setPlaybackKey(prev => prev + 1);
      setVideoUrl(session.localUrl);
      startPrerollWatchdog(url);
      startProxyPolling(session.sessionId, generation, url);
    },
    [startPrerollWatchdog, startProxyPolling, startProxySession, stopProxyPlayback],
  );

  const restartProxyAt = useCallback(
    async (
      timeSec: number,
      headersOverride?: Record<string, string> | null,
      notifySeeked: boolean = false,
    ) => {
      const url = sourceUrlRef.current;
      if (!url) {
        return;
      }
      const headers =
        headersOverride !== undefined ? headersOverride : sourceHeadersRef.current;
      sourceHeadersRef.current = headers;
      const generation = sourceGenerationRef.current;
      try {
        await applyProxySource(
          url,
          headers,
          sourceTotalBytesRef.current,
          Math.max(0, timeSec),
          generation,
        );
        if (notifySeeked && generation === sourceGenerationRef.current) {
          sendEventToWeb({name: 'seeked', currentTime: timeSec});
        }
      } catch (err: any) {
        if (generation !== sourceGenerationRef.current) {
          return;
        }
        const message = err?.message || String(err || 'proxy restart failed');
        pushNativeLog('proxy_restart_failed', message);
        stopProxyPlayback();
        forwardNativeError('proxy-restart-failed', message, 4, {url, timeSec});
      }
    },
    [applyProxySource, forwardNativeError, pushNativeLog, sendEventToWeb, stopProxyPlayback],
  );
  restartProxyAtRef.current = restartProxyAt;

  const prepareSource = useCallback(async () => {
    const pending = pendingSourceRef.current;
    if (!pending) {
      return;
    }
    pendingSourceRef.current = null;
    const {url, headers, generation} = pending;
    if (generation !== sourceGenerationRef.current) {
      return;
    }
    preparingSourceRef.current = true;
    try {
      pushNativeLog('source_probe', 'proxy owns ffprobe/ffmpeg; no direct source probe');
      await applyProxySource(url, headers, 0, 0, generation);
    } catch (err: any) {
      if (generation !== sourceGenerationRef.current) {
        return;
      }
      clearPrerollWatchdog();
      const message = err?.message || String(err || 'proxy setup failed');
      pushNativeLog('proxy_failed', message);
      stopProxyPlayback();
      forwardNativeError('proxy-start-failed', message, 4, {url});
    } finally {
      if (generation === sourceGenerationRef.current) {
        preparingSourceRef.current = false;
      }
    }
  }, [
    applyProxySource,
    clearPrerollWatchdog,
    forwardNativeError,
    pushNativeLog,
    stopProxyPlayback,
  ]);

  const openSource = useCallback(
    (url: string, incomingHeaders: Record<string, string> | null) => {
      clearPrerollWatchdog();
      stopProxyPlayback();
      if (seekTimeoutRef.current) {
        clearTimeout(seekTimeoutRef.current);
        seekTimeoutRef.current = null;
      }
      sourceGenerationRef.current += 1;
      preparingSourceRef.current = false;
      hasPlayedOrCanPlayRef.current = false;
      isSeekingRef.current = false;
      nativeLogsRef.current = [];
      proxyLogTailRef.current = '';
      const headers =
        incomingHeaders && Object.keys(incomingHeaders).length > 0 ? incomingHeaders : null;
      customHeadersRef.current = headers;
      sourceUrlRef.current = url;
      sourceHeadersRef.current = headers;
      sourceBaseTimeRef.current = 0;
      sourceTotalBytesRef.current = 0;
      pendingSourceRef.current = {
        url,
        headers,
        generation: sourceGenerationRef.current,
      };
      pushNativeLog('open', `hasHeaders=${Boolean(headers)}`);
      setPlaybackKey(prev => prev + 1);
      // Unmount any old native player immediately; the new one is mounted only
      // after the proxy returns its local URL.
      setVideoUrl('');
      setSourcePendingToken(prev => prev + 1);
    },
    [clearPrerollWatchdog, pushNativeLog, stopProxyPlayback],
  );

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const payload = JSON.parse(event.nativeEvent.data);
        if (payload?.type === 'NUVIO_EXIT_APP') {
          BackHandler.exitApp();
          return;
        }

        if (payload?.type === 'NUVIO_WAKE_LOCK') {
          console.info('[Vega] NUVIO_WAKE_LOCK:', payload.active);
          return;
        }

        if (payload?.type === 'NUVIO_VEGA_PLAYER') {
          const {action} = payload;

          switch (action) {
            case 'open':
              if (payload.url) {
                openSource(payload.url, payload.headers || null);
              } else {
                forwardNativeError('native-open-invalid-url', 'Native player received an empty playback URL', 4);
              }
              break;
            case 'setHeaders':
              if (payload.headers && typeof payload.headers === 'object') {
                const merged = {...(customHeadersRef.current || {}), ...payload.headers};
                if (Object.keys(merged).length > 0) {
                  customHeadersRef.current = merged;
                  if (pendingSourceRef.current) {
                    pendingSourceRef.current.headers = merged;
                    sourceHeadersRef.current = merged;
                    if (!preparingSourceRef.current) {
                      prepareSource();
                    }
                  } else if (proxySessionRef.current) {
                    restartProxyAt(reportedTime(), merged);
                  }
                  pushNativeLog('setHeaders', `headers=${Object.keys(merged).join(',')}`);
                }
              }
              break;
            case 'prepare':
              if (payload.url && payload.url !== sourceUrlRef.current) {
                openSource(payload.url, payload.headers || customHeadersRef.current);
                break;
              }
              if (payload.headers && typeof payload.headers === 'object') {
                const merged = {...(customHeadersRef.current || {}), ...payload.headers};
                if (Object.keys(merged).length > 0) {
                  const changed =
                    JSON.stringify(merged) !== JSON.stringify(sourceHeadersRef.current || {});
                  customHeadersRef.current = merged;
                  if (pendingSourceRef.current) {
                    pendingSourceRef.current.headers = merged;
                    sourceHeadersRef.current = merged;
                    if (!preparingSourceRef.current) {
                      prepareSource();
                    }
                  } else if (proxySessionRef.current && changed) {
                    restartProxyAt(reportedTime(), merged);
                  }
                }
              }
              pushNativeLog('prepare');
              // Never synthesize canplay from readyState. Only the real Video onCanPlay
              // callback may resolve prepareAsync(); a stalled audio pipeline can expose
              // HAVE_CURRENT_DATA without ever becoming playable.
              break;
            case 'play':
              try {
                videoRef.current?.play()?.catch?.((err: any) => {
                  reportNativeActionFailure('play', err);
                });
              } catch (err: any) {
                reportNativeActionFailure('play', err);
              }
              break;
            case 'pause':
              try {
                videoRef.current?.pause();
              } catch (err) {
                reportNativeActionFailure('pause', err);
              }
              break;
            case 'seek': {
              if (typeof payload.positionMs !== 'number' || !videoRef.current) {
                break;
              }
              const targetSec = Math.max(0, payload.positionMs / 1000);
              targetSeekSecRef.current = targetSec;
              isSeekingRef.current = true;
              if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
              }
              if (!proxySessionRef.current) {
                isSeekingRef.current = false;
                forwardNativeError('native-seek-no-source', 'Seek requested before the proxy source is ready', 4, {
                  targetSec,
                });
                break;
              }
              const relativeSec = targetSec - sourceBaseTimeRef.current;
              const localDuration = Number(videoRef.current.duration ?? 0);
              const withinLocalWindow =
                relativeSec >= -0.5 &&
                (!Number.isFinite(localDuration) || localDuration <= 0 || relativeSec <= localDuration + 0.5);
              if (withinLocalWindow) {
                const localSec = Math.max(0, relativeSec);
                targetLocalSecRef.current = localSec;
                try {
                  videoRef.current.currentTime = localSec;
                } catch (err) {
                  reportNativeActionFailure('seek', err);
                }
                seekTimeoutRef.current = setTimeout(() => {
                  seekTimeoutRef.current = null;
                  if (isSeekingRef.current) {
                    isSeekingRef.current = false;
                    sendEventToWeb({name: 'seeked', currentTime: reportedTime()});
                  }
                }, 300);
              } else {
                // The requested position is outside the cached window. Restart
                // ffmpeg from that source time instead of seeking into a hole.
                isSeekingRef.current = false;
                targetLocalSecRef.current = 0;
                restartProxyAt(targetSec, undefined, true);
              }
              break;
            }
            case 'selectAudioTrack':
              if (videoRef.current?.audioTracks && typeof payload.index === 'number') {
                try {
                  const list = videoRef.current.audioTracks;
                  for (let i = 0; i < list.length; i++) {
                    if (list[i]) {
                      list[i].enabled = i === payload.index;
                    }
                  }
                  sendEventToWeb({
                    name: 'audiotracks',
                    audioTracks: extractAudioTracks(),
                  });
                } catch (err) {
                  reportNativeActionFailure('selectAudioTrack', err);
                }
              }
              break;
            case 'selectTextTrack':
              if (videoRef.current?.textTracks && typeof payload.index === 'number') {
                try {
                  const list = videoRef.current.textTracks;
                  setShowCaptions(true);
                  for (let i = 0; i < list.length; i++) {
                    if (list[i]) {
                      list[i].mode = i === payload.index ? 'showing' : 'disabled';
                    }
                  }
                  sendEventToWeb({
                    name: 'texttracks',
                    textTracks: extractTextTracks(),
                  });
                } catch (err) {
                  reportNativeActionFailure('selectTextTrack', err);
                }
              }
              break;
            case 'setSilentSubtitle':
              try {
                const silent = Boolean(payload.silent);
                setShowCaptions(!silent);
                const list = videoRef.current?.textTracks;
                if (list && typeof list.length === 'number') {
                  for (let i = 0; i < list.length; i++) {
                    if (list[i] && silent) {
                      list[i].mode = 'disabled';
                    }
                  }
                }
                sendEventToWeb({
                  name: 'texttracks',
                  textTracks: extractTextTracks(),
                });
              } catch (err) {
                reportNativeActionFailure('setSilentSubtitle', err);
              }
              break;
            case 'rate':
              if (typeof payload.rate === 'number' && videoRef.current) {
                try {
                  videoRef.current.playbackRate = payload.rate;
                } catch (err) {
                  reportNativeActionFailure('rate', err);
                }
              }
              break;
            case 'stop':
              clearPrerollWatchdog();
              pushNativeLog('stop');
              try {
                videoRef.current?.pause();
              } catch (err) {
                reportNativeActionFailure('stop', err);
              }
              break;
            case 'close':
              clearPrerollWatchdog();
              stopProxyPlayback();
              sourceGenerationRef.current += 1;
              preparingSourceRef.current = false;
              pendingSourceRef.current = null;
              hasPlayedOrCanPlayRef.current = false;
              isSeekingRef.current = false;
              nativeLogsRef.current = [];
              proxyLogTailRef.current = '';
              pushNativeLog('close');
              if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
                seekTimeoutRef.current = null;
              }
              setVideoUrl('');
              customHeadersRef.current = null;
              sourceUrlRef.current = '';
              sourceHeadersRef.current = null;
              sourceBaseTimeRef.current = 0;
              sourceTotalBytesRef.current = 0;
              break;
          }
        }
      } catch (_) {
        // Ignore non-JSON messages from web content.
      }
    },
    [
      clearPrerollWatchdog,
      extractAudioTracks,
      extractTextTracks,
      forwardNativeError,
      openSource,
      prepareSource,
      pushNativeLog,
      reportedTime,
      reportNativeActionFailure,
      restartProxyAt,
      sendEventToWeb,
      stopProxyPlayback,
    ],
  );

  React.useEffect(() => {
    try {
      const diagnostic = NuvioMediaProxy.proxyStatus('__diagnostic__') as {
        selfTest?: string;
      };
      console.log('[Vega][selftest]', diagnostic?.selfTest ?? 'missing');
    } catch (e) {
      console.warn('[Vega][selftest] unavailable', e);
    }
  }, []);

  React.useEffect(() => {
    if (sourcePendingToken > 0) {
      prepareSource();
    }
  }, [sourcePendingToken, prepareSource]);

  React.useEffect(() => {
    return () => {
      clearPrerollWatchdog();
      stopProxyPlayback();
      if (seekTimeoutRef.current) {
        clearTimeout(seekTimeoutRef.current);
        seekTimeoutRef.current = null;
      }
    };
  }, [clearPrerollWatchdog, stopProxyPlayback]);

  return (
    <View style={styles.container}>
      {videoUrl ? (
        <View style={styles.nativeVideoContainer}>
          <Video
            ref={videoRef}
            key={`${playbackKey}:${videoUrl}`}
            src={videoUrl}
            autoplay={true}
            preload="auto"
            width={WINDOW_WIDTH || 1920}
            height={WINDOW_HEIGHT || 1080}
            controls={false}
            playsInline={true}
            showCaptions={showCaptions}
            scalingmode="fit"
            onComponentDidMount={() => {
              console.info('[VegaPlayer] onComponentDidMount fired for:', videoUrl);
              pushNativeLog('mount');
              // The source is already proxied at this point. Do not prepare it
              // here: the native Video must never be mounted with a remote URL.
            }}
            onCanPlay={() => {
              hasPlayedOrCanPlayRef.current = true;
              clearPrerollWatchdog();
              pushNativeLog('canplay', `dur=${videoRef.current?.duration ?? '-'}`);
              sendEventToWeb({
                name: 'canplay',
                duration: reportedDuration(),
                currentTime: reportedTime(),
                audioTracks: extractAudioTracks(),
                textTracks: extractTextTracks(),
              });
            }}
            onLoadedMetadata={() => {
              pushNativeLog('loadedmetadata', `dur=${videoRef.current?.duration ?? '-'}`);
              sendEventToWeb({
                name: 'loadedmetadata',
                duration: reportedDuration(),
                audioTracks: extractAudioTracks(),
                textTracks: extractTextTracks(),
              });
            }}
            onPlaying={() => {
              hasPlayedOrCanPlayRef.current = true;
              clearPrerollWatchdog();
              pushNativeLog('playing');
              sendEventToWeb({
                name: 'playing',
                audioTracks: extractAudioTracks(),
                textTracks: extractTextTracks(),
              });
            }}
            onPause={() => {
              pushNativeLog('pause');
              sendEventToWeb({name: 'pause'});
            }}
            onWaiting={() => {
              pushNativeLog('waiting');
              sendEventToWeb({
                name: 'waiting',
                readyState: videoRef.current?.readyState ?? 0,
                networkState: videoRef.current?.networkState ?? 0,
                duration: reportedDuration(),
                diagnosticLogs: [...nativeLogsRef.current],
              });
            }}
            onStalled={() => {
              pushNativeLog('stalled');
              sendEventToWeb({
                name: 'stalled',
                readyState: videoRef.current?.readyState ?? 0,
                networkState: videoRef.current?.networkState ?? 0,
                duration: reportedDuration(),
                diagnosticLogs: [...nativeLogsRef.current],
              });
            }}
            onSeeked={() => {
              if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
                seekTimeoutRef.current = null;
              }
              isSeekingRef.current = false;
              sendEventToWeb({
                name: 'seeked',
                currentTime: reportedTime(),
              });
            }}
            onTimeUpdate={() => {
              const current = videoRef.current?.currentTime;
              if (
                isSeekingRef.current &&
                typeof current === 'number' &&
                Math.abs(current - targetLocalSecRef.current) > 2.0
              ) {
                return;
              }
              sendEventToWeb({
                name: 'timeupdate',
                currentTime: reportedTime(),
                duration: reportedDuration(),
              });
            }}
            onEnded={() => {
              pushNativeLog('ended');
              sendEventToWeb({name: 'ended'});
            }}
            onError={(err: any) => {
              clearPrerollWatchdog();
              if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
                seekTimeoutRef.current = null;
              }
              isSeekingRef.current = false;
              let needsRestart = false;
              try {
                if (proxySessionRef.current) {
                  needsRestart = Boolean(NuvioMediaProxy.proxyStatus(proxySessionRef.current).needsRestart);
                }
              } catch (_) {
                // Fall through to the real media error below.
              }
              if (needsRestart) {
                restartProxyAt(reportedTime(), undefined, true);
                return;
              }
              captureProxyLog();
              stopProxyPlayback();
              const mediaErr = err?.target?.error || videoRef.current?.error;
              const code = mediaErr?.code || (typeof err?.code === 'number' ? err.code : 4);
              const rawMessage =
                mediaErr?.message || err?.message || err?.name || 'Native player error';
              const msg = mediaErr?.code
                ? `${rawMessage} (code ${mediaErr.code})`
                : rawMessage;
              console.error('[Vega Video onError]', msg, err, mediaErr);
              forwardNativeError('native-media-error', msg, code, {
                sourceError: rawMessage,
                errorName: err?.name,
              });
            }}
          />
        </View>
      ) : null}
      <WebView
        ref={webRef}
        style={styles.webview}
        allowFileAccess
        allowSystemKeyEvents
        allowsDefaultMediaControl={false}
        domStorageEnabled
        hasTVPreferredFocus
        javaScriptEnabled
        mediaPlaybackRequiresUserAction={false}
        mixedContentMode="compatibility"
        injectedJavaScriptBeforeContentLoaded={INJECTED_PRELOAD_JS}
        source={{
          uri: 'file:///pkg/assets/web/index.html',
        }}
        onMessage={handleMessage}
        onLoad={(_event: WebViewNavigationEvent) => {
          console.info('Page loading completed...');
          try {
            webRef.current?.injectJavaScript(
              'try { window.__NUVIO_VEGA_DRAIN_EVENTS__ && window.__NUVIO_VEGA_DRAIN_EVENTS__(); } catch (_) {}; true;',
            );
          } catch (e) {
            console.warn('[Vega] drain events failed:', e);
          }
          hideSplashScreenCallback();
        }}
        onLoadStart={(_event: WebViewNavigationEvent) => {
          console.info('Page loading started...');
        }}
        onError={({nativeEvent: {code, url, description}}: WebViewErrorEvent) => {
          const message = description || `WebView failed to load ${url}`;
          console.error(`[onError]: (${code}: ${url}) ${message}`);
          if (!isMainWebviewDocument(url)) {
            return;
          }
          hideSplashScreenCallback();
          forwardNativeError('webview-load-error', message, code || 4, {url});
        }}
        onHttpError={({
          nativeEvent: {url, statusCode: code, description, isMainFrame},
        }: WebViewHttpErrorEvent) => {
          const message = description || `HTTP ${code} while loading ${url}`;
          console.error(`[onHttpError]: (${code}: ${url}) ${message}`);
          if (isMainFrame === false || !isMainWebviewDocument(url)) {
            return;
          }
          hideSplashScreenCallback();
          forwardNativeError('webview-http-error', message, code || 4, {url, isMainFrame});
        }}
        onSslError={(
          {code, url, description}: SslErrorData,
          callback: {proceed: () => void; cancel: () => void},
        ) => {
          const message = description || `SSL error ${code} while loading ${url}`;
          console.error(`[onSslError]: (${code}: ${url}) ${message}`);
          callback?.cancel?.();
          if (!isMainWebviewDocument(url)) {
            return;
          }
          hideSplashScreenCallback();
          forwardNativeError('webview-ssl-error', message, 4, {url});
        }}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: '#000000'},
  nativeVideoContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000000',
    overflow: 'hidden',
    zIndex: 0,
  },
  webview: {flex: 1, backgroundColor: 'transparent', zIndex: 1},
});
