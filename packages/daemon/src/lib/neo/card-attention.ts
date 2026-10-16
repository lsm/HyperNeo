import { fillPrompt, NEO_CARD_ATTENTION_NEO } from '@hyperneo/prompts';
import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import { isNeoWorkClosedDone } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoPackCardAttention } from './packs/types.ts';

type NeoCardAttentionSkip = 'not_in_flight' | 'clear' | 'told';

export function requireNeoCardAttentionRelay(
  work: Pick<NeoWork, 'status' | 'report'> | null,
  attention: NeoPackCardAttention['attention'],
  told: string | null
): { value: { signature: string; message: string } } | { reason: NeoCardAttentionSkip } {
  if (
    !work ||
    (work.status !== 'queued' && work.status !== 'reported') ||
    isNeoWorkClosedDone(work.report)
  )
    return { reason: 'not_in_flight' };
  if (!attention) return { reason: 'clear' };
  if (attention.signature === told) return { reason: 'told' };
  return { value: { signature: attention.signature, message: attention.facts } };
}

const NEO_CARD_ATTENTION_RETRYABLE = /already being continued/;

export function neoCardAttentionNeoNote(
  work: Pick<NeoWork, 'id' | 'title'>,
  facts: string,
  refusal: string
): string | null {
  return NEO_CARD_ATTENTION_RETRYABLE.test(refusal)
    ? null
    : fillPrompt(NEO_CARD_ATTENTION_NEO, {
        title: work.title,
        workId: work.id,
        reason: refusal,
        facts,
      });
}
