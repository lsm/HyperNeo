import type { NeoPack, NeoPackBrief } from './pack-contract.ts';

export function neoEnabledPacks(
  settings: { packs?: string[] } | undefined,
  defaults: readonly string[]
): string[] {
  return [...(settings?.packs ?? defaults)];
}

export function neoPackBriefs(
  enabled: readonly string[],
  installed: readonly NeoPackBrief[]
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
