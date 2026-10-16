import {
  fillPrompt,
  NEO_CARD_PR_ATTENTION,
  NEO_WORK_DONE_CHECK_PRS_LIVE,
  NEO_WORK_DONE_CHECK_PRS_STALE,
} from '@hyperneo/prompts';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoPackCardAttention, NeoPackCardFacts } from '../types.ts';

function needsOf(pr: NeoWorkPr): string[] {
  if (pr.state !== 'OPEN') return [];
  const blockers = pr.blockers ?? [];
  return [
    ...(pr.checks === 'failing' ? ['CI checks are failing'] : []),
    ...(pr.review === 'changes_requested' ? ['a reviewer requested changes'] : []),
    ...blockers.filter((blocker) => /unresolved review thread/.test(blocker)),
    ...blockers.filter((blocker) => blocker.startsWith('merge conflicts')),
  ];
}

export function neoCardPrAttention(prs: readonly NeoWorkPr[]): NeoPackCardAttention {
  const items = prs
    .flatMap((pr) => {
      const needs = needsOf(pr);
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

export function neoCardPrFacts(
  prs: readonly NeoWorkPr[] | undefined,
  stale: boolean
): NeoPackCardFacts | null {
  return prs
    ? {
        text: stale ? NEO_WORK_DONE_CHECK_PRS_STALE : NEO_WORK_DONE_CHECK_PRS_LIVE,
        data: {
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
