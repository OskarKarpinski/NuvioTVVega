import type {KeplerTurboModule} from '@amazon-devices/keplerscript-turbomodule-api';
import {TurboModuleRegistry} from '@amazon-devices/keplerscript-turbomodule-api';

export type MediaProxyConfig = {
  sessionId: string;
  url: string;
  /** HTTP headers formatted as "Key: Value\n" pairs (LF terminator on Vega). */
  headers: string;
  /** Start time in seconds; used for seeks by restarting the remux. */
  startTimeSec: number;
  /** Output audio stream to mark as default; -1 keeps the source order. */
  audioTrackIndex?: number;
  /** Number of audio streams exposed by the native player, for dispositions. */
  audioTrackCount?: number;
};

export type MediaProxyResult = {
  /** file:// URI of the locally remuxed MKV, the only src given to <Video>. */
  localUrl: string;
  cachePath: string;
  logPath: string;
  error?: string;
};

export type MediaProxyStatus = {
  state: string;
  bytesWritten: number;
  exitCode: number;
  error: string;
  log: string;
  selfTest?: string;
};

export interface NuvioMediaProxy extends KeplerTurboModule {
  startProxy: (config: MediaProxyConfig) => MediaProxyResult;
  stopProxy: (sessionId: string) => boolean;
  proxyStatus: (sessionId: string) => MediaProxyStatus;
  readProxyLog: (sessionId: string) => string;
}

export default TurboModuleRegistry.getEnforcing<NuvioMediaProxy>(
  'NuvioMediaProxy',
);
