import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { neoCardPrUrls } from './branch-prs.ts';
import { extractNeoWorkPrUrls, neoTextRefs } from './work-prs.ts';
import { githubUrlKey } from '../../../github/parse-pr-url.ts';

export type NeoPrClaim = 'branch' | 'opened' | 'named' | 'mentioned';
type PrWindow = { start: number; end: number | null };
export type NeoCardPrCandidate = {
  url: string;
  claim: NeoPrClaim;
  scope?: { window: PrWindow | null; onBranch: boolean };
};
export type NeoCardPrOwned = NeoCardPrCandidate & {
  claimedAt: number;
  claimed: boolean;
  score: number | null;
  scoped?: boolean;
};
export type NeoPrClaimState = NeoPrClaim | 'rejected';
export interface NeoPrClaimRow {
  workId: string;
  urlKey: string;
  claim: NeoPrClaimState;
  claimedAt: number;
  cardCreatedAt: number;
  score: number | null;
  scoped?: boolean;
}

const RANK: Record<NeoPrClaim, number> = { branch: 0, opened: 0, named: 1, mentioned: 2 };
const key = githubUrlKey;

export function planNeoCardPrCandidates(input: {
  window?: PrWindow | null;
  report: string | null;
  follows?: string | null;
  branch: readonly string[];
  opened?: readonly string[];
  stored: readonly { url: string }[];
  mentioned?: readonly string[];
}): NeoCardPrCandidate[] {
  const followed = input.follows ? [input.follows] : [];
  const named = new Set(followed.map(key));
  const onBranch = new Set(input.branch.map(key));
  const opened = new Set((input.opened ?? []).map(key));
  const seen = new Set<string>();
  const listed = neoCardPrUrls(
    [...followed, ...extractNeoWorkPrUrls(input.report, input.stored), ...(input.mentioned ?? [])],
    input.branch
  );
  const known = new Set(listed.map(key));
  return [
    ...listed,
    ...neoCardOpenedPrs(input.opened ?? []).filter((url) => !known.has(key(url))),
  ].flatMap((url) => {
    if (seen.has(key(url))) return [];
    seen.add(key(url));
    const claim: NeoPrClaim = onBranch.has(key(url))
      ? 'branch'
      : named.has(key(url))
        ? 'named'
        : opened.has(key(url))
          ? 'opened'
          : 'mentioned';
    return [
      {
        url,
        claim: input.window !== undefined && named.has(key(url)) ? 'named' : claim,
        ...(input.window !== undefined
          ? { scope: { window: input.window, onBranch: onBranch.has(key(url)) } }
          : {}),
      },
    ];
  });
}

type RankedClaim = Pick<NeoPrClaimRow, 'claimedAt' | 'cardCreatedAt' | 'score'> & {
  claim: NeoPrClaim;
};
const isRanked = (row: NeoPrClaimRow): row is NeoPrClaimRow & { claim: NeoPrClaim } =>
  row.claim !== 'rejected';
const competes = (row: NeoPrClaimRow): row is NeoPrClaimRow & { claim: NeoPrClaim } =>
  isRanked(row) && row.claim !== 'named';

const MATCH_FILLER = new Set([
  'and',
  'chore',
  'docs',
  'feat',
  'fix',
  'for',
  'from',
  'into',
  'refactor',
  'test',
  'that',
  'the',
  'this',
  'with',
]);

const matchWords = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 2 && !MATCH_FILLER.has(word))
      .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word))
  );

export function neoPrMatchScore(card: string, pr: Pick<NeoWorkPr, 'title' | 'branch'>): number {
  const theirs = matchWords(`${pr.title ?? ''} ${pr.branch ?? ''}`);
  return [...matchWords(card)].filter((word) => theirs.has(word)).length;
}

export function scoreNeoCardPrs(
  card: Pick<NeoWork, 'title' | 'instruction'>,
  owned: readonly NeoCardPrOwned[],
  prs: readonly NeoWorkPr[]
): NeoCardPrOwned[] {
  return owned.map((item) => {
    const pr = prs.find((read) => key(read.url) === key(item.url));
    return item.claim === 'mentioned' && pr
      ? { ...item, score: neoPrMatchScore(`${card.title}\n${card.instruction}`, pr) }
      : item;
  });
}

export function beatsNeoPrClaim(rival: RankedClaim, own: RankedClaim): boolean {
  if (RANK[rival.claim] !== RANK[own.claim]) return RANK[rival.claim] < RANK[own.claim];
  if (own.claim === 'mentioned') {
    if (rival.score == null || own.score == null) return false;
    if (rival.score !== own.score) return rival.score > own.score;
    if (rival.claimedAt !== own.claimedAt) return rival.claimedAt < own.claimedAt;
  }
  return rival.cardCreatedAt < own.cardCreatedAt;
}

export function planNeoCardPrOwnership(
  card: Pick<NeoWork, 'id' | 'createdAt'>,
  candidates: readonly NeoCardPrCandidate[],
  claims: readonly NeoPrClaimRow[],
  now: number
): NeoCardPrOwned[] {
  return candidates.flatMap((candidate) => {
    const same = claims.filter((row) => row.urlKey === key(candidate.url));
    const mine = same.find((row) => row.workId === card.id);
    if (
      candidate.scope === undefined &&
      mine?.claim === 'rejected' &&
      (candidate.claim === 'mentioned' || candidate.claim === 'opened')
    )
      return [];
    const prior = mine && isRanked(mine) ? mine : undefined;
    const claim =
      prior &&
      (prior.scoped || candidate.scope === undefined) &&
      RANK[prior.claim] < RANK[candidate.claim]
        ? prior.claim
        : candidate.claim;
    const own = {
      claim,
      claimedAt: prior?.claimedAt ?? now,
      cardCreatedAt: card.createdAt,
      score: prior?.score ?? null,
    };
    return claim !== 'named' &&
      same.some(
        (row) =>
          row.workId !== card.id &&
          competes(row) &&
          (candidate.scope === undefined || row.scoped) &&
          beatsNeoPrClaim(row, own)
      )
      ? []
      : [
          {
            ...candidate,
            claim,
            claimedAt: own.claimedAt,
            claimed: !!prior,
            score: own.score,
            ...(prior?.scoped ? { scoped: true } : {}),
          },
        ];
  });
}

export function keepNeoUnbeatenPrs(
  card: Pick<NeoWork, 'id' | 'createdAt'>,
  owned: readonly NeoCardPrOwned[],
  claims: readonly NeoPrClaimRow[]
): { owned: NeoCardPrOwned[]; beaten: NeoCardPrOwned[] } {
  const beaten = owned.filter(
    (item) =>
      item.claim !== 'named' &&
      claims
        .filter((row) => row.workId !== card.id && row.urlKey === key(item.url))
        .filter(competes)
        .filter((row) => item.scope === undefined || row.scoped)
        .some((row) => beatsNeoPrClaim(row, { ...item, cardCreatedAt: card.createdAt }))
  );
  return { owned: owned.filter((item) => !beaten.includes(item)), beaten };
}

export function planNeoPrCedes(
  card: Pick<NeoWork, 'id'>,
  claims: readonly NeoPrClaimRow[]
): NeoPrClaimRow[] {
  const mine = claims.filter((row) => row.workId === card.id).filter(competes);
  return claims
    .filter((row) => row.workId !== card.id)
    .filter(competes)
    .filter((row) => mine.some((own) => own.urlKey === row.urlKey && beatsNeoPrClaim(own, row)));
}

export function isNeoCardMentionCurrent(
  card: Pick<NeoWork, 'createdAt'>,
  pr: Pick<NeoWorkPr, 'createdAt' | 'state'>
): boolean {
  return pr.state === 'OPEN' || pr.createdAt == null || pr.createdAt >= card.createdAt;
}

export function isNeoCardMentionRelated(
  named: ReadonlySet<number>,
  pr: Pick<NeoWorkPr, 'url' | 'refs'>
): boolean {
  const refs = pr.refs ?? [];
  if (!named.size || !refs.length) return true;
  const own = Number(/\/pull\/(\d+)/.exec(pr.url)?.[1]);
  return named.has(own) || refs.some((ref) => named.has(ref));
}

export function keepNeoCardPrReads(
  card: Pick<NeoWork, 'createdAt' | 'title' | 'instruction'>,
  owned: readonly NeoCardPrOwned[],
  prs: readonly NeoWorkPr[]
): { kept: NeoCardPrOwned[]; pending: NeoCardPrOwned[]; rejected: NeoCardPrOwned[] } {
  const sorted = { kept: [], pending: [], rejected: [] } as {
    kept: NeoCardPrOwned[];
    pending: NeoCardPrOwned[];
    rejected: NeoCardPrOwned[];
  };
  const named = new Set(neoTextRefs(`${card.title}\n${card.instruction}`));
  for (const candidate of owned) {
    const pr = prs.find((item) => key(item.url) === key(candidate.url));
    if (candidate.scope !== undefined && candidate.claim !== 'named') {
      const { window, onBranch } = candidate.scope;
      if (candidate.scoped) sorted.kept.push(candidate);
      else if (
        window &&
        onBranch &&
        pr?.createdAt !== undefined &&
        pr.createdAt >= window.start &&
        (window.end === null || pr.createdAt <= window.end)
      )
        sorted.kept.push({ ...candidate, scoped: true });
      else if (!pr && window && onBranch) sorted.pending.push(candidate);
      else sorted.rejected.push(candidate);
    } else if (
      candidate.claim === 'opened' &&
      pr &&
      !candidate.claimed &&
      !isNeoCardMentionCurrent(card, pr)
    )
      sorted.rejected.push(candidate);
    else if (candidate.claim !== 'mentioned') sorted.kept.push(candidate);
    else if (!pr) (candidate.claimed ? sorted.kept : sorted.pending).push(candidate);
    else if (isNeoCardMentionCurrent(card, pr) && isNeoCardMentionRelated(named, pr))
      sorted.kept.push(candidate);
    else sorted.rejected.push(candidate);
  }
  return sorted;
}

const NEO_CARD_OPENED_PR_MAX = 8;

export function neoCardOpenedPrs(opened: readonly string[]): string[] {
  return [...opened].reverse().slice(0, NEO_CARD_OPENED_PR_MAX);
}

export function hasNeoUnattachedOpenedPrs(
  opened: readonly string[],
  stored: readonly { url: string }[]
): boolean {
  const attached = new Set(stored.map((pr) => key(pr.url)));
  return neoCardOpenedPrs(opened).some((url) => !attached.has(key(url)));
}
