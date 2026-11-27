import * as React from 'react';
import {act, render, waitFor} from '@testing-library/react-native';
import {App, isMainWebviewDocument} from '../src/App';
import NuvioMediaProxy from '../src/turbo-modules/nuviomediaproxy';

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
      localUrl: 'file:///tmp/nuvio-proxy-test.mkv',
      cachePath: '/tmp/nuvio-proxy-test.mkv',
      logPath: '/tmp/nuvio-proxy-test.log',
      state: 'preparing',
      phase: 'download',
      playbackGeneration: 0,
    })),
    preparePlayback: jest.fn((config) => ({
      localUrl: 'file:///tmp/nuvio-proxy-test.mkv',
      state: 'remuxing',
      phase: 'remux',
      playbackGeneration: config.generation,
    })),
    stopProxy: jest.fn(() => true),
    proxyStatus: jest.fn(() => ({
      state: 'ready',
      phase: 'ready',
      bytesWritten: 1024 * 1024,
      masterBytes: 8 * 1024 * 1024,
      exitCode: 0,
      error: '',
      log: '',
      playbackGeneration: 1,
      audioTracks: JSON.stringify([
        {index: 0, language: 'eng', title: 'English', default: true},
        {index: 1, language: 'hin', title: 'Hindi', default: false},
      ]),
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

const readyStatus = (generation: number = 1) => ({
  state: 'ready',
  phase: 'ready',
  bytesWritten: 1024 * 1024,
  masterBytes: 8 * 1024 * 1024,
  exitCode: 0,
  error: '',
  log: '',
  playbackGeneration: generation,
  audioTracks: JSON.stringify([
    {index: 0, language: 'eng', title: 'English', default: true},
    {index: 1, language: 'hin', title: 'Hindi', default: false},
  ]),
});

const openVideo = async () => {
  const rendered = render(<App />);
  const {UNSAFE_getByType} = rendered;
  const webView = UNSAFE_getByType('WebView' as any);
  await act(async () => {
    webView.props.onMessage({
      nativeEvent: {
        data: JSON.stringify({
          type: 'NUVIO_VEGA_PLAYER',
          action: 'open',
          url: 'https://example.test/video.mkv',
          headers: null,
        }),
      },
    });
  });
  return {webView, UNSAFE_getByType, unmount: rendered.unmount};
};

describe('App', () => {
  beforeEach(() => {
    (NuvioMediaProxy.startProxy as jest.Mock).mockClear();
    (NuvioMediaProxy.preparePlayback as jest.Mock).mockClear();
    (NuvioMediaProxy.proxyStatus as jest.Mock).mockReset();
    (NuvioMediaProxy.proxyStatus as jest.Mock).mockReturnValue(readyStatus());
  });

  it('renders without crashing', () => {
    const {toJSON} = render(<App />);
    expect(toJSON()).toBeTruthy();
  });

  it('mounts the native player only after the local file is complete', async () => {
    const proxyStatus = NuvioMediaProxy.proxyStatus as jest.Mock;
    proxyStatus.mockReturnValue({
      state: 'preparing',
      phase: 'download',
      bytesWritten: 0,
      masterBytes: 0,
      exitCode: 0,
      error: '',
      log: '',
      playbackGeneration: 0,
    });
    const rendered = render(<App />);
    const {UNSAFE_getByType, UNSAFE_queryByType} = rendered;
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
    expect(UNSAFE_queryByType('Video' as any)).toBeNull();

    proxyStatus.mockReturnValue(readyStatus());
    await waitFor(() => {
      const video = UNSAFE_getByType('Video' as any);
      expect(String(video.props.src)).toBe('file:///tmp/nuvio-proxy-test.mkv');
    });
    rendered.unmount();
  });

  it('rebuilds from the local master when audio changes, never re-downloading', async () => {
    const proxyStatus = NuvioMediaProxy.proxyStatus as jest.Mock;
    const preparePlayback = NuvioMediaProxy.preparePlayback as jest.Mock;
    proxyStatus.mockImplementation(() => {
      const call = preparePlayback.mock.calls[0];
      return readyStatus(call ? call[0].generation : 1);
    });
    const {webView, UNSAFE_getByType, unmount} = await openVideo();
    await waitFor(() => expect(UNSAFE_getByType('Video' as any)).toBeTruthy());

    await act(async () => {
      webView.props.onMessage({
        nativeEvent: {
          data: JSON.stringify({
            type: 'NUVIO_VEGA_PLAYER',
            action: 'selectAudioTrack',
            index: 1,
            trackCount: 2,
          }),
        },
      });
    });

    await waitFor(() => expect(preparePlayback).toHaveBeenCalled());
    const config = preparePlayback.mock.calls[0][0];
    expect(config.audioTrackIndex).toBe(1);
    expect(config.audioTrackCount).toBe(2);
    expect(config.sessionId).toBeTruthy();
    expect(NuvioMediaProxy.startProxy).toHaveBeenCalledTimes(1);

    await waitFor(() => expect(UNSAFE_getByType('Video' as any)).toBeTruthy());
    unmount();
  });

  it('ignores an early EOS instead of leaving the player or showing an error', async () => {
    const startProxy = NuvioMediaProxy.startProxy as jest.Mock;
    const {UNSAFE_getByType, unmount} = await openVideo();
    await waitFor(() => expect(UNSAFE_getByType('Video' as any)).toBeTruthy());

    const video = UNSAFE_getByType('Video' as any);
    await act(async () => {
      video.props.onEnded();
    });

    expect(startProxy).toHaveBeenCalledTimes(1);
    expect(NuvioMediaProxy.preparePlayback).not.toHaveBeenCalled();
    unmount();
  });

  it('treats only the app document as a WebView load failure', () => {
    expect(isMainWebviewDocument('file:///pkg/assets/web/index.html')).toBe(
      true,
    );
    expect(isMainWebviewDocument('file:///pkg/assets/web/index.html?v=2')).toBe(
      true,
    );
    expect(isMainWebviewDocument(undefined)).toBe(true);
    expect(isMainWebviewDocument('')).toBe(true);
    expect(
      isMainWebviewDocument('https://image.tmdb.org/t/p/w780/poster.jpg'),
    ).toBe(false);
    expect(isMainWebviewDocument('file:///pkg/assets/web/app.bundle.js')).toBe(
      false,
    );
  });
});
