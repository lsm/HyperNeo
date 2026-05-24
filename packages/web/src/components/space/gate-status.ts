/**
 * Shared gate-status evaluation mirroring the canvas runtime logic.
 *
 * Used by:
 * - useRuntimeCanvasData.ts — derives ResolvedWorkflowChannel.runtimeStatus
 * - PendingGateBanner.tsx — surfaces pending human-approval gates in the thread
 *
 * Keep these in sync with the daemon's channel evaluator. An external-approval
 * gate is one where a human writes `approved` (the field's `writers` array is
 * empty). While `approved` is neither `true` nor `false`, the gate is
 * `waiting_human`; `true` → `open`, `false` → `blocked` (rejected).
 */

import type { Gate, GateField } from '@neokai/shared';

export type GateStatus = 'open' | 'blocked' | 'waiting_human';

interface GateScriptResultData {
  success: boolean;
  reason?: string;
}

export function parseScriptResult(data: Record<string, unknown>): {
  failed: boolean;
  reason?: string;
} {
  const raw = data._scriptResult;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { failed: false };
  const sr = raw as Partial<GateScriptResultData>;
  if (sr.success === false) {
    return { failed: true, reason: typeof sr.reason === 'string' ? sr.reason : undefined };
  }
  return { failed: false };
}

export function evalFieldStatus(field: GateField, data: Record<string, unknown>): GateStatus {
  const check = field.check;
  if (check.op === 'count') {
    const map = data[field.name];
    if (!map || typeof map !== 'object' || Array.isArray(map)) return 'blocked';
    const count = Object.values(map as Record<string, unknown>).filter(
      (v) => v === check.match
    ).length;
    return count >= check.min ? 'open' : 'blocked';
  }
  const val = data[field.name];
  if (check.op === 'exists') return val !== undefined ? 'open' : 'blocked';
  if (check.op === '==') return val === check.value ? 'open' : 'blocked';
  if (check.op === '!=') return val !== check.value ? 'open' : 'blocked';
  return 'blocked';
}

export function isExternalApprovalGate(fields: GateField[]): boolean {
  return fields.some((f) => f.name === 'approved' && f.writers.length === 0);
}

export function evaluateGateStatus(
  gate: Gate,
  data: Record<string, unknown>,
  scriptFailed = false
): GateStatus {
  if (scriptFailed) return 'blocked';
  if ((gate.fields ?? []).length === 0) return 'open';
  if (isExternalApprovalGate(gate.fields ?? [])) {
    const val = data['approved'];
    if (val === true) {
      const othersPassed = (gate.fields ?? []).every((f) => {
        if (f.name === 'approved') return true;
        return evalFieldStatus(f, data) === 'open';
      });
      return othersPassed ? 'open' : 'blocked';
    }
    if (val === false) return 'blocked';
    return 'waiting_human';
  }
  for (const field of gate.fields ?? []) {
    const status = evalFieldStatus(field, data);
    if (status !== 'open') return status;
  }
  return 'open';
}
