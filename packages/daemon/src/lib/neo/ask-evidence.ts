import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { isNeoAskLive } from './done-check.ts';
import { neoEvidenceSignature, type NeoEvidence } from './evidence.ts';

export const NEO_ASK_EVIDENCE_READ_MS = 15 * 60_000;

export function requireNeoAskEvidenceDue(
  ask: NeoAsk,
  card: { readAt: number | undefined; session: boolean },
  now: number
): { value: NeoAsk } | { reason: null } {
  return isNeoAskLive(ask) &&
    card.session &&
    (card.readAt === undefined || now - card.readAt >= NEO_ASK_EVIDENCE_READ_MS)
    ? { value: ask }
    : { reason: null };
}

const neoToldEvidence = (signature: string | undefined): Map<string, string> => {
  try {
    const rows: unknown = JSON.parse(signature ?? '[]');
    return new Map(
      Array.isArray(rows)
        ? rows.filter(Array.isArray).map((row) => [String(row[0]), JSON.stringify(row)])
        : []
    );
  } catch {
    return new Map();
  }
};

export function planNeoAskEvidenceNote(
  evidence: readonly NeoEvidence[],
  told: { signature: string } | null
): { value: { signature: string; evidence: NeoEvidence[] } } | { reason: 'quiet' | 'told' } {
  if (!evidence.length) return { reason: 'quiet' };
  const before = neoToldEvidence(told?.signature);
  const now = neoToldEvidence(neoEvidenceSignature(evidence));
  const changed = [...now].filter(([key, row]) => before.get(key) !== row).map(([key]) => key);
  if (!changed.length) return { reason: 'told' };
  const union = new Map([...before, ...now]);
  return {
    value: {
      signature: JSON.stringify(
        [...union.keys()].sort().map((key) => JSON.parse(union.get(key)!) as unknown)
      ),
      evidence: evidence
        .filter((item) => changed.includes(item.key))
        .sort((a, b) => a.key.localeCompare(b.key)),
    },
  };
}
