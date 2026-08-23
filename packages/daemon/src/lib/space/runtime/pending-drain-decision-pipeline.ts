import type { PendingAgentMessageRecord } from '../../../storage/repositories/pending-agent-message-repository';
import { decisionRun } from './decision-pipeline';
import {
  type PendingDrainAdmission,
  type PendingQueueListing,
  selectDrainablePendingRows,
} from './pending-drain-gates';

export type PendingDrainDecision =
  | { action: 'drain'; rows: PendingAgentMessageRecord[] }
  | { action: 'skip'; reason: 'no_pending_rows' | 'no_drainable_rows' };

export interface PendingDrainInput {
  listings: readonly PendingQueueListing[];
  admission: PendingDrainAdmission;
}

export interface PendingDrainCtx extends PendingDrainInput {
  decision: PendingDrainDecision | null;
}

function decided(ctx: PendingDrainCtx, decision: PendingDrainDecision): PendingDrainCtx {
  return { ...ctx, decision };
}

export function applyEmptyListingsGate(ctx: PendingDrainCtx): PendingDrainCtx {
  return ctx.listings.every((listing) => listing.rows.length === 0)
    ? decided(ctx, { action: 'skip', reason: 'no_pending_rows' })
    : ctx;
}

export function applyDrainableRowsGate(ctx: PendingDrainCtx): PendingDrainCtx {
  const rows = selectDrainablePendingRows(ctx.listings, ctx.admission);
  return rows.length > 0 ? decided(ctx, { action: 'drain', rows }) : ctx;
}

export function applyNoDrainableRowsGate(ctx: PendingDrainCtx): PendingDrainCtx {
  return decided(ctx, { action: 'skip', reason: 'no_drainable_rows' });
}

const pendingDrainDecisionRun = decisionRun('pending-drain-admission', [
  applyEmptyListingsGate,
  applyDrainableRowsGate,
  applyNoDrainableRowsGate,
]);

export function decidePendingDrainAdmission(input: PendingDrainInput): PendingDrainDecision {
  return pendingDrainDecisionRun(input).decision ?? { action: 'skip', reason: 'no_drainable_rows' };
}
