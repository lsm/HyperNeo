import {
  fillPrompt,
  NEO_CARD_PR_ATTENTION,
  NEO_WORK_DONE_CHECK_PRS_LIVE,
  NEO_WORK_DONE_CHECK_PRS_MERGEABLE,
  NEO_WORK_DONE_CHECK_PRS_STALE,
} from '@hyperneo/prompts';
import { type NeoWorkPr, neoWorkPrVerdict } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoPackCardAttention, NeoPackCardFacts } from '../types.ts';

const APPROVAL_ONLY = /^needs \d+ approving reviews?, has \d+$/;

export function isNeoCardPrAwaited(pr: NeoWorkPr): boolean {
  if (pr.state !== 'OPEN') return false;
  if (pr.checks === 'pending') return true;
  if (pr.checks === 'failing' || pr.review !== 'none') return false;
  const blockers = pr.blockers ?? [];
  return blockers.length > 0 && blockers.every((blocker) => APPROVAL_ONLY.test(blocker));
}

function needsOf(pr: NeoWorkPr, nudges: boolean): string[] {
  if (pr.state !== 'OPEN') return [];
  const blockers = pr.blockers ?? [];
  return [
    ...(pr.checks === 'failing' ? ['CI checks are failing'] : []),
    ...(pr.review === 'changes_requested' ? ['a reviewer requested changes'] : []),
    ...blockers.filter((blocker) => /unresolved review thread/.test(blocker)),
    ...blockers.filter((blocker) => blocker.startsWith('merge conflicts')),
    ...(nudges && pr.review === 'approved' && pr.checks === 'none'
      ? [
          'approved, but no CI checks ran on its head; push or update the branch from its base so CI runs',
        ]
      : []),
    ...(nudges && pr.review === 'approved' && pr.checks === 'passing' && !blockers.length
      ? ['approved and green; merge it now with a manual squash merge']
      : []),
  ];
}

export function neoCardPrAttention(prs: readonly NeoWorkPr[], nudges = true): NeoPackCardAttention {
  const items = prs
    .flatMap((pr) => {
      const needs = needsOf(pr, nudges);
      return needs.length ? [`- ${pr.url}: ${needs.join('; ')}`] : [];
    })
    .join('\n');
  return {
    attention: items
      ? { signature: items, facts: fillPrompt(NEO_CARD_PR_ATTENTION, { items }) }
      : null,
    pending: prs.some((pr) => pr.state === 'OPEN' && pr.checks === 'pending'),
  };
}

const isNeoPrMergeable = (pr: NeoWorkPr): boolean =>
  pr.state === 'OPEN' && neoWorkPrVerdict(pr) === 'ready' && !pr.blockers?.length;

function prsText(prs: readonly NeoWorkPr[], stale: boolean): string {
  if (stale) return NEO_WORK_DONE_CHECK_PRS_STALE;
  const urls = prs.filter(isNeoPrMergeable).map((pr) => pr.url);
  return urls.length
    ? `${NEO_WORK_DONE_CHECK_PRS_LIVE} ${fillPrompt(NEO_WORK_DONE_CHECK_PRS_MERGEABLE, { urls: urls.join(', ') })}`
    : NEO_WORK_DONE_CHECK_PRS_LIVE;
}

export function neoCardPrFacts(
  prs: readonly NeoWorkPr[] | undefined,
  stale: boolean
): NeoPackCardFacts | null {
  return prs
    ? {
        text: prsText(prs, stale),
        data: {
          waiting_on_pr: prs.filter(isNeoCardPrAwaited).map((pr) => pr.url),
          prs: prs.map(({ url, state, checks, review, blockers }) => ({
            url,
            state,
            checks,
            review,
            ...(blockers?.length ? { blockers } : {}),
          })),
        },
      }
    : null;
}
