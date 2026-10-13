export type NeoEvidenceState = 'pending' | 'waiting' | 'ready' | 'done' | 'failed';

export interface NeoEvidence {
  key: string;
  state: NeoEvidenceState;
  summary: string;
  blockers: string[];
}

export type NeoEvidenceRead = {
  evidence: NeoEvidence[];
  read: { ok: boolean; okAt: number };
};

export function combineNeoEvidenceReads(
  reads: readonly (NeoEvidenceRead | null | undefined)[]
): NeoEvidenceRead | null {
  const found = reads.filter((read): read is NeoEvidenceRead => !!read);
  if (!found.length) return null;
  return {
    evidence: found.flatMap((read) => read.evidence),
    read: {
      ok: found.every((read) => read.read.ok),
      okAt: Math.min(...found.map((read) => read.read.okAt)),
    },
  };
}

export type NeoEvidenceTold = {
  signature: string;
  toldAt: number | null;
  reminded: string | null;
};

const NEO_EVIDENCE_STALE_MS = 30 * 60_000;

export const neoEvidenceSignature = (evidence: readonly NeoEvidence[]) =>
  JSON.stringify(
    [...evidence]
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(({ key, state, summary, blockers }) => [key, state, summary, [...blockers].sort()])
  );

export function planNeoDoneCheck(
  evidence: readonly NeoEvidence[],
  told: NeoEvidenceTold | null,
  read: { ok: boolean; okAt: number },
  now: number
): 'wait' | 'unchanged' | 'deliver' {
  const signature = neoEvidenceSignature(evidence);
  const seen = told?.signature === signature;
  if (!read.ok) return !seen && now - read.okAt >= NEO_EVIDENCE_STALE_MS ? 'deliver' : 'wait';
  if (evidence.some((item) => item.state === 'waiting')) return 'wait';
  return seen ? 'unchanged' : 'deliver';
}
