import {WebView} from '@amazon-devices/webview';
import * as React from 'react';
import {useCallback, useRef} from 'react';
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
          const video = videoRef.current;
          if (!video) {
            return;
          }

          switch (action) {
            case 'open':
              if (payload.url) {
                video.src = payload.url;
              }
              break;
            case 'prepare':
              if (
                video.readyState >= 2 ||
                (video.duration && video.duration > 0)
              ) {
                sendEventToWeb({
                  name: 'canplay',
                  duration: video.duration,
                  currentTime: video.currentTime,
                });
              }
              break;
            case 'play':
              try {
                video.play()?.catch?.((err: any) => {
                  console.error('[VegaPlayer] play failed:', err);
                  sendEventToWeb({name: 'error', error: String(err)});
                });
              } catch (err) {
                console.error('[VegaPlayer] play error:', err);
                sendEventToWeb({name: 'error', error: String(err)});
              }
              break;
            case 'pause':
              try {
                video.pause();
              } catch (err) {
                console.warn('[VegaPlayer] pause error:', err);
              }
              break;
            case 'seek':
              if (typeof payload.positionMs === 'number') {
                try {
                  video.currentTime = Math.max(0, payload.positionMs / 1000);
                } catch (err) {
                  console.warn('[VegaPlayer] seek error:', err);
                }
              }
              break;
            case 'rate':
              if (typeof payload.rate === 'number') {
                try {
                  video.playbackRate = payload.rate;
                } catch (err) {
                  console.warn('[VegaPlayer] rate error:', err);
                }
              }
              break;
            case 'stop':
              try {
                video.pause();
              } catch (err) {
                console.warn('[VegaPlayer] stop error:', err);
              }
              break;
            case 'close':
              try {
                video.pause();
                video.src = '';
              } catch (err) {
                console.warn('[VegaPlayer] close error:', err);
              }
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
      <View style={styles.nativeVideoContainer}>
        <Video
          ref={videoRef}
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
            console.error('[Vega Video onError]', err);
            sendEventToWeb({name: 'error', error: String(err)});
          }}
        />
      </View>
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
