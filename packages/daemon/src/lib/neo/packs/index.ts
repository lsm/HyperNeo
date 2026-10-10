import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { isNeoAskLive } from '../done-check.ts';
import { combineNeoEvidenceReads, type NeoEvidence, type NeoEvidenceRead } from '../evidence.ts';
import type { NeoPack, NeoPackCheck } from './types.ts';

export const NEO_DEFAULT_PACKS = ['coding'];

export function neoPacks(input: {
  builtins: readonly NeoPack[];
  filePacks: readonly NeoPack[];
  enabled: readonly string[];
}): NeoPack[] {
  const seen = new Set<string>();
  return [...input.builtins, ...input.filePacks].filter((pack) => {
    if (seen.has(pack.id) || !input.enabled.includes(pack.id)) return false;
    seen.add(pack.id);
    return true;
  });
}

export async function readNeoPackEvidence(
  packs: readonly NeoPack[],
  work: NeoWork,
  warn: (id: string, error: unknown) => void
): Promise<NeoEvidenceRead | null> {
  return combineNeoEvidenceReads(
    await Promise.all(
      packs.map((pack) =>
        pack.readEvidence?.(work).catch((error: unknown) => {
          warn(pack.id, error);
          return null;
        })
      )
    )
  );
}

export function neoPackChecks(packs: readonly NeoPack[]): Record<string, NeoPackCheck> {
  return Object.assign({}, ...[...packs].reverse().map((pack) => pack.checks ?? {}));
}

export function requireNeoPackTickable(read: {
  ask: NeoAsk | null;
}): { value: NeoAsk } | { reason: null } {
  return read.ask &&
    isNeoAskLive(read.ask) &&
    (read.ask.doneItems ?? []).some((item) => item.check && !item.removed && item.state !== 'met')
    ? { value: read.ask }
    : { reason: null };
}

export function planNeoPackTicks(
  ask: NeoAsk | null,
  evidence: readonly NeoEvidence[],
  checks: Record<string, NeoPackCheck>
): { id: string; evidence: string }[] {
  if (!ask || !isNeoAskLive(ask) || !evidence.length) return [];
  return (ask.doneItems ?? []).flatMap((item) => {
    const check = item.check && !item.removed && item.state !== 'met' ? checks[item.check] : null;
    const gate = check ? check(item, evidence) : null;
    return gate && 'value' in gate ? [{ id: item.id, evidence: gate.value }] : [];
  });
}
