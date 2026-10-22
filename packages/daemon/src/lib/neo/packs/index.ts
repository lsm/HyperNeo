import { CODING_PACK_BRIEF } from './coding/pack.ts';
import { LIFE_ADMIN_PACK_BRIEF } from './life-admin/pack.ts';
import type { NeoPack, NeoPackBrief } from '../pack-contract.ts';

export const NEO_DEFAULT_PACKS = ['coding'];

export function neoEnabledPacks(settings?: { packs?: string[] }): string[] {
  return [...(settings?.packs ?? NEO_DEFAULT_PACKS)];
}

let fileBriefs: readonly NeoPackBrief[] = [];

export function neoSettingsPackBriefs(settings?: { packs?: string[] }): NeoPackBrief[] {
  return neoPackBriefs(neoEnabledPacks(settings), [...NEO_BUILTIN_PACK_BRIEFS, ...fileBriefs]);
}

export const NEO_BUILTIN_PACK_BRIEFS: readonly NeoPackBrief[] = [
  CODING_PACK_BRIEF,
  LIFE_ADMIN_PACK_BRIEF,
];

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

export function adoptNeoFilePacks(packs: readonly NeoPack[]): readonly NeoPack[] {
  fileBriefs = packs.map((pack) => ({
    id: pack.id,
    describe: pack.describe,
    guidance: pack.instructions() ?? undefined,
  }));
  return packs;
}
