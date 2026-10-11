import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import { neoCardPrUrls } from './branch-prs.ts';
import { extractNeoWorkPrUrls } from './work-prs.ts';

export type NeoPrClaim = 'branch' | 'named' | 'mentioned';
export type NeoCardPrCandidate = { url: string; claim: NeoPrClaim };
export type NeoCardPrOwned = NeoCardPrCandidate & { claimedAt: number; claimed: boolean };
export interface NeoPrClaimRow {
  workId: string;
  urlKey: string;
  claim: NeoPrClaim;
  claimedAt: number;
  cardCreatedAt: number;
}

const RANK: Record<NeoPrClaim, number> = { branch: 0, named: 1, mentioned: 2 };
const key = (url: string) => url.toLowerCase();

export function planNeoCardPrCandidates(input: {
  report: string | null;
  brief: string;
  branch: readonly string[];
  stored: readonly { url: string }[];
}): NeoCardPrCandidate[] {
  const named = new Set(extractNeoWorkPrUrls(input.brief).map(key));
  const opened = new Set(input.branch.map(key));
  const seen = new Set<string>();
  return neoCardPrUrls(
    extractNeoWorkPrUrls([input.brief, input.report].filter(Boolean).join('\n'), input.stored),
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

export function beatsNeoPrClaim(
  rival: Pick<NeoPrClaimRow, 'claim' | 'claimedAt' | 'cardCreatedAt'>,
  own: Pick<NeoPrClaimRow, 'claim' | 'claimedAt' | 'cardCreatedAt'>
): boolean {
  if (RANK[rival.claim] !== RANK[own.claim]) return RANK[rival.claim] < RANK[own.claim];
  if (own.claim === 'mentioned' && rival.claimedAt !== own.claimedAt)
    return rival.claimedAt < own.claimedAt;
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
    const prior = same.find((row) => row.workId === card.id);
    const claim =
      prior && RANK[prior.claim] < RANK[candidate.claim] ? prior.claim : candidate.claim;
    const own = {
      claim,
      claimedAt: prior?.claimedAt ?? now,
      cardCreatedAt: card.createdAt,
    };
    return same.some((row) => row.workId !== card.id && beatsNeoPrClaim(row, own))
      ? []
      : [{ url: candidate.url, claim, claimedAt: own.claimedAt, claimed: !!prior }];
  });
}

export function keepNeoCardPrReads(
  card: Pick<NeoWork, 'createdAt'>,
  owned: readonly NeoCardPrOwned[],
  prs: readonly NeoWorkPr[]
): NeoCardPrOwned[] {
  return owned.filter((candidate) => {
    if (candidate.claimed || candidate.claim !== 'mentioned') return true;
    const pr = prs.find((item) => key(item.url) === key(candidate.url));
    return !!pr && (pr.createdAt == null || pr.createdAt >= card.createdAt);
  });
}
