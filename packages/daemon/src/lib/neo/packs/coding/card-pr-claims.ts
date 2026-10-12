import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { neoCardPrUrls } from './branch-prs.ts';
import { extractNeoWorkPrUrls, neoTextRefs } from './work-prs.ts';
import { githubUrlKey } from '../../../github/parse-pr-url.ts';

export type NeoPrClaim = 'branch' | 'named' | 'mentioned';
export type NeoCardPrCandidate = { url: string; claim: NeoPrClaim };
export type NeoCardPrOwned = NeoCardPrCandidate & {
  claimedAt: number;
  claimed: boolean;
  score: number | null;
};
export type NeoPrClaimState = NeoPrClaim | 'rejected';
export interface NeoPrClaimRow {
  workId: string;
  urlKey: string;
  claim: NeoPrClaimState;
  claimedAt: number;
  cardCreatedAt: number;
  score: number | null;
}

const RANK: Record<NeoPrClaim, number> = { branch: 0, named: 1, mentioned: 2 };
const key = githubUrlKey;

export function planNeoCardPrCandidates(input: {
  report: string | null;
  brief: string;
  branch: readonly string[];
  stored: readonly { url: string }[];
  refs?: { named: readonly string[]; mentioned: readonly string[] };
}): NeoCardPrCandidate[] {
  const named = new Set(
    [...extractNeoWorkPrUrls(input.brief), ...(input.refs?.named ?? [])].map(key)
  );
  const opened = new Set(input.branch.map(key));
  const seen = new Set<string>();
  return neoCardPrUrls(
    [
      ...extractNeoWorkPrUrls([input.brief, input.report].filter(Boolean).join('\n'), input.stored),
      ...(input.refs?.named ?? []),
      ...(input.refs?.mentioned ?? []),
    ],
    input.branch
  ).flatMap((url) => {
    if (seen.has(key(url))) return [];
    seen.add(key(url));
    const claim: NeoPrClaim = opened.has(key(url))
      ? 'branch'
      : named.has(key(url))
        ? 'named'
        : 'mentioned';
    return [{ url, claim }];
  });
}

type RankedClaim = Pick<NeoPrClaimRow, 'claimedAt' | 'cardCreatedAt' | 'score'> & {
  claim: NeoPrClaim;
};
const isRanked = (row: NeoPrClaimRow): row is NeoPrClaimRow & { claim: NeoPrClaim } =>
  row.claim !== 'rejected';

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
    if (mine?.claim === 'rejected' && candidate.claim === 'mentioned') return [];
    const prior = mine && isRanked(mine) ? mine : undefined;
    const claim =
      prior && RANK[prior.claim] < RANK[candidate.claim] ? prior.claim : candidate.claim;
    const own = {
      claim,
      claimedAt: prior?.claimedAt ?? now,
      cardCreatedAt: card.createdAt,
      score: prior?.score ?? null,
    };
    return same.some((row) => row.workId !== card.id && isRanked(row) && beatsNeoPrClaim(row, own))
      ? []
      : [
          {
            url: candidate.url,
            claim,
            claimedAt: own.claimedAt,
            claimed: !!prior,
            score: own.score,
          },
        ];
  });
}

export function keepNeoUnbeatenPrs(
  card: Pick<NeoWork, 'id' | 'createdAt'>,
  owned: readonly NeoCardPrOwned[],
  claims: readonly NeoPrClaimRow[]
): { owned: NeoCardPrOwned[]; beaten: NeoCardPrOwned[] } {
  const beaten = owned.filter((item) =>
    claims
      .filter((row) => row.workId !== card.id && row.urlKey === key(item.url))
      .filter(isRanked)
      .some((row) => beatsNeoPrClaim(row, { ...item, cardCreatedAt: card.createdAt }))
  );
  return { owned: owned.filter((item) => !beaten.includes(item)), beaten };
}

export function planNeoPrCedes(
  card: Pick<NeoWork, 'id'>,
  claims: readonly NeoPrClaimRow[]
): NeoPrClaimRow[] {
  const mine = claims.filter((row) => row.workId === card.id).filter(isRanked);
  return claims
    .filter((row) => row.workId !== card.id)
    .filter(isRanked)
    .filter((row) => mine.some((own) => own.urlKey === row.urlKey && beatsNeoPrClaim(own, row)));
}

export function isNeoCardMention(
  card: Pick<NeoWork, 'createdAt'>,
  named: ReadonlySet<number>,
  pr: Pick<NeoWorkPr, 'createdAt' | 'refs' | 'state'>
): boolean {
  const current = pr.state === 'OPEN' || pr.createdAt == null || pr.createdAt >= card.createdAt;
  return current && (!named.size || (pr.refs ?? []).some((ref) => named.has(ref)));
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
    if (candidate.claim !== 'mentioned') sorted.kept.push(candidate);
    else if (!pr) (candidate.claimed ? sorted.kept : sorted.pending).push(candidate);
    else if (isNeoCardMention(card, named, pr)) sorted.kept.push(candidate);
    else sorted.rejected.push(candidate);
  }
  return sorted;
}
