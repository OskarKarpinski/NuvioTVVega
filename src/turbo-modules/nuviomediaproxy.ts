import type {KeplerTurboModule} from '@amazon-devices/keplerscript-turbomodule-api';
import {TurboModuleRegistry} from '@amazon-devices/keplerscript-turbomodule-api';

export type MediaProxyConfig = {
  sessionId: string;
  url: string;
  /** HTTP headers formatted as "Key: Value\n" pairs (LF terminator on Vega). */
  headers: string;
  /** Source position the first bounded segment starts at. */
  startTimeSec: number;
  /** Output audio stream to mark as default; -1 uses the first stream. */
  audioTrackIndex?: number;
  /** Number of audio streams exposed by the player, for dispositions. */
  audioTrackCount?: number;
  /** Source generation shared with waitForPlaybackReady. */
  generation: number;
};

export type MediaPlaybackConfig = {
  sessionId: string;
  /** Source position the rebuilt segment starts at. */
  startTimeSec: number;
  audioTrackIndex: number;
  audioTrackCount: number;
  /** Monotonic token so the caller can ignore superseded rebuilds. */
  generation: number;
};

export type MediaProxyResult = {
  /** file:// URI of the completed local segment. */
  localUrl: string;
  cachePath: string;
  logPath: string;
  /** preparing | ready | error | missing */
  state: string;
  phase: string;
  playbackGeneration: number;
  /** JSON array of audio streams discovered from ffmpeg's stream list. */
  audioTracks?: string;
  error?: string;
};

export type MediaProxyStatus = {
  /** preparing | ready | error | missing */
  state: string;
  phase: string;
  /** Size of the in-flight temp file, or of the completed segment when ready. */
  bytesWritten: number;
  exitCode: number;
  error: string;
  log: string;
  /** JSON array of audio streams discovered from ffmpeg's stream list. */
  audioTracks?: string;
  selfTest?: string;
  /** Generation of the last fully written segment. */
  playbackGeneration: number;
  /** Generation of the current build; kept after exit so segmentDone can be matched. */
  generationInFlight?: number;
  /** 1 once the in-flight ffmpeg process has exited. */
  segmentDone?: number;
  /** 1 when ffmpeg exited cleanly but produced no playable data (true EOF). */
  endOfStream?: number;
  /** Precise diagnostic for a failed rebuild; empty when healthy. */
  playbackDiagnostic?: string;
  localUrl?: string;
  cachePath?: string;
  logPath?: string;
};

export interface NuvioMediaProxy extends KeplerTurboModule {
  /** Starts one bounded local segment from the network. Returns immediately. */
  startProxy: (config: MediaProxyConfig) => MediaProxyResult;
  /** Rebuilds a bounded segment from the network at a new position/audio. */
  preparePlayback: (config: MediaPlaybackConfig) => MediaProxyResult;
  stopProxy: (sessionId: string) => boolean;
  proxyStatus: (sessionId: string) => MediaProxyStatus;
  readProxyLog: (sessionId: string) => string;
}

export default TurboModuleRegistry.getEnforcing<NuvioMediaProxy>(
  'NuvioMediaProxy',
);
