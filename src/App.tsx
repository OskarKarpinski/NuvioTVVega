import {WebView} from '@amazon-devices/webview';
import * as React from 'react';
import {useCallback, useRef, useState} from 'react';
import {BackHandler, Dimensions, StyleSheet, View} from 'react-native';
import {
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
} from '@amazon-devices/react-native-kepler';
import {Video} from '@amazon-devices/react-native-w3cmedia';
import NuvioMediaProxy, {
  MediaProxyStatus,
} from './turbo-modules/nuviomediaproxy';
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

const NATIVE_PREROLL_TIMEOUT_MS = 20000;
const PROGRESS_STALL_MS = 25000;
const STATUS_POLL_MS = 100;
const LOG_POLL_MS = 1500;
const MAX_NATIVE_LOGS = 40;
const MAX_PROXY_LOG_CHARS = 8000;
const WEBVIEW_MAIN_URL = 'file:///pkg/assets/web/index.html';
// Keep the previous local file alive until the native pipeline has opened its
// replacement. Renaming a file that is still open is safe on Linux, but this
// avoids racing a remount with cleanup.
const PROXY_RETIRE_DELAY_MS = 8000;
const MEDIA_ERROR_RETRY_WINDOW_MS = 4000;

type AudioTrackMetadata = {
  index: number;
  language: string;
  title: string;
  sourceCodec: string;
  sourceChannels: string;
  sampleRate: number;
  default: boolean;
};

type RebuildOptions = {
  audioTrackIndex?: number;
  audioTrackCount?: number;
  notifySeeked?: boolean;
};

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
  const [sourcePendingToken, setSourcePendingToken] = useState<number>(0);
  const [playbackKey, setPlaybackKey] = useState<number>(0);
  const [showCaptions, setShowCaptions] = useState<boolean>(true);

  // There is exactly one proxy session per source. The remote URL is fetched
  // once into a complete local master; every seek/audio change rebuilds a
  // second local file from that master. <Video> only ever sees a finished
  // file:// MKV, never a growing file and never the remote URL.
  const proxySessionRef = useRef<string | null>(null);
  const lastProxySessionRef = useRef<string | null>(null);
  const localUrlRef = useRef<string>('');
  const proxyPollRef = useRef<any>(null);
  const audioSignatureRef = useRef<string>('');
  const proxyAudioMetadataRef = useRef<AudioTrackMetadata[]>([]);
  const retiredProxyTimersRef = useRef<any[]>([]);
  const pendingSeekSecRef = useRef<number | null>(null);
  const proxyLogTailRef = useRef<string>('');
  const playbackGenerationRef = useRef<number>(0);
  const prerollRetryRef = useRef<boolean>(false);
  const nativeErrorCountRef = useRef<number>(0);
  const lastNativeErrorAtRef = useRef<number>(0);
  const lastMountAtRef = useRef<number>(0);
  const isSwitchingRef = useRef<boolean>(false);
  const playingRef = useRef<boolean>(false);

  const sourceUrlRef = useRef<string>('');
  const sourceHeadersRef = useRef<Record<string, string> | null>(null);
  const selectedAudioTrackRef = useRef<number>(-1);
  const audioTrackCountRef = useRef<number>(0);
  // ffmpeg resets timestamps to zero for every rebuilt playback file, so all
  // times reported to the web UI are offset by the requested source position.
  const sourceBaseTimeRef = useRef<number>(0);
  const pendingSourceRef = useRef<{
    url: string;
    headers: Record<string, string> | null;
    generation: number;
  } | null>(null);
  const sourceGenerationRef = useRef<number>(0);
  const preparingSourceRef = useRef<boolean>(false);
  const prerollWatchdogRef = useRef<any>(null);
  const hasPlayedOrCanPlayRef = useRef<boolean>(false);
  const nativeLogsRef = useRef<Array<string>>([]);
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  const pushNativeLog = useCallback((tag: string, detail?: string) => {
    try {
      const target = videoRef.current;
      const rs = target?.readyState ?? '-';
      const ns = target?.networkState ?? '-';
      const ts = new Date().toISOString().slice(11, 23);
      const entry = `${ts} [${tag}] rs=${rs} ns=${ns}${
        detail ? ` ${detail}` : ''
      }`;
      console.info(`[VegaPlayer] ${entry}`);
      const logs = nativeLogsRef.current;
      logs.push(entry);
      if (logs.length > MAX_NATIVE_LOGS) {
        logs.splice(0, logs.length - MAX_NATIVE_LOGS);
      }
    } catch (_) {
      // Diagnostics must never break playback.
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

  const stopProxyPlayback = useCallback(
    (delayMs: number = 0) => {
      stopProxyPolling();
      const sessionId = proxySessionRef.current;
      proxySessionRef.current = null;
      if (sessionId) {
        captureProxyLog();
        lastProxySessionRef.current = sessionId;
        pushNativeLog('proxy_stopped', `session=${sessionId} delay=${delayMs}`);
        const retire = () => {
          try {
            NuvioMediaProxy.stopProxy(sessionId);
          } catch (err: any) {
            console.warn('[VegaPlayer] stopProxy failed:', err);
          }
        };
        if (delayMs > 0) {
          const timer = setTimeout(retire, delayMs);
          retiredProxyTimersRef.current.push(timer);
        } else {
          retire();
        }
      }
    },
    [captureProxyLog, pushNativeLog, stopProxyPolling],
  );

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

  const extractAudioTracks = useCallback((selectedIndex?: number) => {
    const tracks: Array<{
      index: number;
      id: string;
      kind: string;
      label: string;
      language: string;
      enabled: boolean;
      title: string;
      codec: string;
      sourceCodec: string;
      sourceChannels: string;
      sampleRate: number;
    }> = [];
    try {
      const list = videoRef.current?.audioTracks;
      const metadata = proxyAudioMetadataRef.current;
      const nativeCount =
        list && typeof list.length === 'number' ? list.length : 0;
      const count = Math.max(nativeCount, metadata.length);
      const requested =
        typeof selectedIndex === 'number' && selectedIndex >= 0
          ? selectedIndex
          : selectedAudioTrackRef.current;
      const defaultIndex = metadata.find((item) => item.default)?.index ?? -1;
      for (let i = 0; i < count; i++) {
        const item = nativeCount > 0 ? list[i] : null;
        const meta = metadata[i];
        if (!item && !meta) {
          continue;
        }
        const enabled =
          requested >= 0
            ? i === requested
            : defaultIndex >= 0
            ? i === defaultIndex
            : Boolean(item?.enabled);
        tracks.push({
          index: i,
          id: item?.id || String(i),
          kind: item?.kind || 'main',
          label:
            meta?.title ||
            item?.label ||
            meta?.language ||
            item?.language ||
            `Track ${i + 1}`,
          language: meta?.language || item?.language || 'und',
          enabled,
          title: meta?.title || item?.label || '',
          codec: 'opus',
          sourceCodec: meta?.sourceCodec || '',
          sourceChannels: meta?.sourceChannels || '',
          sampleRate: meta?.sampleRate || 0,
        });
      }
    } catch (e) {
      console.warn('[Vega] extractAudioTracks error:', e);
    }
    return tracks;
  }, []);

  const extractTextTracks = useCallback(() => {
    const tracks: Array<{
      index: number;
      label: string;
      language: string;
      mode: string;
    }> = [];
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

  const readAudioMetadata = useCallback((raw?: string | null) => {
    if (!raw) {
      return;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return;
      }
      const metadata: AudioTrackMetadata[] = parsed
        .filter((item) => item && typeof item.index === 'number')
        .map((item: any, ordinal: number) => ({
          index: Number.isFinite(item.index) ? item.index : ordinal,
          language: typeof item.language === 'string' ? item.language : '',
          title: typeof item.title === 'string' ? item.title : '',
          sourceCodec:
            typeof item.sourceCodec === 'string' ? item.sourceCodec : '',
          sourceChannels:
            typeof item.sourceChannels === 'string' ? item.sourceChannels : '',
          sampleRate: Number(item.sampleRate) || 0,
          default: Boolean(item.default),
        }));
      if (metadata.length) {
        proxyAudioMetadataRef.current = metadata;
      }
    } catch (err) {
      console.warn('[VegaPlayer] audio metadata parse failed:', err);
    }
  }, []);

  const sendAudioTracks = useCallback(() => {
    const audioTracks = extractAudioTracks();
    const signature = JSON.stringify(audioTracks);
    if (signature === audioSignatureRef.current) {
      return;
    }
    audioSignatureRef.current = signature;
    sendEventToWeb({
      name: 'audiotracks',
      audioTracks,
      textTracks: extractTextTracks(),
    });
  }, [extractAudioTracks, extractTextTracks, sendEventToWeb]);

  /** Only unrecoverable failures reach the web player's error screen. */
  const forwardNativeError = useCallback(
    (
      reason: string,
      message: string,
      code: number = 4,
      extra: Record<string, any> = {},
    ) => {
      const target = videoRef.current;
      pushNativeLog('fatalError', `${reason}: ${message}`);
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
          diagnosticLogs: [...nativeLogsRef.current],
          proxyLog: proxyLogTailRef.current,
          sourceUrl: sourceUrlRef.current,
          ...extra,
        },
      });
    },
    [extractAudioTracks, extractTextTracks, pushNativeLog, sendEventToWeb],
  );

  /**
   * Play/pause/rate and metadata calls are best-effort control messages. A TV
   * WebView often throws when the native player is between states; that alone
   * does not make the movie unwatchable, so it is logged but never escalated.
   */
  const logControlFailure = useCallback(
    (action: string, err: any) => {
      const message =
        err?.message || err?.name || String(err || `${action} failed`);
      pushNativeLog('control_skipped', `${action}: ${message}`);
    },
    [pushNativeLog],
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

  const clearPrerollWatchdog = useCallback(() => {
    if (prerollWatchdogRef.current) {
      clearTimeout(prerollWatchdogRef.current);
      prerollWatchdogRef.current = null;
    }
  }, []);

  const readStatus = useCallback(
    (sessionId: string): MediaProxyStatus | null => {
      try {
        const status = NuvioMediaProxy.proxyStatus(sessionId);
        readAudioMetadata(status?.audioTracks);
        if (status?.log) {
          proxyLogTailRef.current = status.log.slice(-MAX_PROXY_LOG_CHARS);
        }
        return status;
      } catch (err: any) {
        console.warn('[VegaPlayer] proxyStatus failed:', err);
        return null;
      }
    },
    [readAudioMetadata],
  );

  /**
   * Waits for a complete playback file. A stalled local download or a failed
   * local remux is a real failure; slow but progressing work is not.
   */
  const waitForPlaybackReady = useCallback(
    (sessionId: string, generation: number) =>
      new Promise<MediaProxyStatus>((resolve, reject) => {
        let timer: any = null;
        let lastProgressAt = Date.now();
        let lastPhase = '';
        let lastBytes = -1;
        let settled = false;

        const finish = (callback: (value: any) => void, value: any) => {
          if (settled) {
            return;
          }
          settled = true;
          if (timer) {
            clearTimeout(timer);
            timer = null;
          }
          callback(value);
        };

        const tick = () => {
          const status = readStatus(sessionId);
          if (!status) {
            finish(reject, new Error('Local media proxy is unavailable'));
            return;
          }
          const phase = String(status.phase || status.state || '');
          const bytes =
            Number(status.masterBytes || 0) + Number(status.bytesWritten || 0);
          if (phase !== lastPhase || bytes > lastBytes) {
            lastPhase = phase;
            lastBytes = bytes;
            lastProgressAt = Date.now();
          }
          if (status.error) {
            captureProxyLog();
            finish(reject, new Error(status.error));
            return;
          }
          const failedRebuild =
            Number(status.playbackDone ?? 0) === 1 &&
            Number(status.playbackInFlightGeneration ?? 0) === generation &&
            Number(status.playbackGeneration ?? 0) !== generation &&
            Boolean(status.playbackDiagnostic);
          if (failedRebuild) {
            captureProxyLog();
            finish(
              reject,
              new Error(status.playbackDiagnostic || 'Local remux failed'),
            );
            return;
          }
          if (
            status.state === 'ready' &&
            Number(status.playbackGeneration ?? 0) === generation
          ) {
            finish(resolve, status);
            return;
          }
          if (Date.now() - lastProgressAt > PROGRESS_STALL_MS) {
            captureProxyLog();
            finish(
              reject,
              new Error(
                `Local media preparation stalled in ${
                  phase || 'unknown'
                } phase`,
              ),
            );
            return;
          }
          timer = setTimeout(tick, STATUS_POLL_MS);
        };
        tick();
      }),
    [captureProxyLog, readStatus],
  );

  const startPrerollWatchdog = useCallback(
    (url: string) => {
      clearPrerollWatchdog();
      prerollWatchdogRef.current = setTimeout(() => {
        prerollWatchdogRef.current = null;
        if (hasPlayedOrCanPlayRef.current) {
          return;
        }
        const target = videoRef.current;
        pushNativeLog(
          'preroll_timeout',
          `dur=${target?.duration ?? '-'} audio=${
            extractAudioTracks().length
          } retry=${prerollRetryRef.current}`,
        );
        // The first timeout is treated as a pipeline hiccup: rebuild from the
        // local master and remount once before showing any error to the user.
        if (!prerollRetryRef.current && proxySessionRef.current) {
          prerollRetryRef.current = true;
          restartPlaybackAtRef.current(sourceBaseTimeRef.current, {});
          return;
        }
        captureProxyLog();
        forwardNativeError(
          'native-preroll-timeout',
          'Vega native player could not render the local file',
          4,
          {
            url,
            readyState: Number(target?.readyState ?? 0),
            networkState: Number(target?.networkState ?? 0),
            duration: Number(target?.duration ?? 0),
            audioTracks: extractAudioTracks(),
            textTracks: extractTextTracks(),
            proxyLog: proxyLogTailRef.current,
          },
        );
      }, NATIVE_PREROLL_TIMEOUT_MS);
    },
    [
      captureProxyLog,
      clearPrerollWatchdog,
      extractAudioTracks,
      extractTextTracks,
      forwardNativeError,
      pushNativeLog,
    ],
  );

  const startProxySession = useCallback(
    (
      url: string,
      headers: Record<string, string> | null,
      startTimeSec: number,
      generation: number,
      audioTrackIndex: number,
      audioTrackCount: number,
    ) => {
      const sessionId = `nuvio-${Date.now()}-${generation}-${Math.random()
        .toString(36)
        .slice(2, 8)}`;
      pushNativeLog(
        'proxy_start',
        `time=${startTimeSec.toFixed(1)} headers=${Object.keys(
          headers || {},
        ).join(',')} audio=${audioTrackIndex}/${audioTrackCount}`,
      );
      const result = NuvioMediaProxy.startProxy({
        sessionId,
        url,
        headers: formatProxyHeaders(headers),
        startTimeSec,
        audioTrackIndex,
        audioTrackCount,
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      if (!result?.localUrl) {
        throw new Error('Remuxer did not return a local URL');
      }
      if (generation !== sourceGenerationRef.current) {
        NuvioMediaProxy.stopProxy(sessionId);
        return null;
      }
      proxySessionRef.current = sessionId;
      lastProxySessionRef.current = sessionId;
      localUrlRef.current = result.localUrl;
      pushNativeLog('proxy_master_started', `url=${result.localUrl}`);
      return {sessionId, localUrl: result.localUrl};
    },
    [pushNativeLog],
  );

  const startStatusPolling = useCallback(
    (sessionId: string, generation: number) => {
      stopProxyPolling();
      proxyPollRef.current = setInterval(() => {
        if (
          generation !== sourceGenerationRef.current ||
          sessionId !== proxySessionRef.current
        ) {
          stopProxyPolling();
          return;
        }
        readStatus(sessionId);
        sendAudioTracks();
      }, LOG_POLL_MS);
    },
    [readStatus, sendAudioTracks, stopProxyPolling],
  );

  const mountPlaybackFile = useCallback(
    (localUrl: string) => {
      hasPlayedOrCanPlayRef.current = false;
      audioSignatureRef.current = '';
      lastMountAtRef.current = Date.now();
      isSwitchingRef.current = false;
      setPlaybackKey((prev) => prev + 1);
      setVideoUrl(localUrl);
      startPrerollWatchdog(localUrl);
      sendAudioTracks();
    },
    [sendAudioTracks, startPrerollWatchdog],
  );

  const rebuildPlayback = useCallback(
    async (
      sessionId: string,
      localUrl: string,
      timeSec: number,
      generation: number,
      options: RebuildOptions,
    ) => {
      const result = NuvioMediaProxy.preparePlayback({
        sessionId,
        startTimeSec: Math.max(0, timeSec),
        audioTrackIndex:
          options.audioTrackIndex ?? selectedAudioTrackRef.current,
        audioTrackCount:
          options.audioTrackCount ??
          audioTrackCountRef.current ??
          proxyAudioMetadataRef.current.length,
        generation,
      });
      if (result?.error) {
        throw new Error(result.error);
      }
      const status = await waitForPlaybackReady(sessionId, generation);
      readAudioMetadata(status.audioTracks);
      sourceBaseTimeRef.current = Math.max(0, timeSec);
      if (options.notifySeeked) {
        pendingSeekSecRef.current = Math.max(0, timeSec);
      }
      mountPlaybackFile(localUrl);
      pushNativeLog(
        'playback_rebuilt',
        `time=${timeSec.toFixed(2)} generation=${generation} audio=${
          options.audioTrackIndex ?? selectedAudioTrackRef.current
        }`,
      );
    },
    [mountPlaybackFile, pushNativeLog, readAudioMetadata, waitForPlaybackReady],
  );

  const applyProxySource = useCallback(
    async (
      url: string,
      headers: Record<string, string> | null,
      startTimeSec: number,
      generation: number,
    ) => {
      stopProxyPlayback(PROXY_RETIRE_DELAY_MS);
      proxyAudioMetadataRef.current = [];
      audioSignatureRef.current = '';
      const session = startProxySession(
        url,
        headers,
        startTimeSec,
        generation,
        selectedAudioTrackRef.current,
        audioTrackCountRef.current,
      );
      if (!session || generation !== sourceGenerationRef.current) {
        return;
      }
      sourceUrlRef.current = url;
      sourceHeadersRef.current = headers;
      playbackGenerationRef.current = generation;
      startStatusPolling(session.sessionId, generation);
      const status = await waitForPlaybackReady(session.sessionId, generation);
      if (generation !== sourceGenerationRef.current) {
        return;
      }
      readAudioMetadata(status.audioTracks);
      pushNativeLog(
        'proxy_ready',
        `url=${session.localUrl} phase=${status.phase || 'ready'}`,
      );
      sourceBaseTimeRef.current = Math.max(0, startTimeSec);
      mountPlaybackFile(session.localUrl);
    },
    [
      mountPlaybackFile,
      pushNativeLog,
      readAudioMetadata,
      startProxySession,
      startStatusPolling,
      stopProxyPlayback,
      waitForPlaybackReady,
    ],
  );

  const restartPlaybackAtRef = useRef<
    (timeSec: number, options?: RebuildOptions) => Promise<void>
  >(async () => {});

  const restartPlaybackAt = useCallback(
    async (timeSec: number, options: RebuildOptions = {}) => {
      const sessionId = proxySessionRef.current;
      if (!sessionId) {
        pushNativeLog('rebuild_skipped', 'no active local session');
        return;
      }
      const generation =
        sourceGenerationRef.current + ++playbackGenerationRef.current + 1000;
      isSwitchingRef.current = true;
      prerollRetryRef.current = false;
      clearPrerollWatchdog();
      try {
        await rebuildPlayback(
          sessionId,
          localUrlRef.current || videoUrl,
          timeSec,
          generation,
          options,
        );
      } catch (err: any) {
        const message = err?.message || String(err || 'local rebuild failed');
        pushNativeLog('rebuild_failed', message);
        isSwitchingRef.current = false;
        if (options.audioTrackIndex !== undefined) {
          sendAudioTracks();
        }
        if (options.notifySeeked) {
          sendEventToWeb({name: 'seeked', currentTime: reportedTime()});
        }
        // A failed seek/audio change is recoverable: the previous local file
        // remains mounted and the movie keeps playing.
      }
    },
    [
      clearPrerollWatchdog,
      pushNativeLog,
      rebuildPlayback,
      reportedTime,
      sendAudioTracks,
      sendEventToWeb,
      videoUrl,
    ],
  );
  restartPlaybackAtRef.current = restartPlaybackAt;

  /**
   * The native file is complete before it is mounted, so `ended` is the real
   * end of the movie. Ignore any early GStreamer EOS instead of leaving the
   * player screen or showing an error over working video.
   */
  const handleNativeEnded = useCallback(() => {
    const timeSec = reportedTime();
    const durationSec = reportedDuration();
    if (durationSec > 0 && timeSec < durationSec - 1) {
      pushNativeLog(
        'ended_ignored',
        `time=${timeSec.toFixed(2)} duration=${durationSec.toFixed(2)}`,
      );
      return;
    }
    pushNativeLog('ended');
    sendEventToWeb({name: 'ended'});
  }, [pushNativeLog, reportedDuration, reportedTime, sendEventToWeb]);

  const handleNativeMediaError = useCallback(
    (err: any) => {
      clearPrerollWatchdog();
      const mediaErr = err?.target?.error || videoRef.current?.error;
      const code =
        mediaErr?.code || (typeof err?.code === 'number' ? err.code : 4);
      const rawMessage =
        mediaErr?.message || err?.message || err?.name || 'Native player error';
      const msg = mediaErr?.code
        ? `${rawMessage} (code ${mediaErr.code})`
        : rawMessage;
      console.warn('[Vega Video onError]', msg, err, mediaErr);
      pushNativeLog('native_media_error', msg);
      captureProxyLog();

      // Decoder errors immediately after a rebuild are often a transient
      // reconfiguration. Retry once from the local master before considering
      // the playback broken.
      const now = Date.now();
      if (
        (isSwitchingRef.current || now - lastMountAtRef.current < 2000) &&
        nativeErrorCountRef.current === 0
      ) {
        nativeErrorCountRef.current = 1;
        lastNativeErrorAtRef.current = now;
        restartPlaybackAtRef.current(reportedTime(), {});
        return;
      }
      if (now - lastNativeErrorAtRef.current < MEDIA_ERROR_RETRY_WINDOW_MS) {
        nativeErrorCountRef.current += 1;
        if (nativeErrorCountRef.current < 2) {
          return;
        }
      } else {
        nativeErrorCountRef.current = 1;
        lastNativeErrorAtRef.current = now;
        return;
      }
      forwardNativeError('native-media-error', msg, code, {
        sourceError: rawMessage,
        errorName: err?.name,
        proxyLog: proxyLogTailRef.current,
      });
    },
    [
      captureProxyLog,
      clearPrerollWatchdog,
      forwardNativeError,
      pushNativeLog,
      reportedTime,
    ],
  );

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
      pushNativeLog(
        'source_probe',
        'fetching source once into a local master file',
      );
      await applyProxySource(url, headers, 0, generation);
    } catch (err: any) {
      if (generation !== sourceGenerationRef.current) {
        return;
      }
      clearPrerollWatchdog();
      const message =
        err?.message || String(err || 'local media preparation failed');
      pushNativeLog('proxy_failed', message);
      stopProxyPlayback();
      forwardNativeError('proxy-start-failed', message, 4, {
        url,
        proxyLog: proxyLogTailRef.current,
      });
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
      sourceGenerationRef.current += 1;
      preparingSourceRef.current = false;
      hasPlayedOrCanPlayRef.current = false;
      isSwitchingRef.current = false;
      prerollRetryRef.current = false;
      nativeErrorCountRef.current = 0;
      pendingSeekSecRef.current = null;
      proxyAudioMetadataRef.current = [];
      audioSignatureRef.current = '';
      nativeLogsRef.current = [];
      proxyLogTailRef.current = '';
      playingRef.current = false;
      const headers =
        incomingHeaders && Object.keys(incomingHeaders).length > 0
          ? incomingHeaders
          : null;
      sourceUrlRef.current = url;
      sourceHeadersRef.current = headers;
      sourceBaseTimeRef.current = 0;
      selectedAudioTrackRef.current = -1;
      audioTrackCountRef.current = 0;
      pendingSourceRef.current = {
        url,
        headers,
        generation: sourceGenerationRef.current,
      };
      pushNativeLog('open', `hasHeaders=${Boolean(headers)}`);
      setPlaybackKey((prev) => prev + 1);
      setVideoUrl('');
      setSourcePendingToken((prev) => prev + 1);
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
        if (payload?.type !== 'NUVIO_VEGA_PLAYER') {
          return;
        }
        const {action} = payload;
        switch (action) {
          case 'open':
            if (payload.url) {
              openSource(payload.url, payload.headers || null);
            } else {
              forwardNativeError(
                'native-open-invalid-url',
                'Playback URL is empty',
                4,
              );
            }
            break;
          case 'setHeaders':
          case 'prepare': {
            // Headers apply to the single master download. Late header updates
            // cannot be used for a rebuild and must never restart the network.
            if (payload.headers && typeof payload.headers === 'object') {
              const merged = {
                ...(sourceHeadersRef.current || {}),
                ...payload.headers,
              };
              if (Object.keys(merged).length > 0) {
                sourceHeadersRef.current = merged;
                if (pendingSourceRef.current) {
                  pendingSourceRef.current.headers = merged;
                }
                pushNativeLog('headers', `count=${Object.keys(merged).length}`);
              }
            }
            break;
          }
          case 'play':
            playingRef.current = true;
            try {
              videoRef.current
                ?.play()
                ?.catch?.((err: any) => logControlFailure('play', err));
            } catch (err: any) {
              logControlFailure('play', err);
            }
            break;
          case 'pause':
            playingRef.current = false;
            try {
              videoRef.current?.pause();
            } catch (err: any) {
              logControlFailure('pause', err);
            }
            break;
          case 'seek': {
            if (
              typeof payload.positionMs !== 'number' ||
              !proxySessionRef.current
            ) {
              break;
            }
            const targetSec = Math.max(0, payload.positionMs / 1000);
            pushNativeLog('seek', `time=${targetSec.toFixed(2)}`);
            restartPlaybackAt(targetSec, {notifySeeked: true});
            break;
          }
          case 'selectAudioTrack': {
            const index = Number(payload.index);
            if (
              !Number.isFinite(index) ||
              index < 0 ||
              !proxySessionRef.current
            ) {
              break;
            }
            const trackIndex = Math.floor(index);
            if (trackIndex === selectedAudioTrackRef.current) {
              break;
            }
            const trackCount =
              Number(payload.trackCount) > 0
                ? Math.floor(payload.trackCount)
                : proxyAudioMetadataRef.current.length ||
                  audioTrackCountRef.current;
            selectedAudioTrackRef.current = trackIndex;
            audioTrackCountRef.current = trackCount;
            pushNativeLog(
              'selectAudioTrack',
              `index=${trackIndex} count=${trackCount}`,
            );
            // The rebuilt playback file has exactly one default audio track.
            // Toggling native `enabled` here races that rebuild and makes Vega
            // abort pending track reconfigurations, so the container flag is
            // the only authoritative switch.
            sendEventToWeb({
              name: 'audiotracks',
              audioTracks: extractAudioTracks(trackIndex),
            });
            restartPlaybackAt(reportedTime(), {
              audioTrackIndex: trackIndex,
              audioTrackCount: trackCount,
            });
            break;
          }
          case 'selectTextTrack':
            if (
              videoRef.current?.textTracks &&
              typeof payload.index === 'number'
            ) {
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
              } catch (err: any) {
                logControlFailure('selectTextTrack', err);
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
            } catch (err: any) {
              logControlFailure('setSilentSubtitle', err);
            }
            break;
          case 'rate':
            if (typeof payload.rate === 'number' && videoRef.current) {
              try {
                videoRef.current.playbackRate = payload.rate;
              } catch (err: any) {
                logControlFailure('rate', err);
              }
            }
            break;
          case 'stop':
            clearPrerollWatchdog();
            pushNativeLog('stop');
            try {
              videoRef.current?.pause();
            } catch (err: any) {
              logControlFailure('stop', err);
            }
            break;
          case 'close':
            clearPrerollWatchdog();
            stopProxyPlayback();
            sourceGenerationRef.current += 1;
            preparingSourceRef.current = false;
            hasPlayedOrCanPlayRef.current = false;
            isSwitchingRef.current = false;
            prerollRetryRef.current = false;
            pendingSeekSecRef.current = null;
            proxyAudioMetadataRef.current = [];
            audioSignatureRef.current = '';
            nativeLogsRef.current = [];
            proxyLogTailRef.current = '';
            playingRef.current = false;
            pushNativeLog('close');
            setVideoUrl('');
            sourceUrlRef.current = '';
            sourceHeadersRef.current = null;
            sourceBaseTimeRef.current = 0;
            break;
          default:
            break;
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
      logControlFailure,
      openSource,
      pushNativeLog,
      reportedTime,
      restartPlaybackAt,
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
      retiredProxyTimersRef.current.forEach((timer) => clearTimeout(timer));
      retiredProxyTimersRef.current = [];
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
              pushNativeLog(
                'mount',
                `seek=${pendingSeekSecRef.current ?? '-'}`,
              );
              if (pendingSeekSecRef.current !== null) {
                const seekTarget = pendingSeekSecRef.current;
                pendingSeekSecRef.current = null;
                sendEventToWeb({name: 'seeked', currentTime: seekTarget});
              }
              sendAudioTracks();
            }}
            onCanPlay={() => {
              hasPlayedOrCanPlayRef.current = true;
              clearPrerollWatchdog();
              nativeErrorCountRef.current = 0;
              pushNativeLog(
                'canplay',
                `dur=${videoRef.current?.duration ?? '-'}`,
              );
              sendEventToWeb({
                name: 'canplay',
                duration: reportedDuration(),
                currentTime: reportedTime(),
                audioTracks: extractAudioTracks(),
                textTracks: extractTextTracks(),
              });
            }}
            onLoadedMetadata={() => {
              pushNativeLog(
                'loadedmetadata',
                `dur=${videoRef.current?.duration ?? '-'}`,
              );
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
              nativeErrorCountRef.current = 0;
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
              });
            }}
            onStalled={() => {
              pushNativeLog('stalled');
              sendEventToWeb({
                name: 'stalled',
                readyState: videoRef.current?.readyState ?? 0,
                networkState: videoRef.current?.networkState ?? 0,
                duration: reportedDuration(),
              });
            }}
            onSeeked={() => {
              isSwitchingRef.current = false;
              sendEventToWeb({name: 'seeked', currentTime: reportedTime()});
            }}
            onTimeUpdate={() => {
              const current = Number(videoRef.current?.currentTime ?? 0);
              if (!hasPlayedOrCanPlayRef.current && current > 0.15) {
                hasPlayedOrCanPlayRef.current = true;
                clearPrerollWatchdog();
                nativeErrorCountRef.current = 0;
                pushNativeLog('playback_started', `time=${current.toFixed(2)}`);
              }
              sendEventToWeb({
                name: 'timeupdate',
                currentTime: reportedTime(),
                duration: reportedDuration(),
              });
            }}
            onEnded={handleNativeEnded}
            onError={handleNativeMediaError}
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
        source={{uri: WEBVIEW_MAIN_URL}}
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
        onError={({
          nativeEvent: {code, url, description},
        }: WebViewErrorEvent) => {
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
          forwardNativeError('webview-http-error', message, code || 4, {
            url,
            isMainFrame,
          });
        }}
        onSslError={(
          {code, url, description}: SslErrorData,
          callback: {proceed: () => void; cancel: () => void},
        ) => {
          const message =
            description || `SSL error ${code} while loading ${url}`;
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
