import type {
  NeoLine,
  NeoLineRanking,
  NeoLineScope,
  NeoPack,
  NeoPackBrief,
} from './pack-contract.ts';

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
    if (seen.has(brief.id) || (!brief.alwaysEnabled && !enabled.includes(brief.id))) return false;
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
  let ranks = false;
  return [...input.builtins, ...input.filePacks].filter((pack) => {
    if (seen.has(pack.id) || (!pack.alwaysEnabled && !input.enabled.includes(pack.id)))
      return false;
    if (pack.rankLines && ranks) return false;
    ranks ||= Boolean(pack.rankLines);
    seen.add(pack.id);
    return true;
  });
}

/** @public */
export async function chooseLine(
  packs: readonly NeoPack[],
  kind: string,
  candidates: readonly NeoLine[],
  scope: NeoLineScope
): Promise<NeoLineRanking> {
  const ranker = packs.find((pack) => pack.rankLines);
  if (ranker?.rankLines) return ranker.rankLines(kind, candidates, scope);
  return { ranked: candidates.map((line) => ({ line })), skipped: [], exhausted: false };
}
