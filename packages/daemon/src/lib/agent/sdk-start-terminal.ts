import type { SDKMessage } from '@hyperneo/shared/sdk';

import { isMeaningfulSdkStartupProgress } from './sdk-startup-progress.ts';

export type SdkStartExitInfo = {
  code: number | null;
  signal: string | null;
};

export type SdkStartInactivity = {
  elapsedMs: number;
  lastActivityAt: number | null;
};

export type SdkStartObservation = {
  processExit: SdkStartExitInfo | null;
  streamClosed: boolean;
  messages: SDKMessage[];
  inactivity: SdkStartInactivity | null;
};

export type SdkStartClassification =
  | { outcome: 'alive'; progress: boolean }
  | { outcome: 'dead'; reason: 'process_exit'; exitInfo: SdkStartExitInfo }
  | { outcome: 'dead'; reason: 'stream_closed' }
  | { outcome: 'backstop'; inactivity: SdkStartInactivity };

export type SdkStartClassifyConfig = {
  inactivityBackstopMs?: number;
};

export function classifySdkStartOutcome(
  observation: SdkStartObservation,
  config: SdkStartClassifyConfig = {}
): SdkStartClassification {
  if (observation.messages.some(isMeaningfulSdkStartupProgress)) {
    return { outcome: 'alive', progress: true };
  }
  if (observation.processExit !== null) {
    return { outcome: 'dead', reason: 'process_exit', exitInfo: observation.processExit };
  }
  if (observation.streamClosed) {
    return { outcome: 'dead', reason: 'stream_closed' };
  }
  if (
    config.inactivityBackstopMs !== undefined &&
    observation.inactivity !== null &&
    observation.inactivity.elapsedMs >= config.inactivityBackstopMs
  ) {
    return { outcome: 'backstop', inactivity: observation.inactivity };
  }
  return { outcome: 'alive', progress: false };
}
