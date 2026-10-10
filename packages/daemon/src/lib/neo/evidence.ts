export type NeoEvidenceState = 'pending' | 'waiting' | 'ready' | 'done' | 'failed';

export interface NeoEvidence {
  key: string;
  state: NeoEvidenceState;
  summary: string;
  blockers: string[];
}

export type NeoEvidenceTold = {
  signature: string;
  toldAt: number | null;
  reminded: string | null;
};

const NEO_EVIDENCE_STALE_MS = 30 * 60_000;
const NEO_EVIDENCE_READY_MS = 30 * 60_000;

export const neoEvidenceSignature = (evidence: readonly NeoEvidence[]) =>
  JSON.stringify(
    [...evidence]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(({ key, state, summary, blockers }) => [key, state, summary, blockers])
  );

export function planNeoDoneCheck(
  evidence: readonly NeoEvidence[],
  told: NeoEvidenceTold | null,
  read: { ok: boolean; okAt: number },
  now: number,
  card: { quietSince: number; remindable: boolean }
): 'wait' | 'unchanged' | 'deliver' | 'remind' {
  const signature = neoEvidenceSignature(evidence);
  const seen = told?.signature === signature;
  if (!read.ok) return !seen && now - read.okAt >= NEO_EVIDENCE_STALE_MS ? 'deliver' : 'wait';
  if (evidence.some((item) => item.state === 'waiting')) return 'wait';
  if (!seen) return 'deliver';
  const stalled =
    evidence.some((item) => item.state === 'ready') &&
    card.remindable &&
    told.reminded !== signature &&
    now - (told.toldAt ?? 0) >= NEO_EVIDENCE_READY_MS &&
    now - card.quietSince >= NEO_EVIDENCE_READY_MS;
  return stalled ? 'remind' : 'unchanged';
}
