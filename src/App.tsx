import {WebView} from '@amazon-devices/webview';
import * as React from 'react';
import {useCallback, useRef, useState} from 'react';
import {BackHandler, Dimensions, StyleSheet, View} from 'react-native';
import {
  useHideSplashScreenCallback,
  usePreventHideSplashScreen,
} from '@amazon-devices/react-native-kepler';
import {Video} from '@amazon-devices/react-native-w3cmedia';
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

export const App = () => {
  const webRef = useRef<any>(null);
  const videoRef = useRef<any>(null);
  const [videoUrl, setVideoUrl] = useState<string>('');
  const [playbackKey, setPlaybackKey] = useState<number>(0);
  const [customHeaders, setCustomHeaders] = useState<Record<string, string> | null>(null);
  const customHeadersRef = useRef<Record<string, string> | null>(null);
  const [showCaptions, setShowCaptions] = useState<boolean>(true);
  const seekTimeoutRef = useRef<any>(null);
  const prerollWatchdogRef = useRef<any>(null);
  const hasPlayedOrCanPlayRef = useRef<boolean>(false);
  const isSeekingRef = useRef<boolean>(false);
  const targetSeekSecRef = useRef<number>(0);
  const appliedSrcRef = useRef<{url: string; headersStr: string} | null>(null);
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

  const setVideoSource = useCallback((url: string, headers: Record<string, string> | null) => {
    if (!url) return;
    const target = videoRef.current;
    if (!target) {
      console.warn('[VegaPlayer] videoRef.current is null when setting source for:', url);
      pushNativeLog('setVideoSource:no_ref');
      return;
    }
    const hasHeaders = Boolean(
      headers && typeof headers === 'object' && Object.keys(headers).length > 0,
    );
    const headersStr = hasHeaders ? JSON.stringify(headers) : '';
    if (
      appliedSrcRef.current &&
      appliedSrcRef.current.url === url &&
      appliedSrcRef.current.headersStr === headersStr
    ) {
      return;
    }
    const player = (target as any)?.mediaPlayer_ || target;
    try {
      if (hasHeaders) {
        if (typeof player?.setSrcWithCustomHeaders !== 'function') {
          const message = 'Native player cannot apply request headers (setSrcWithCustomHeaders unavailable)';
          pushNativeLog('setVideoSource:no_header_api', message);
          forwardNativeError('native-headers-unsupported', message, 4, {url});
          return;
        }
        console.info('[VegaPlayer] Calling player.setSrcWithCustomHeaders with headers:', url, headers);
        pushNativeLog('setSrcWithCustomHeaders', `headers=${Object.keys(headers!).join(',')}`);
        player.setSrcWithCustomHeaders(url, headers);
      } else {
        // Never call player.setSrcWithCustomHeaders(url, null) because Vega W3CMedia IDL
        // throws InvalidInputError on null headers and aborts the GStreamer pipeline.
        if (target.src !== url) {
          console.info('[VegaPlayer] Setting target.src:', url);
          pushNativeLog('setSrc:direct');
          target.src = url;
        } else {
          console.info('[VegaPlayer] target.src matches, keeping pipeline intact:', url);
        }
      }
      appliedSrcRef.current = { url, headersStr };
    } catch (err: any) {
      const message = err?.message || err?.name || String(err || 'setVideoSource failed');
      pushNativeLog('setVideoSource:error', message);
      forwardNativeError('native-source-setup-failed', `setVideoSource: ${message}`, 4, {url});
    }
  }, [forwardNativeError, pushNativeLog]);

  React.useEffect(() => {
    const hasHeaders = Boolean(
      customHeadersRef.current &&
      typeof customHeadersRef.current === 'object' &&
      Object.keys(customHeadersRef.current).length > 0,
    );
    if (videoUrl && videoRef.current && hasHeaders) {
      setVideoSource(videoUrl, customHeadersRef.current);
    }
  }, [videoUrl, playbackKey, setVideoSource]);

  React.useEffect(() => {
    return () => {
      clearPrerollWatchdog();
      if (seekTimeoutRef.current) {
        clearTimeout(seekTimeoutRef.current);
        seekTimeoutRef.current = null;
      }
    };
  }, [clearPrerollWatchdog]);

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
                clearPrerollWatchdog();
                hasPlayedOrCanPlayRef.current = false;
                nativeLogsRef.current = [];
                const headers =
                  payload.headers &&
                  typeof payload.headers === 'object' &&
                  Object.keys(payload.headers).length > 0
                    ? payload.headers
                    : null;
                customHeadersRef.current = headers;
                setCustomHeaders(headers);
                appliedSrcRef.current = null;
                pushNativeLog('open', `hasHeaders=${Boolean(headers)}`);
                setPlaybackKey((prev) => prev + 1);
                setVideoUrl(payload.url);

                prerollWatchdogRef.current = setTimeout(() => {
                  prerollWatchdogRef.current = null;
                  if (hasPlayedOrCanPlayRef.current) {
                    return;
                  }
                  const target = videoRef.current;
                  const readyState = Number(target?.readyState ?? 0);
                  // Do not treat readyState >= 2 as success: the GStreamer pipeline can
                  // expose metadata and then stall forever before canplay/playing.
                  const networkState = Number(target?.networkState ?? 0);
                  const duration = target?.duration;
                  const audioTracks = extractAudioTracks();
                  const textTracks = extractTextTracks();
                  pushNativeLog('preroll_timeout', `dur=${duration ?? '-'} audio=${audioTracks.length}`);
                  const diagnosticLogs = [...nativeLogsRef.current];
                  console.warn('[VegaPlayer] Native preroll timeout:', {
                    url: payload.url,
                    readyState,
                    networkState,
                    duration,
                    audioTracks,
                    diagnosticLogs,
                  });
                  try {
                    target?.pause?.();
                  } catch (_) {
                    // The watchdog still reports the original failure if pausing fails.
                  }
                  sendEventToWeb({
                    name: 'error',
                    error: 'Vega native player preroll timeout (pipeline stalled before canplay)',
                    code: 4,
                    details: {
                      reason: 'native-preroll-timeout',
                      readyState,
                      networkState,
                      duration,
                      audioTracks,
                      textTracks,
                      diagnosticLogs,
                    },
                  });
                }, NATIVE_PREROLL_TIMEOUT_MS);
              } else {
                forwardNativeError('native-open-invalid-url', 'Native player received an empty playback URL', 4);
              }
              break;
            case 'setHeaders':
              if (payload.headers && typeof payload.headers === 'object') {
                const merged = { ...(customHeadersRef.current || {}), ...payload.headers };
                if (Object.keys(merged).length > 0) {
                  customHeadersRef.current = merged;
                  setCustomHeaders(merged);
                  appliedSrcRef.current = null;
                  if (videoUrl) {
                    setVideoSource(videoUrl, merged);
                  }
                }
              }
              break;
            case 'prepare':
              if (payload.headers && typeof payload.headers === 'object') {
                const merged = { ...(customHeadersRef.current || {}), ...payload.headers };
                if (Object.keys(merged).length > 0) {
                  customHeadersRef.current = merged;
                  setCustomHeaders(merged);
                  appliedSrcRef.current = null;
                  const targetUrl = payload.url || videoUrl;
                  if (targetUrl) {
                    setVideoSource(targetUrl, merged);
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
            case 'seek':
              if (typeof payload.positionMs === 'number' && videoRef.current) {
                const targetSec = Math.max(0, payload.positionMs / 1000);
                targetSeekSecRef.current = targetSec;
                isSeekingRef.current = true;
                if (seekTimeoutRef.current) {
                  clearTimeout(seekTimeoutRef.current);
                }
                try {
                  videoRef.current.currentTime = targetSec;
                } catch (err) {
                  reportNativeActionFailure('seek', err);
                }
                // Fallback: if native onSeeked does not fire within 300ms, dispatch synthetic seeked
                seekTimeoutRef.current = setTimeout(() => {
                  seekTimeoutRef.current = null;
                  if (isSeekingRef.current) {
                    isSeekingRef.current = false;
                    sendEventToWeb({
                      name: 'seeked',
                      currentTime: videoRef.current?.currentTime ?? targetSec,
                    });
                  }
                }, 300);
              }
              break;
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
              hasPlayedOrCanPlayRef.current = false;
              pushNativeLog('close');
              if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
                seekTimeoutRef.current = null;
              }
              isSeekingRef.current = false;
              appliedSrcRef.current = null;
              setVideoUrl('');
              setCustomHeaders(null);
              customHeadersRef.current = null;
              break;
          }
        }
      } catch (_) {
        // Ignore non-JSON messages from web content.
      }
    },
    [
      sendEventToWeb,
      forwardNativeError,
      reportNativeActionFailure,
      extractAudioTracks,
      extractTextTracks,
      videoUrl,
      setVideoSource,
      clearPrerollWatchdog,
      pushNativeLog,
    ],
  );

  return (
    <View style={styles.container}>
      {videoUrl ? (
        <View style={styles.nativeVideoContainer}>
          <Video
            ref={videoRef}
            key={`${playbackKey}:${videoUrl}`}
            src={customHeaders ? undefined : videoUrl}
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
              const hasHeaders = Boolean(
                customHeadersRef.current &&
                typeof customHeadersRef.current === 'object' &&
                Object.keys(customHeadersRef.current).length > 0
              );
              if (videoUrl && hasHeaders) {
                setVideoSource(videoUrl, customHeadersRef.current);
              } else if (videoUrl) {
                appliedSrcRef.current = { url: videoUrl, headersStr: '' };
              }
            }}
            onCanPlay={() => {
              hasPlayedOrCanPlayRef.current = true;
              clearPrerollWatchdog();
              pushNativeLog('canplay', `dur=${videoRef.current?.duration ?? '-'}`);
              sendEventToWeb({
                name: 'canplay',
                duration: videoRef.current?.duration,
                currentTime: videoRef.current?.currentTime,
                audioTracks: extractAudioTracks(),
                textTracks: extractTextTracks(),
              });
            }}
            onLoadedMetadata={() => {
              pushNativeLog('loadedmetadata', `dur=${videoRef.current?.duration ?? '-'}`);
              sendEventToWeb({
                name: 'loadedmetadata',
                duration: videoRef.current?.duration,
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
                duration: videoRef.current?.duration ?? 0,
                diagnosticLogs: [...nativeLogsRef.current],
              });
            }}
            onStalled={() => {
              pushNativeLog('stalled');
              sendEventToWeb({
                name: 'stalled',
                readyState: videoRef.current?.readyState ?? 0,
                networkState: videoRef.current?.networkState ?? 0,
                duration: videoRef.current?.duration ?? 0,
                diagnosticLogs: [...nativeLogsRef.current],
              });
            }}
            onSeeked={() => {
              if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
                seekTimeoutRef.current = null;
              }
              isSeekingRef.current = false;
              const current = videoRef.current?.currentTime;
              sendEventToWeb({
                name: 'seeked',
                currentTime:
                  typeof current === 'number' && !Number.isNaN(current)
                    ? current
                    : targetSeekSecRef.current,
              });
            }}
            onTimeUpdate={() => {
              const current = videoRef.current?.currentTime;
              if (
                isSeekingRef.current &&
                typeof current === 'number' &&
                Math.abs(current - targetSeekSecRef.current) > 2.0
              ) {
                return;
              }
              sendEventToWeb({
                name: 'timeupdate',
                currentTime: current,
                duration: videoRef.current?.duration,
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
        onError={({
          nativeEvent: {code, url, description},
        }: WebViewErrorEvent) => {
          const message = description || `WebView failed to load ${url}`;
          console.error(`[onError]: (${code}: ${url}) ${message}`);
          hideSplashScreenCallback();
          forwardNativeError('webview-load-error', message, code || 4, {url});
        }}
        onHttpError={({
          nativeEvent: {url, statusCode: code, description, isMainFrame},
        }: WebViewHttpErrorEvent) => {
          const message = description || `HTTP ${code} while loading ${url}`;
          console.error(`[onHttpError]: (${code}: ${url}) ${message}`);
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
