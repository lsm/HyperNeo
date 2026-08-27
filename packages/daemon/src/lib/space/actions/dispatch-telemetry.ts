import { emitStructuredLogEvent } from '../../logger.ts';
import type { DispatchTelemetryEvent } from './dispatcher-pipeline.ts';

export const SPACE_ACTIONS_RATE_LIMIT_ENV = 'HYPERNEO_SPACE_ACTIONS_RATE_LIMIT_PER_MINUTE';

export const RATE_ADMISSION_WINDOW_MS = 60_000;

export interface RateAdmissionOptions {
  maxDispatchesPerWindow: number;
  windowMs: number;
  now?: () => number;
}

export type RateAdmission = () => boolean;

export function emitActionDispatchedEvent(event: DispatchTelemetryEvent): void {
  try {
    const metadata: Record<string, string | number | boolean | null> = {
      action: event.actionName,
      outcome: event.outcome,
      role: event.role,
      spaceId: event.spaceId,
    };
    const optional: Record<string, string | number | undefined> = {
      family: event.family,
      safetyClass: event.safetyClass,
      taskId: event.taskId,
      workflowRunId: event.workflowRunId,
      reason: event.reason,
      elapsedMs: event.elapsedMs,
    };
    for (const [key, value] of Object.entries(optional)) {
      if (value !== undefined) metadata[key] = value;
    }
    emitStructuredLogEvent({
      level: event.outcome === 'failed' ? 'warn' : 'info',
      args: ['action.dispatched'],
      source: 'logger',
      module: 'hyperneo:daemon:space-actions.dispatch',
      metadata,
    });
  } catch {}
}

export function resolveRateAdmissionOptions(
  env: Record<string, string | undefined> = process.env
): RateAdmissionOptions | null {
  const raw = env[SPACE_ACTIONS_RATE_LIMIT_ENV];
  if (raw === undefined || raw.trim() === '') return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return { maxDispatchesPerWindow: parsed, windowMs: RATE_ADMISSION_WINDOW_MS };
}

export function createRateAdmission(options: RateAdmissionOptions | null): RateAdmission {
  if (!options) return () => true;
  const { maxDispatchesPerWindow, windowMs } = options;
  const now = options.now ?? Date.now;
  let windowStart = now();
  let admitted = 0;
  return () => {
    const at = now();
    if (at - windowStart >= windowMs) {
      windowStart = at;
      admitted = 0;
    }
    if (admitted >= maxDispatchesPerWindow) return false;
    admitted++;
    return true;
  };
}
