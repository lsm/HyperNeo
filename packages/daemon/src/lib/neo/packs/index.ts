import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { isNeoAskLive } from '../done-check.ts';
import { combineNeoEvidenceReads, type NeoEvidence, type NeoEvidenceRead } from '../evidence.ts';
import { buildNeoCheckRegistry } from './check-registry.ts';
import { CODING_PACK_BRIEF } from './coding/pack.ts';
import { requireNeoWorkPrRefresh } from './coding/work-prs.ts';
import { LIFE_ADMIN_PACK_BRIEF } from './life-admin/pack.ts';
import type {
  NeoPack,
  NeoPackBrief,
  NeoPackCardFacts,
  NeoPackCheck,
  NeoPackFragment,
} from './types.ts';

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
    doneWhenMet: boolean;
    changedAt?: number | null;
  },
  now: number,
  closedDonePrefix: string
): { value: Refresh & { row: Row | null } } | { reason: 'not_due' } {
  const changed = !!card.row && (card.changedAt ?? 0) > card.row.readAt;
  if (card.doneWhenMet && !changed) return { reason: 'not_due' };
  const pr = requireNeoWorkPrRefresh(
    refresh,
    { row: card.row, session: card.session, changed },
    now,
    closedDonePrefix
  );
  if ('value' in pr) return pr;
  const { work } = refresh;
  return card.packEvidence &&
    work.status === 'reported' &&
    !work.report?.startsWith(closedDonePrefix) &&
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

export function neoPackCardFacts(
  packs: readonly NeoPack[],
  workId: string,
  stale: boolean
): NeoPackCardFacts | null {
  const facts = packs.flatMap((pack) => pack.cardFacts?.(workId, stale) ?? []);
  return facts.length
    ? {
        text: facts.map((fact) => fact.text).join(' '),
        data: Object.assign({}, ...facts.map((fact) => fact.data)),
      }
    : null;
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
  warn: (id: string, error: unknown) => void,
  changedAt: number | null = null
): Promise<NeoEvidenceRead | null> {
  return combineNeoEvidenceReads(
    await Promise.all(
      packs.map((pack) =>
        pack.readEvidence?.(work, changedAt).catch((error: unknown) => {
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
  const registry = buildNeoCheckRegistry(packs);
  return registry.ok
    ? Object.fromEntries(
        registry.kinds.flatMap((kind) => {
          const entry = registry.resolve(kind);
          return entry.ok && entry.value.mode === 'evidence' ? [[kind, entry.value.check]] : [];
        })
      )
    : {};
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

type NeoCheckRegistration = Extract<
  ReturnType<Extract<ReturnType<typeof buildNeoCheckRegistry>, { ok: true }>['resolve']>,
  { ok: true }
>['value'];

export function neoPackTickWrite(
  item: Pick<NeoAskItem, 'id' | 'state' | 'evidence'>,
  registration: NeoCheckRegistration | null,
  evidence: string
): Pick<NeoAskItem, 'id' | 'state' | 'evidence' | 'metBy'> | null {
  if (registration?.mode !== 'evidence' || registration.independent)
    return { id: item.id, state: 'met', evidence, metBy: 'daemon' };
  if (item.state === 'reported' && item.evidence === evidence) return null;
  return { id: item.id, state: 'reported', evidence, metBy: null };
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
