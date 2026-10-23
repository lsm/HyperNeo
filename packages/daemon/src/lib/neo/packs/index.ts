import {
  neoEnabledPacks as selectEnabledPacks,
  neoPackBriefs as selectPackBriefs,
} from '../pack-selection.ts';
export { neoPacks } from '../pack-selection.ts';
export const NEO_DEFAULT_PACKS = ['coding'];
export function neoEnabledPacks(settings?: { packs?: string[] }): string[] {
  return selectEnabledPacks(settings, NEO_DEFAULT_PACKS);
}
import { CODING_PACK_BRIEF } from './coding/pack.ts';
import { LIFE_ADMIN_PACK_BRIEF } from './life-admin/pack.ts';
import type { NeoPack, NeoPackBrief } from '../pack-contract.ts';

let fileBriefs: readonly NeoPackBrief[] = [];

export function neoSettingsPackBriefs(settings?: { packs?: string[] }): NeoPackBrief[] {
  return neoPackBriefs(neoEnabledPacks(settings), [...NEO_BUILTIN_PACK_BRIEFS, ...fileBriefs]);
}

export const NEO_BUILTIN_PACK_BRIEFS: readonly NeoPackBrief[] = [
  CODING_PACK_BRIEF,
  LIFE_ADMIN_PACK_BRIEF,
];

export function adoptNeoFilePacks(packs: readonly NeoPack[]): readonly NeoPack[] {
  fileBriefs = packs.map((pack) => ({
    id: pack.id,
    describe: pack.describe,
    guidance: pack.instructions() ?? undefined,
  }));
  return packs;
}

export function neoPackBriefs(
  enabled: readonly string[],
  installed: readonly NeoPackBrief[] = NEO_BUILTIN_PACK_BRIEFS
): NeoPackBrief[] {
  return selectPackBriefs(enabled, installed);
}
