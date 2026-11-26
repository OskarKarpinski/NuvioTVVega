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
  const seekTimeoutRef = useRef<any>(null);
  const isSeekingRef = useRef<boolean>(false);
  const targetSeekSecRef = useRef<number>(0);
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

  const extractAudioTracks = useCallback(() => {
    const tracks: Array<{index: number; label: string; language: string; enabled: boolean}> = [];
    try {
      const list = videoRef.current?.audioTracks;
      if (list && typeof list.length === 'number') {
        for (let i = 0; i < list.length; i++) {
          const item = list[i];
          if (item) {
            tracks.push({
              index: i,
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
                setVideoUrl(payload.url);
              }
              break;
            case 'prepare':
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
                });
              }
              break;
            case 'play':
              try {
                videoRef.current?.play()?.catch?.((err: any) => {
                  console.error('[VegaPlayer] play failed:', err);
                  sendEventToWeb({
                    name: 'error',
                    error: err?.message || 'Playback failed to start',
                  });
                });
              } catch (err: any) {
                console.error('[VegaPlayer] play error:', err);
                sendEventToWeb({
                  name: 'error',
                  error: err?.message || 'Playback failed to start',
                });
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
              setVideoUrl('');
              break;
          }
        }
      } catch (_) {
        // Ignore non-JSON messages from web content.
      }
    },
    [sendEventToWeb, extractAudioTracks],
  );

  return (
    <View style={styles.container}>
      {videoUrl ? (
        <View style={styles.nativeVideoContainer}>
          <Video
            ref={videoRef}
            key={videoUrl}
            src={videoUrl}
            width={WINDOW_WIDTH || 1920}
            height={WINDOW_HEIGHT || 1080}
            controls={false}
            playsInline={true}
            showCaptions={false}
            scalingmode="fit"
            onCanPlay={() => {
              sendEventToWeb({
                name: 'canplay',
                duration: videoRef.current?.duration,
                currentTime: videoRef.current?.currentTime,
                audioTracks: extractAudioTracks(),
              });
            }}
            onLoadedMetadata={() => {
              sendEventToWeb({
                name: 'loadedmetadata',
                duration: videoRef.current?.duration,
                audioTracks: extractAudioTracks(),
              });
            }}
            onPlaying={() => sendEventToWeb({name: 'playing'})}
            onPause={() => sendEventToWeb({name: 'pause'})}
            onWaiting={() => sendEventToWeb({name: 'waiting'})}
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
              const msg = mediaErr
                ? `${mediaErr.message || 'Playback error'} (code ${mediaErr.code})`
                : err?.message || 'Native player error';
              console.error('[Vega Video onError]', msg, err);
              sendEventToWeb({name: 'error', error: msg});
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
