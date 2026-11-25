import {WebView} from '@amazon-devices/webview';
import * as React from 'react';
import {useCallback, useRef, useState} from 'react';
import {BackHandler, StyleSheet, View} from 'react-native';
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

export const App = () => {
  const webRef = useRef<any>(null);
  const videoRef = useRef<any>(null);
  const [videoUrl, setVideoUrl] = useState<string>('');
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

  const handleMessage = useCallback(
    (event: WebViewMessageEvent) => {
      try {
        const payload = JSON.parse(event.nativeEvent.data);
        if (payload?.type === 'NUVIO_EXIT_APP') {
          BackHandler.exitApp();
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
                try {
                  videoRef.current.currentTime = Math.max(
                    0,
                    payload.positionMs / 1000,
                  );
                } catch (err) {
                  console.warn('[VegaPlayer] seek error:', err);
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
              setVideoUrl('');
              break;
          }
        }
      } catch (_) {
        // Ignore non-JSON messages from web content.
      }
    },
    [sendEventToWeb],
  );

  return (
    <View style={styles.container}>
      {videoUrl ? (
        <View style={styles.nativeVideoContainer}>
          <Video
            ref={videoRef}
            key={videoUrl}
            src={videoUrl}
            width={1920}
            height={1080}
            controls={false}
            playsInline={true}
            showCaptions={false}
            scalingmode="fit"
            onCanPlay={() => {
              sendEventToWeb({
                name: 'canplay',
                duration: videoRef.current?.duration,
                currentTime: videoRef.current?.currentTime,
              });
            }}
            onLoadedMetadata={() => {
              sendEventToWeb({
                name: 'loadedmetadata',
                duration: videoRef.current?.duration,
              });
            }}
            onPlaying={() => sendEventToWeb({name: 'playing'})}
            onPause={() => sendEventToWeb({name: 'pause'})}
            onWaiting={() => sendEventToWeb({name: 'waiting'})}
            onSeeked={() => {
              sendEventToWeb({
                name: 'seeked',
                currentTime: videoRef.current?.currentTime,
              });
            }}
            onTimeUpdate={() => {
              sendEventToWeb({
                name: 'timeupdate',
                currentTime: videoRef.current?.currentTime,
                duration: videoRef.current?.duration,
              });
            }}
            onEnded={() => sendEventToWeb({name: 'ended'})}
            onError={(err: any) => {
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
    position: 'absolute',
    top: 0,
    left: 0,
    width: 1920,
    height: 1080,
    zIndex: 0,
  },
  webview: {flex: 1, backgroundColor: 'transparent', zIndex: 1},
});
