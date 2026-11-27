import * as React from 'react';
import {act, render, waitFor} from '@testing-library/react-native';
import {App, isMainWebviewDocument} from '../src/App';

jest.mock('@amazon-devices/webview', () => ({
  WebView: 'WebView',
}));

jest.mock('@amazon-devices/react-native-w3cmedia', () => ({
  Video: 'Video',
}));

jest.mock('../src/turbo-modules/nuviomediaproxy', () => ({
  __esModule: true,
  default: {
    startProxy: jest.fn(() => ({
      localUrl: 'http://127.0.0.1:12345/stream.mkv',
      port: 12345,
      cachePath: '/tmp/nuvio-proxy-test.mkv',
      logPath: '/tmp/nuvio-proxy-test.log',
      sourceBytes: 0,
    })),
    stopProxy: jest.fn(() => true),
    proxyStatus: jest.fn(() => ({
      state: 'streaming',
      bytesWritten: 0,
      diskBytes: 0,
      punchedBytes: 0,
      exitCode: 0,
      error: '',
      needsRestart: false,
    })),
    readProxyLog: jest.fn(() => ''),
  },
}));

jest.mock('@amazon-devices/react-native-kepler', () => ({
  usePreventHideSplashScreen: jest.fn(),
  useHideSplashScreenCallback: jest.fn(() => jest.fn()),
  BackHandler: {exitApp: jest.fn()},
  Dimensions: {get: () => ({width: 1920, height: 1080})},
  StyleSheet: {
    absoluteFillObject: {},
    create: (styles: unknown) => styles,
  },
  View: 'View',
}));

describe('App', () => {
  it('renders without crashing', () => {
    const {toJSON} = render(<App />);
    expect(toJSON()).toBeTruthy();
  });

  it('only mounts the native player on a local proxy URL', async () => {
    const {UNSAFE_getByType} = render(<App />);
    const webView = UNSAFE_getByType('WebView' as any);

    await act(async () => {
      webView.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'NUVIO_VEGA_PLAYER',
            action: 'open',
            url: 'https://pixeldrain.dev/api/file/7raRDQU4?download',
            headers: null,
          }),
        },
      });
    });

    await waitFor(() => {
      const video = UNSAFE_getByType('Video' as any);
      expect(String(video.props.src)).toMatch(/^http:\/\/127\.0\.0\.1:/);
    });
  });

  it('treats only the app document as a WebView load failure', () => {
    expect(isMainWebviewDocument('file:///pkg/assets/web/index.html')).toBe(true);
    expect(isMainWebviewDocument('file:///pkg/assets/web/index.html?v=2')).toBe(true);
    expect(isMainWebviewDocument(undefined)).toBe(true);
    expect(isMainWebviewDocument('')).toBe(true);
    expect(isMainWebviewDocument('https://image.tmdb.org/t/p/w780/poster.jpg')).toBe(false);
    expect(isMainWebviewDocument('file:///pkg/assets/web/app.bundle.js')).toBe(false);
  });
});
