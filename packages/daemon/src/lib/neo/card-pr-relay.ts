import { fillPrompt, NEO_CARD_PR_ATTENTION } from '@hyperneo/prompts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type { NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';

type NeoCardPrNeed = { kind: 'checks' | 'review' | 'threads' | 'conflicts'; text: string };
type NeoCardPrRelaySkip = 'not_in_flight' | 'clear' | 'told';

function needsOf(pr: NeoWorkPr): NeoCardPrNeed[] {
  if (pr.state !== 'OPEN') return [];
  const blockers = pr.blockers ?? [];
  return [
    ...(pr.checks === 'failing'
      ? [{ kind: 'checks' as const, text: 'CI checks are failing' }]
      : []),
    ...(pr.review === 'changes_requested'
      ? [{ kind: 'review' as const, text: 'a reviewer requested changes' }]
      : []),
    ...blockers
      .filter((blocker) => /unresolved review thread/.test(blocker))
      .map((text) => ({ kind: 'threads' as const, text })),
    ...blockers
      .filter((blocker) => blocker.startsWith('merge conflicts'))
      .map((text) => ({ kind: 'conflicts' as const, text })),
  ];
}

export function neoCardPrAttention(
  prs: readonly NeoWorkPr[]
): { signature: string; items: string } | null {
  const lines = prs.flatMap((pr) => {
    const needs = needsOf(pr);
    return needs.length
      ? [
          {
            key: `${pr.url}:${needs.map((need) => need.kind).join('+')}`,
            line: `- ${pr.url}: ${needs.map((need) => need.text).join('; ')}`,
          },
        ]
      : [];
  });
  return lines.length
    ? {
        signature: lines.map((item) => item.key).join(','),
        items: lines.map((item) => item.line).join('\n'),
      }
    : null;
}

export function requireNeoCardPrRelay(
  work: Pick<NeoWork, 'status'> | null,
  attention: { signature: string; items: string } | null,
  told: string | undefined
): { value: { signature: string; message: string } } | { reason: NeoCardPrRelaySkip } {
  if (!work || (work.status !== 'queued' && work.status !== 'reported'))
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
