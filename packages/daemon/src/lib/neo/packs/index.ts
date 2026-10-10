import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { combineNeoEvidenceReads, type NeoEvidenceRead } from '../evidence.ts';
import { CODING_PACK_BRIEF } from './coding/pack.ts';
import type { NeoPack, NeoPackBrief, NeoPackFragment } from './types.ts';

export const NEO_DEFAULT_PACKS = ['coding'];

export const NEO_BUILTIN_PACK_BRIEFS: readonly NeoPackBrief[] = [CODING_PACK_BRIEF];

export function neoPackBriefs(
  enabled: readonly string[],
  installed: readonly NeoPackBrief[] = NEO_BUILTIN_PACK_BRIEFS
): NeoPackBrief[] {
  const seen = new Set<string>();
  return installed.filter((brief) => {
    if (seen.has(brief.id) || !enabled.includes(brief.id)) return false;
    seen.add(brief.id);
    return true;
  });
}

export function requireNeoAskPack(
  pack: string | undefined,
  enabled: readonly NeoPack[]
): { value: string | null } | { reason: { ok: false; reason: string } } {
  if (!pack) return { value: null };
  return enabled.some((item) => item.id === pack)
    ? { value: pack }
    : {
        reason: {
          ok: false,
          reason: `pack_not_enabled: "${pack}" is not an enabled pack (enabled: ${enabled.map((item) => item.id).join(', ') || 'none'}). Open the ask without pack, or enable the pack first.`,
        },
      };
}

export function neoPackFragment(
  ask: NeoAsk | null | undefined,
  installed: readonly NeoPack[]
): NeoPackFragment | null {
  const id = ask?.pack;
  if (!id) return null;
  const instructions = installed.find((pack) => pack.id === id)?.instructions(ask ?? null) ?? null;
  return instructions ? { id, instructions } : null;
}

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
