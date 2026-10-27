import type { SessionScheduleCadence } from '../../storage/repositories/session-schedule-repository.ts';
import { getNextRunAt } from '../schedule/cron-utils.ts';

export function nextScheduleRun(cadence: SessionScheduleCadence, after: number): number | null {
  return cadence.kind === 'every'
    ? after + cadence.everyMs
    : getNextRunAt(cadence.cron, cadence.timezone, after);
}

export function requireNextRun(cadence: SessionScheduleCadence, after: number): number {
  const next = nextScheduleRun(cadence, after);
  if (next === null) throw new Error('invalid_cadence: the cadence has no next run.');
  return next;
}
