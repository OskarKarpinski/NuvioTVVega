import type {KeplerTurboModule} from '@amazon-devices/keplerscript-turbomodule-api';
import {TurboModuleRegistry} from '@amazon-devices/keplerscript-turbomodule-api';

export type MediaProxyConfig = {
  sessionId: string;
  url: string;
  /** HTTP headers formatted as "Key: Value\n" pairs (LF terminator on Vega). */
  headers: string;
  /** Optional source size hint in bytes; ffprobe's value takes precedence. */
  totalBytes: number;
  /** Start time in seconds; used for seeks without keeping old cache data. */
  startTimeSec: number;
  /** Hard limit for actually occupied disk space (holes are reclaimed). */
  maxDiskBytes: number;
};

export type MediaProxyResult = {
  localUrl: string;
  port: number;
  cachePath: string;
  logPath: string;
  /** Source size reported by ffprobe, used to estimate the remuxed output. */
  sourceBytes: number;
  error?: string;
};

export type MediaProxyStatus = {
  state: string;
  bytesWritten: number;
  diskBytes: number;
  punchedBytes: number;
  exitCode: number;
  error: string;
  needsRestart: boolean;
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
