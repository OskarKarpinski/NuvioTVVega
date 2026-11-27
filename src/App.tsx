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
const MAX_PROXY_LOG_CHARS = 8000;
const WEBVIEW_MAIN_URL = 'file:///pkg/assets/web/index.html';
// A seek replaces the local file. Give the native pipeline time to open the
// new src before unlinking the previous one.
const PROXY_RETIRE_DELAY_MS = 8000;
const AUDIO_TRACK_POLL_MS = 500;
// GStreamer sees the current end of a still-growing local MKV as EOS. When the
// remuxer falls behind the player we silently rebuilt a few seconds earlier;
// cap that recovery so a genuinely broken source still reaches the error UI.
const MAX_PREMATURE_END_RECOVERIES = 3;

type AudioTrackMetadata = {
  index: number;
  language: string;
  title: string;
  sourceCodec: string;
  sourceChannels: string;
  sampleRate: number;
  default: boolean;
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
  // Only proxy URLs may reach <Video>. A source is prepared first, then the
  // native player is mounted with the local URL as its initial src.
  const [sourcePendingToken, setSourcePendingToken] = useState<number>(0);
  const [playbackKey, setPlaybackKey] = useState<number>(0);
  const customHeadersRef = useRef<Record<string, string> | null>(null);

  // Every source is routed through the on-device remuxer. The native player
  // only ever sees a local file:// URI, never the remote URL or its headers.
  const proxySessionRef = useRef<string | null>(null);
  const lastProxySessionRef = useRef<string | null>(null);
  const proxyPollRef = useRef<any>(null);
  const audioTrackPollRef = useRef<any>(null);
  const audioSignatureRef = useRef<string>('');
  const proxyAudioMetadataRef = useRef<AudioTrackMetadata[]>([]);
  const retiredProxyTimersRef = useRef<any[]>([]);
  const prematureEndCountRef = useRef<number>(0);
  const pendingSeekSecRef = useRef<number | null>(null);
  const proxyLogTailRef = useRef<string>('');
  const restartProxyAtRef = useRef<
    (
      timeSec: number,
      headersOverride?: Record<string, string> | null,
      notifySeeked?: boolean,
      audioTrackIndex?: number,
      audioTrackCount?: number,
    ) => Promise<void>
  >(async () => {});

  const sourceUrlRef = useRef<string>('');
  const sourceHeadersRef = useRef<Record<string, string> | null>(null);
  // Audio selection is applied by the remuxer, not by trusting the native
  // player's track enable API: it is authoritative for every source and codec.
  const selectedAudioTrackRef = useRef<number>(-1);
  const audioTrackCountRef = useRef<number>(0);
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

  const stopAudioTrackPolling = useCallback(() => {
    if (audioTrackPollRef.current) {
      clearInterval(audioTrackPollRef.current);
      audioTrackPollRef.current = null;
    }
  }, []);

  const stopProxyPlayback = useCallback((delayMs: number = 0) => {
    stopProxyPolling();
    stopAudioTrackPolling();
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
  }, [captureProxyLog, pushNativeLog, stopProxyPolling, stopAudioTrackPolling]);

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
      const nativeCount = list && typeof list.length === 'number' ? list.length : 0;
      const count = Math.max(nativeCount, metadata.length);
      const requested =
        typeof selectedIndex === 'number' && selectedIndex >= 0
          ? selectedIndex
          : selectedAudioTrackRef.current;
      const defaultIndex = metadata.find(item => item.default)?.index ?? -1;
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
          label: meta?.title || item?.label || meta?.language || item?.language || `Track ${i + 1}`,
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
        .filter(item => item && typeof item.index === 'number')
        .map((item: any, ordinal: number) => ({
          index: Number.isFinite(item.index) ? item.index : ordinal,
          language: typeof item.language === 'string' ? item.language : '',
          title: typeof item.title === 'string' ? item.title : '',
          sourceCodec: typeof item.sourceCodec === 'string' ? item.sourceCodec : '',
          sourceChannels: typeof item.sourceChannels === 'string' ? item.sourceChannels : '',
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

  const startAudioTrackPolling = useCallback(
    (sessionId: string, generation: number) => {
      stopAudioTrackPolling();
      audioSignatureRef.current = '';
      let attempts = 0;
      audioTrackPollRef.current = setInterval(() => {
        attempts += 1;
        if (
          generation !== sourceGenerationRef.current ||
          sessionId !== proxySessionRef.current
        ) {
          stopAudioTrackPolling();
          return;
        }
        try {
          readAudioMetadata(NuvioMediaProxy.proxyStatus(sessionId)?.audioTracks);
        } catch (err) {
          console.warn('[VegaPlayer] audio track status failed:', err);
        }
        sendAudioTracks();
        if (attempts >= 40 || proxyAudioMetadataRef.current.length > 0) {
          stopAudioTrackPolling();
        }
      }, AUDIO_TRACK_POLL_MS);
    },
    [readAudioMetadata, sendAudioTracks, stopAudioTrackPolling],
  );

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
        let proxyDiagnostic: unknown = null;
        try {
          if (proxySessionRef.current) {
            proxyDiagnostic = NuvioMediaProxy.proxyStatus(proxySessionRef.current);
          }
        } catch (_) {
          // Diagnostics must never hide the original playback failure.
        }
        console.warn('[VegaPlayer] Native preroll timeout:', {
          url,
          readyState: Number(target?.readyState ?? 0),
          networkState: Number(target?.networkState ?? 0),
          duration: target?.duration,
          proxyDiagnostic,
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
        `time=${startTimeSec.toFixed(1)} headers=${Object.keys(headers || {}).join(',')} audio=${audioTrackIndex}/${audioTrackCount}`,
      );
      const result = NuvioMediaProxy.startProxy({
        sessionId,
        url,
        headers: formatProxyHeaders(headers),
        startTimeSec,
        audioTrackIndex,
        audioTrackCount,
      });
      if (result?.error || !result?.localUrl) {
        throw new Error(result?.error || 'Remuxer did not return a local URL');
      }
      if (generation !== sourceGenerationRef.current) {
        NuvioMediaProxy.stopProxy(sessionId);
        return null;
      }
      pushNativeLog('proxy_ready', `url=${result.localUrl} path=${result.cachePath}`);
      return {sessionId, localUrl: result.localUrl};
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
          readAudioMetadata(status?.audioTracks);
          const exitCode = Number(status?.exitCode ?? 0);
          const failed =
            Boolean(status?.error) ||
            (status?.state === 'complete' && exitCode !== 0);
          if (failed) {
            stopProxyPolling();
            clearPrerollWatchdog();
            captureProxyLog();
            if (hasPlayedOrCanPlayRef.current) {
              // Once frames and audio have reached the native player, an ffmpeg
              // exit is a diagnostic event, not a playback failure. The local
              // file stays mounted; killing it here produced a false error
              // screen over working video.
              pushNativeLog(
                'proxy_finished',
                `exit=${exitCode} ${status?.error || 'remux ended'}`,
              );
              if (status?.log) {
                pushNativeLog('proxy_log', status.log.slice(-600).replace(/\s+/g, ' '));
              }
              return;
            }
            stopProxyPlayback();
            forwardNativeError(
              'proxy-stream-failed',
              status?.error || `Remux failed (exit ${exitCode || 'unknown'})`,
              4,
              {
                url,
                exitCode,
                proxyLog: status?.log || '',
              },
            );
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
      pushNativeLog,
      readAudioMetadata,
      stopProxyPlayback,
      stopProxyPolling,
    ],
  );

  const applyProxySource = useCallback(
    async (
      url: string,
      headers: Record<string, string> | null,
      startTimeSec: number,
      generation: number,
      audioTrackIndex?: number,
      audioTrackCount?: number,
    ) => {
      // The native player may still be reading the old file while ffmpeg
      // prepares its replacement. Keep that file alive until the new src has
      // been mounted and had time to open.
      stopProxyPlayback(PROXY_RETIRE_DELAY_MS);
      proxyAudioMetadataRef.current = [];
      audioSignatureRef.current = '';
      const trackIndex =
        typeof audioTrackIndex === 'number' && audioTrackIndex >= 0
          ? audioTrackIndex
          : selectedAudioTrackRef.current;
      const trackCount =
        typeof audioTrackCount === 'number' && audioTrackCount > 0
          ? audioTrackCount
          : audioTrackCountRef.current;
      const session = await startProxySession(
        url,
        headers,
        startTimeSec,
        generation,
        trackIndex,
        trackCount,
      );
      if (!session || generation !== sourceGenerationRef.current) {
        if (session) {
          NuvioMediaProxy.stopProxy(session.sessionId);
        }
        return;
      }
      proxySessionRef.current = session.sessionId;
      lastProxySessionRef.current = session.sessionId;
      sourceBaseTimeRef.current = startTimeSec;
      sourceUrlRef.current = url;
      sourceHeadersRef.current = headers;
      hasPlayedOrCanPlayRef.current = false;
      targetLocalSecRef.current = 0;
      // Mount the native player directly on the local URL. It must never see
      // the remote URL, not even for a single frame while ffmpeg runs.
      setPlaybackKey(prev => prev + 1);
      setVideoUrl(session.localUrl);
      startPrerollWatchdog(session.localUrl);
      startProxyPolling(session.sessionId, generation, url);
      startAudioTrackPolling(session.sessionId, generation);
    },
    [
      startAudioTrackPolling,
      startPrerollWatchdog,
      startProxyPolling,
      startProxySession,
      stopProxyPlayback,
    ],
  );

  const restartProxyAt = useCallback(
    async (
      timeSec: number,
      headersOverride?: Record<string, string> | null,
      notifySeeked: boolean = false,
      audioTrackIndex?: number,
      audioTrackCount?: number,
    ) => {
      const url = sourceUrlRef.current;
      if (!url) {
        return;
      }
      const headers =
        headersOverride !== undefined ? headersOverride : sourceHeadersRef.current;
      sourceHeadersRef.current = headers;
      // Each restart supersedes any earlier in-flight remux.
      const generation = sourceGenerationRef.current + 1;
      sourceGenerationRef.current = generation;
      isSeekingRef.current = true;
      targetLocalSecRef.current = 0;
      pendingSeekSecRef.current = notifySeeked ? timeSec : null;
      if (seekTimeoutRef.current) {
        clearTimeout(seekTimeoutRef.current);
        seekTimeoutRef.current = null;
      }
      try {
        await applyProxySource(
          url,
          headers,
          Math.max(0, timeSec),
          generation,
          audioTrackIndex,
          audioTrackCount,
        );
      } catch (err: any) {
        if (generation !== sourceGenerationRef.current) {
          return;
        }
        const message = err?.message || String(err || 'proxy restart failed');
        pushNativeLog('proxy_restart_failed', message);
        isSeekingRef.current = false;
        pendingSeekSecRef.current = null;
        stopProxyPlayback();
        forwardNativeError('proxy-restart-failed', message, 4, {url, timeSec});
      }
    },
    [applyProxySource, forwardNativeError, pushNativeLog, stopProxyPlayback],
  );
  restartProxyAtRef.current = restartProxyAt;

  /**
   * A file:// MKV is still being written by ffmpeg. GStreamer treats the
   * current end of that file as EOS, so `ended` can arrive long before the
   * movie is over. Distinguish that from a real end by asking the remuxer
   * whether it is still streaming and whether it reported an error.
   */
  const handleNativeEnded = useCallback(() => {
    const sessionId = proxySessionRef.current;
    let status: ReturnType<typeof NuvioMediaProxy.proxyStatus> | null = null;
    if (sessionId) {
      try {
        status = NuvioMediaProxy.proxyStatus(sessionId);
      } catch (err) {
        console.warn('[VegaPlayer] ended status failed:', err);
      }
    }
    const timeSec = reportedTime();
    const remuxFailed = Boolean(status?.error) ||
      (status?.state === 'complete' && Number(status?.exitCode ?? 0) !== 0);
    if (remuxFailed) {
      pushNativeLog(
        'ended_with_remux_error',
        `time=${timeSec.toFixed(2)} state=${status?.state} exit=${status?.exitCode} error=${status?.error || ''}`,
      );
      captureProxyLog();
      stopProxyPlayback();
      forwardNativeError('proxy-stream-failed', status?.error || 'Remux failed', 4, {
        url: sourceUrlRef.current,
        proxyLog: proxyLogTailRef.current,
      });
      return;
    }
    const stillStreaming = Boolean(sessionId) && status?.state === 'streaming';
    if (stillStreaming && prematureEndCountRef.current < MAX_PREMATURE_END_RECOVERIES) {
      prematureEndCountRef.current += 1;
      pushNativeLog(
        'premature_end',
        `time=${timeSec.toFixed(2)} bytes=${status?.bytesWritten ?? '-'} recovery=${prematureEndCountRef.current}`,
      );
      if (status?.log) {
        pushNativeLog('proxy_log', status.log.slice(-600).replace(/\s+/g, ' '));
      }
      restartProxyAt(timeSec, undefined, false);
      return;
    }
    if (stillStreaming) {
      pushNativeLog('premature_end_giveup', `time=${timeSec.toFixed(2)}`);
      captureProxyLog();
      stopProxyPlayback();
      forwardNativeError(
        'proxy-stalled',
        'The local remux stopped delivering frames before the movie ended',
        4,
        {url: sourceUrlRef.current, proxyLog: proxyLogTailRef.current},
      );
      return;
    }
    pushNativeLog('ended');
    sendEventToWeb({name: 'ended'});
  }, [
    captureProxyLog,
    forwardNativeError,
    pushNativeLog,
    reportedTime,
    restartProxyAt,
    sendEventToWeb,
    stopProxyPlayback,
  ]);

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
      pushNativeLog('source_probe', 'bundled ffmpeg remuxes the source locally');
      await applyProxySource(url, headers, 0, generation);
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
      prematureEndCountRef.current = 0;
      pendingSeekSecRef.current = null;
      proxyAudioMetadataRef.current = [];
      audioSignatureRef.current = '';
      nativeLogsRef.current = [];
      proxyLogTailRef.current = '';
      const headers =
        incomingHeaders && Object.keys(incomingHeaders).length > 0 ? incomingHeaders : null;
      customHeadersRef.current = headers;
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
              if (typeof payload.positionMs !== 'number' || !proxySessionRef.current) {
                break;
              }
              const targetSec = Math.max(0, payload.positionMs / 1000);
              targetSeekSecRef.current = targetSec;
              prematureEndCountRef.current = 0;
              // The remuxed MKV deliberately has no cues index. Native seeks land
              // on a non-keyframe and the decoder reports "No valid frames
              // decoded", so every seek rebuilds the file from the target time.
              restartProxyAt(targetSec, undefined, true);
              break;
            }
            case 'selectAudioTrack':
              if (
                typeof payload.index === 'number' &&
                Number.isFinite(payload.index) &&
                payload.index >= 0
              ) {
                const index = Math.floor(payload.index);
                const trackCount =
                  Number(payload.trackCount) > 0
                    ? Math.floor(payload.trackCount)
                    : proxyAudioMetadataRef.current.length ||
                      audioTrackCountRef.current ||
                      Number(videoRef.current?.audioTracks?.length || 0);
                if (index === selectedAudioTrackRef.current && proxySessionRef.current) {
                  break;
                }
                selectedAudioTrackRef.current = index;
                audioTrackCountRef.current = trackCount;
                pushNativeLog('selectAudioTrack', `index=${index} count=${trackCount}`);
                // Best effort only: the remuxed file below is authoritative.
                try {
                  const list = videoRef.current?.audioTracks;
                  if (list && typeof list.length === 'number') {
                    for (let i = 0; i < list.length; i++) {
                      if (list[i]) {
                        list[i].enabled = i === index;
                      }
                    }
                  }
                } catch (err: any) {
                  pushNativeLog('selectAudioTrack_native_skipped', err?.message || String(err));
                }
                sendEventToWeb({
                  name: 'audiotracks',
                  audioTracks: extractAudioTracks(index),
                });
                restartProxyAt(reportedTime(), undefined, false, index, trackCount).catch(
                  (err: any) => {
                    pushNativeLog(
                      'selectAudioTrack_restart_failed',
                      err?.message || String(err),
                    );
                  },
                );
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
              pendingSeekSecRef.current = null;
              proxyAudioMetadataRef.current = [];
              audioSignatureRef.current = '';
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
      retiredProxyTimersRef.current.forEach(timer => clearTimeout(timer));
      retiredProxyTimersRef.current = [];
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
              pushNativeLog('mount', `seek=${pendingSeekSecRef.current ?? '-'}`);
              // The source is already proxied at this point. Do not prepare it
              // here: the native Video must never be mounted with a remote URL.
              if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
                seekTimeoutRef.current = null;
              }
              isSeekingRef.current = false;
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
              if (isSeekingRef.current) {
                isSeekingRef.current = false;
                pendingSeekSecRef.current = null;
              }
              // Advancing native time is the strongest proof that real frames
              // reached the display, even when onCanPlay/onPlaying are not
              // delivered for file:// sources on Vega.
              if (!hasPlayedOrCanPlayRef.current && typeof current === 'number' && current > 0.15) {
                hasPlayedOrCanPlayRef.current = true;
                clearPrerollWatchdog();
                pushNativeLog('playback_started', `time=${current.toFixed(2)}`);
              }
              sendEventToWeb({
                name: 'timeupdate',
                currentTime: reportedTime(),
                duration: reportedDuration(),
              });
            }}
            onEnded={handleNativeEnded}
            onError={(err: any) => {
              clearPrerollWatchdog();
              if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
                seekTimeoutRef.current = null;
              }
              isSeekingRef.current = false;
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
