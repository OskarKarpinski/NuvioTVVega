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
  })();
  true;
`;

const {width: WINDOW_WIDTH, height: WINDOW_HEIGHT} = Dimensions.get('window');

export const App = () => {
  const webRef = useRef<any>(null);
  const videoRef = useRef<any>(null);
  const [videoUrl, setVideoUrl] = useState<string>('');
  const [customHeaders, setCustomHeaders] = useState<Record<string, string> | null>(null);
  const customHeadersRef = useRef<Record<string, string> | null>(null);
  const [showCaptions, setShowCaptions] = useState<boolean>(true);
  const seekTimeoutRef = useRef<any>(null);
  const isSeekingRef = useRef<boolean>(false);
  const targetSeekSecRef = useRef<number>(0);
  const appliedSrcRef = useRef<{url: string; headersStr: string} | null>(null);
  usePreventHideSplashScreen();
  const hideSplashScreenCallback = useHideSplashScreenCallback();

  const sendEventToWeb = useCallback((eventObj: any) => {
    try {
      const serialized = JSON.stringify(eventObj);
      const script = `try { window.__NUVIO_VEGA_PLAYER__ && window.__NUVIO_VEGA_PLAYER__._handleNativeEvent(${serialized}); } catch(_) {}; true;`;
      webRef.current?.injectJavaScript(script);
    } catch (e) {
      console.warn('[Vega] sendEventToWeb error:', e);
    }
  }, []);

  const setVideoSource = useCallback((url: string, headers: Record<string, string> | null) => {
    if (!url) return;
    const target = videoRef.current;
    if (!target) {
      console.warn('[VegaPlayer] videoRef.current is null when setting source for:', url);
      return;
    }
    const headersStr = headers ? JSON.stringify(headers) : '';
    if (
      appliedSrcRef.current &&
      appliedSrcRef.current.url === url &&
      appliedSrcRef.current.headersStr === headersStr
    ) {
      return;
    }
    appliedSrcRef.current = { url, headersStr };

    const player = (target as any)?.mediaPlayer_ || target;
    try {
      if (headers && Object.keys(headers).length > 0 && typeof player?.setSrcWithCustomHeaders === 'function') {
        console.info('[VegaPlayer] Calling player.setSrcWithCustomHeaders with headers:', url, headers);
        player.setSrcWithCustomHeaders(url, headers);
      } else if (typeof player?.setSrcWithCustomHeaders === 'function') {
        console.info('[VegaPlayer] Calling player.setSrcWithCustomHeaders without headers:', url);
        player.setSrcWithCustomHeaders(url, null);
      } else {
        console.info('[VegaPlayer] Setting target.src:', url);
        target.src = url;
      }
    } catch (err) {
      console.warn('[VegaPlayer] setVideoSource error:', err);
    }
  }, []);

  React.useEffect(() => {
    if (videoUrl && videoRef.current) {
      setVideoSource(videoUrl, customHeadersRef.current);
    }
  }, [videoUrl, setVideoSource]);

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
                const headers =
                  payload.headers &&
                  typeof payload.headers === 'object' &&
                  Object.keys(payload.headers).length > 0
                    ? payload.headers
                    : null;
                customHeadersRef.current = headers;
                setCustomHeaders(headers);
                appliedSrcRef.current = null;
                setVideoUrl(payload.url);
                if (videoRef.current) {
                  setVideoSource(payload.url, headers);
                }
              }
              break;
            case 'setHeaders':
              if (payload.headers && typeof payload.headers === 'object') {
                const merged = { ...(customHeadersRef.current || {}), ...payload.headers };
                customHeadersRef.current = merged;
                setCustomHeaders(merged);
                appliedSrcRef.current = null;
                if (videoUrl) {
                  setVideoSource(videoUrl, merged);
                }
              }
              break;
            case 'prepare':
              if (payload.headers && typeof payload.headers === 'object') {
                const merged = { ...(customHeadersRef.current || {}), ...payload.headers };
                customHeadersRef.current = merged;
                setCustomHeaders(merged);
                appliedSrcRef.current = null;
                const targetUrl = payload.url || videoUrl;
                if (targetUrl) {
                  setVideoSource(targetUrl, merged);
                }
              }
              if (
                videoRef.current &&
                (videoRef.current.readyState >= 2 ||
                  (videoRef.current.duration && videoRef.current.duration > 0))
              ) {
                sendEventToWeb({
                  name: 'canplay',
                  duration: videoRef.current.duration,
                  currentTime: videoRef.current.currentTime,
                  audioTracks: extractAudioTracks(),
                  textTracks: extractTextTracks(),
                });
              }
              break;
            case 'play':
              try {
                videoRef.current?.play()?.catch?.((err: any) => {
                  console.warn('[VegaPlayer] play rejected:', err);
                });
              } catch (err: any) {
                console.error('[VegaPlayer] play error:', err);
              }
              break;
            case 'pause':
              try {
                videoRef.current?.pause();
              } catch (err) {
                console.warn('[VegaPlayer] pause error:', err);
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
                  console.warn('[VegaPlayer] seek error:', err);
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
                  console.warn('[VegaPlayer] selectAudioTrack error:', err);
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
                  console.warn('[VegaPlayer] selectTextTrack error:', err);
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
                console.warn('[VegaPlayer] setSilentSubtitle error:', err);
              }
              break;
            case 'rate':
              if (typeof payload.rate === 'number' && videoRef.current) {
                try {
                  videoRef.current.playbackRate = payload.rate;
                } catch (err) {
                  console.warn('[VegaPlayer] rate error:', err);
                }
              }
              break;
            case 'stop':
              try {
                videoRef.current?.pause();
              } catch (err) {
                console.warn('[VegaPlayer] stop error:', err);
              }
              break;
            case 'close':
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
    [sendEventToWeb, extractAudioTracks, extractTextTracks, videoUrl, setVideoSource],
  );

  return (
    <View style={styles.container}>
      {videoUrl ? (
        <View style={styles.nativeVideoContainer}>
          <Video
            ref={videoRef}
            key={videoUrl}
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
              appliedSrcRef.current = null;
              if (videoUrl) {
                setVideoSource(videoUrl, customHeadersRef.current);
              }
            }}
            onCanPlay={() => {
              sendEventToWeb({
                name: 'canplay',
                duration: videoRef.current?.duration,
                currentTime: videoRef.current?.currentTime,
                audioTracks: extractAudioTracks(),
                textTracks: extractTextTracks(),
              });
            }}
            onLoadedMetadata={() => {
              sendEventToWeb({
                name: 'loadedmetadata',
                duration: videoRef.current?.duration,
                audioTracks: extractAudioTracks(),
                textTracks: extractTextTracks(),
              });
            }}
            onPlaying={() => {
              sendEventToWeb({
                name: 'playing',
                audioTracks: extractAudioTracks(),
                textTracks: extractTextTracks(),
              });
            }}
            onPause={() => sendEventToWeb({name: 'pause'})}
            onWaiting={() => sendEventToWeb({name: 'waiting'})}
            onStalled={() => {
              console.warn('[Vega Video onStalled]');
              sendEventToWeb({name: 'stalled'});
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
            onEnded={() => sendEventToWeb({name: 'ended'})}
            onError={(err: any) => {
              if (seekTimeoutRef.current) {
                clearTimeout(seekTimeoutRef.current);
                seekTimeoutRef.current = null;
              }
              isSeekingRef.current = false;
              const mediaErr = err?.target?.error || videoRef.current?.error;
              const code = mediaErr?.code || (typeof err?.code === 'number' ? err.code : 4);
              const msg = mediaErr
                ? `${mediaErr.message || 'Playback error'} (code ${mediaErr.code})`
                : err?.message || 'Native player error';
              console.error('[Vega Video onError]', msg, err, mediaErr);
              sendEventToWeb({
                name: 'error',
                error: msg,
                code,
                details: {
                  message: mediaErr?.message || err?.message,
                  code,
                },
              });
            }}
          />
        </View>
      ) : null}
      <WebView
        ref={webRef}
        style={styles.webview}
        allowFileAccess
        allowFileAccessFromFileURLs
        allowUniversalAccessFromFileURLs
        allowSystemKeyEvents
        allowsDefaultMediaControl={false}
        allowsInlineMediaPlayback
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
          hideSplashScreenCallback();
        }}
        onLoadStart={(_event: WebViewNavigationEvent) => {
          console.info('Page loading started...');
        }}
        onError={({
          nativeEvent: {code, url, description},
        }: WebViewErrorEvent) => {
          console.error(`[onError]: (${code}: ${url}) ${description}`);
        }}
        onHttpError={({
          nativeEvent: {url, statusCode: code, description, isMainFrame},
        }: WebViewHttpErrorEvent) => {
          console.error(`[onHttpError]: (${code}: ${url}) ${description}`);
          console.error(`[onHttpError]: isMainFrame: ${isMainFrame}`);
        }}
        onSslError={({code, url, description}: SslErrorData) => {
          console.error(`[onSslError]: (${code}: ${url}) ${description}`);
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
