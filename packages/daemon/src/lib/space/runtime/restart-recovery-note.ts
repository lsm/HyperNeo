import type { NodeExecution } from '@hyperneo/shared';

export const RESTART_RECOVERY_NOTE_KEY = 'restartRecoveryNote';

export function readRestartRecoveryNote(execution: NodeExecution): string | null {
  const note = execution.data?.[RESTART_RECOVERY_NOTE_KEY];
  return typeof note === 'string' && note.length > 0 ? note : null;
}
