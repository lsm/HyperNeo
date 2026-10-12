import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import { isNeoAskLive } from '../done-check.ts';
import { combineNeoEvidenceReads, type NeoEvidence, type NeoEvidenceRead } from '../evidence.ts';
import { CODING_PACK_BRIEF } from './coding/pack.ts';
import { requireNeoWorkPrRefresh } from './coding/work-prs.ts';
import { LIFE_ADMIN_PACK_BRIEF } from './life-admin/pack.ts';
import type { NeoPack, NeoPackBrief, NeoPackCheck, NeoPackFragment } from './types.ts';

export const NEO_DEFAULT_PACKS = ['coding'];

export function neoEnabledPacks(settings?: { packs?: string[] }): string[] {
  return [...(settings?.packs ?? NEO_DEFAULT_PACKS)];
}

let fileBriefs: readonly NeoPackBrief[] = [];

export function adoptNeoFilePacks(packs: readonly NeoPack[]): readonly NeoPack[] {
  fileBriefs = packs.map((pack) => ({
    id: pack.id,
    describe: pack.describe,
    guidance: pack.instructions(null) ?? undefined,
  }));
  return packs;
}

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

export function neoPackAskCardEvidence(
  packs: readonly NeoPack[],
  ask: NeoAsk,
  works: readonly NeoWork[]
): NeoEvidence[] {
  const chosen = packs.filter((pack) => !ask.pack || pack.id === ask.pack);
  return [
    ...chosen.flatMap((pack) => pack.askCardEvidence?.(ask, works) ?? []),
    ...works.flatMap((work) => chosen.flatMap((pack) => pack.reportEvidence?.(work) ?? [])),
  ];
}

const NEO_PACK_EVIDENCE_READ_MS = 2 * 60_000;

export function requireNeoEvidenceRefresh<
  Refresh extends { work: { status: string; report: string | null; updatedAt: number } },
  Row extends { readAt: number },
>(
  refresh: Refresh,
  card: {
    goal: boolean;
    row: Row | null;
    session: boolean;
    packEvidence: boolean;
    toldAt: number | null;
  },
  now: number,
  closedDone: string
): { value: Refresh & { row: Row | null } } | { reason: 'not_due' } {
  const pr = requireNeoWorkPrRefresh(
    refresh,
    { row: card.row, session: card.session },
    now,
    closedDone
  );
  if ('value' in pr) return pr;
  const { work } = refresh;
  return card.packEvidence &&
    work.status === 'reported' &&
    work.report !== closedDone &&
    card.goal &&
    card.session &&
    (work.updatedAt > (card.toldAt ?? 0) || now - (card.toldAt ?? 0) >= NEO_PACK_EVIDENCE_READ_MS)
    ? { value: { ...refresh, row: card.row } }
    : { reason: 'not_due' };
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

export function neoPackEvidenceOrNone(
  read: NeoEvidenceRead | null,
  failed: boolean,
  now: number
): NeoEvidenceRead | null {
  return read ?? (failed ? null : { evidence: [], read: { ok: true, okAt: now } });
}

export function neoPackChecks(packs: readonly NeoPack[]): Record<string, NeoPackCheck> {
  return Object.assign({}, ...[...packs].reverse().map((pack) => pack.checks ?? {}));
}

export function requireNeoPackTickable(read: {
  ask: NeoAsk | null;
}): { value: NeoAsk } | { reason: null } {
  return read.ask &&
    isNeoAskLive(read.ask) &&
    (read.ask.doneItems ?? []).some(
      (item) => (item.check || item.watch?.length) && !item.removed && item.state !== 'met'
    )
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

export async function readNeoAskPackTicks(
  packs: readonly NeoPack[],
  ask: NeoAsk,
  works: readonly NeoWork[],
  warn: (id: string, error: unknown) => void
): Promise<{ id: string; evidence: string }[]> {
  const reads = await Promise.all(
    packs.flatMap((pack) =>
      [
        !ask.pack || pack.id === ask.pack ? pack.readAskTicks?.(ask, works) : undefined,
        pack.readAskWatchTicks?.(ask),
      ].map((read) =>
        read?.catch((error: unknown) => {
          warn(pack.id, error);
          return [];
        })
      )
    )
  );
  const ticks = reads.flatMap((read) => read ?? []);
  return ticks.filter((tick, index) => ticks.findIndex((item) => item.id === tick.id) === index);
}

export async function readNeoAskPackEvidence(
  packs: readonly NeoPack[],
  ask: NeoAsk,
  warn: (id: string, error: unknown) => void
): Promise<NeoEvidence[]> {
  const reads = await Promise.all(
    packs
      .filter((pack) => !ask.pack || pack.id === ask.pack)
      .map((pack) =>
        pack.readAskEvidence?.(ask).catch((error: unknown) => {
          warn(pack.id, error);
          return [];
        })
      )
  );
  return reads.flatMap((read) => read ?? []);
}
