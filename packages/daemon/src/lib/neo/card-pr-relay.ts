import { fillPrompt, NEO_CARD_PR_ATTENTION, NEO_CARD_PR_ATTENTION_NEO } from '@hyperneo/prompts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { NEO_WORK_CLOSED_DONE, type NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';

type NeoCardPrRelaySkip = 'not_in_flight' | 'clear' | 'told';

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

export function neoCardPrAttention(
  prs: readonly NeoWorkPr[]
): { signature: string; items: string } | null {
  const lines = prs.flatMap((pr) => {
    const needs = needsOf(pr);
    return needs.length ? [`- ${pr.url}: ${needs.join('; ')}`] : [];
  });
  if (!lines.length) return null;
  const items = lines.join('\n');
  return { signature: items, items };
}

export function requireNeoCardPrRelay(
  work: Pick<NeoWork, 'status' | 'report'> | null,
  attention: { signature: string; items: string } | null,
  told: string | null
): { value: { signature: string; message: string } } | { reason: NeoCardPrRelaySkip } {
  if (
    !work ||
    (work.status !== 'queued' && work.status !== 'reported') ||
    work.report === NEO_WORK_CLOSED_DONE
  )
    return { reason: 'not_in_flight' };
  if (!attention) return { reason: 'clear' };
  if (attention.signature === told) return { reason: 'told' };
  return {
    value: {
      signature: attention.signature,
      message: fillPrompt(NEO_CARD_PR_ATTENTION, { items: attention.items }),
    },
  };
}

const NEO_CARD_PR_RETRYABLE = /already being continued/;

export function neoCardPrNeoNote(
  work: Pick<NeoWork, 'id' | 'title'>,
  items: string,
  refusal: string
): string | null {
  return NEO_CARD_PR_RETRYABLE.test(refusal)
    ? null
    : fillPrompt(NEO_CARD_PR_ATTENTION_NEO, {
        title: work.title,
        workId: work.id,
        reason: refusal,
        items,
      });
}
