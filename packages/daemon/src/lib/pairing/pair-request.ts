import { createHash } from 'node:crypto';

export interface PairRequest {
  code: string;
  name: string;
  requestId?: string;
}

export interface PairRequestRecord {
  id: string;
  approved: boolean;
  requestedName: string | null;
  requestedBy: string | null;
  voided: boolean;
}

export type PairRequestStep = 'refuse' | 'record' | 'wait' | 'redeem' | 'void' | 'voided';

export const requesterOf = ({ requestId }: PairRequest): string | null =>
  requestId ? createHash('sha256').update(requestId).digest('hex') : null;

export function decidePairRequest(
  record: PairRequestRecord | undefined,
  request: PairRequest
): PairRequestStep {
  if (!record) return 'refuse';
  if (record.voided) return 'voided';
  if (record.requestedName === null) return record.approved ? 'redeem' : 'record';
  if (record.requestedName !== request.name || record.requestedBy !== requesterOf(request))
    return 'void';
  return record.approved ? 'redeem' : 'wait';
}
