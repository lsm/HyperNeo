import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const EVENT_LOOP_STALL_MARKER_FILE = 'event-loop-stall.json';

export interface EventLoopStallMarker {
  pid?: number;
  detectedAt?: number;
  stallMs?: number;
  action?: string;
  reason?: string;
}

export function eventLoopStallMarkerPath(directory: string): string {
  return join(directory, EVENT_LOOP_STALL_MARKER_FILE);
}

export function readAndClearEventLoopStallMarker(path: string): EventLoopStallMarker | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    rmSync(path, { force: true });
  } catch {}
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as EventLoopStallMarker) : null;
  } catch {
    return null;
  }
}

export function describeEventLoopStallMarker(marker: EventLoopStallMarker): string {
  const when = marker.detectedAt ? new Date(marker.detectedAt).toISOString() : 'an unknown time';
  const what = marker.reason ?? 'the event loop stalled';
  const action = marker.action === 'killed' ? 'was killed' : 'was left running';
  return `previous daemon (pid ${marker.pid ?? 'unknown'}) ${action} at ${when}: ${what}`;
}
