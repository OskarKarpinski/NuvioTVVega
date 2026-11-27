import * as React from 'react';
import {render} from '@testing-library/react-native';
import {App, isMainWebviewDocument} from '../src/App';

jest.mock('@amazon-devices/webview', () => ({
  WebView: 'WebView',
}));

jest.mock('@amazon-devices/react-native-w3cmedia', () => ({
  Video: 'Video',
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

  it('treats only the app document as a WebView load failure', () => {
    expect(isMainWebviewDocument('file:///pkg/assets/web/index.html')).toBe(true);
    expect(isMainWebviewDocument('file:///pkg/assets/web/index.html?v=2')).toBe(true);
    expect(isMainWebviewDocument(undefined)).toBe(true);
    expect(isMainWebviewDocument('')).toBe(true);
    expect(isMainWebviewDocument('https://image.tmdb.org/t/p/w780/poster.jpg')).toBe(false);
    expect(isMainWebviewDocument('file:///pkg/assets/web/app.bundle.js')).toBe(false);
  });
});
