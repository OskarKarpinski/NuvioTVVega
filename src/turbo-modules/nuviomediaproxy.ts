import type {KeplerTurboModule} from '@amazon-devices/keplerscript-turbomodule-api';
import {TurboModuleRegistry} from '@amazon-devices/keplerscript-turbomodule-api';

export type MediaProxyConfig = {
  sessionId: string;
  url: string;
  /** HTTP headers formatted as "Key: Value\n" pairs (LF terminator on Vega). */
  headers: string;
  /** Initial playback position, applied when the local master is remuxed. */
  startTimeSec: number;
  /** Output audio stream to mark as default; -1 uses the first stream. */
  audioTrackIndex?: number;
  /** Number of audio streams exposed by the player, for dispositions. */
  audioTrackCount?: number;
};

export type MediaPlaybackConfig = {
  sessionId: string;
  /** Source position to start the generated local file from. */
  startTimeSec: number;
  audioTrackIndex: number;
  audioTrackCount: number;
  /** Monotonic token so the caller can ignore superseded rebuilds. */
  generation: number;
};

export type MediaProxyResult = {
  /** file:// URI of the completed local playback file. */
  localUrl: string;
  cachePath: string;
  logPath: string;
  state: string;
  phase: string;
  playbackGeneration: number;
  /** JSON array of audio streams discovered in the local master. */
  audioTracks?: string;
  error?: string;
};

export type MediaProxyStatus = {
  /** preparing | remuxing | ready | error | missing */
  state: string;
  phase: string;
  bytesWritten: number;
  masterBytes: number;
  exitCode: number;
  error: string;
  log: string;
  /** JSON array of audio streams discovered from ffmpeg's stream list. */
  audioTracks?: string;
  selfTest?: string;
  playbackGeneration: number;
  playbackInFlightGeneration?: number;
  playbackDone?: number;
  playbackReady?: number;
  playbackDiagnostic?: string;
  masterComplete?: number;
};

export interface NuvioMediaProxy extends KeplerTurboModule {
  /** Starts a one-time download into a local master file. Returns immediately. */
  startProxy: (config: MediaProxyConfig) => MediaProxyResult;
  /** Rebuilds the playback file from the local master (no network access). */
  preparePlayback: (config: MediaPlaybackConfig) => MediaProxyResult;
  stopProxy: (sessionId: string) => boolean;
  proxyStatus: (sessionId: string) => MediaProxyStatus;
  readProxyLog: (sessionId: string) => string;
}

export default TurboModuleRegistry.getEnforcing<NuvioMediaProxy>(
  'NuvioMediaProxy',
);
