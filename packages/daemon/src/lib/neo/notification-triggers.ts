import { NEO_ASK_ANSWER_PREFIX } from './ask-origin.ts';
import { resumedPromptUuid } from '../agent/restart-turn-recovery.ts';

const NEO_HUMAN_CONTINUATIONS = ['neo-turn-limit:human:', NEO_ASK_ANSWER_PREFIX];

export const NEO_HUMAN_TRIGGER_PREFIX = 'human:';
type Rejection = { accepted: false; reason: string; detail: string };

export function neoHumanTrigger(messageId: string): string {
  return `${NEO_HUMAN_TRIGGER_PREFIX}${messageId}`;
}

export type NeoDeliveryTrigger = 'continues' | { readonly id: string } | null;

export function neoDeliveryTrigger(
  trigger: NeoDeliveryTrigger,
  parentTrigger: () => string | null
): string | null {
  if (trigger === 'continues') return parentTrigger();
  return trigger?.id ?? null;
}

export function neoHumanTriggerMessageId(triggerId: string | undefined): string | null {
  return triggerId?.startsWith(NEO_HUMAN_TRIGGER_PREFIX)
    ? triggerId.slice(NEO_HUMAN_TRIGGER_PREFIX.length) || null
    : null;
}

export function neoHumanTurnOrigin(
  messageId: string,
  trigger: string | null,
  isHumanInput: (messageId: string) => boolean
): string | null {
  messageId = resumedPromptUuid(messageId);
  if (isHumanInput(messageId)) return messageId;
  const human = neoHumanTriggerMessageId(trigger ?? undefined);
  return human &&
    NEO_HUMAN_CONTINUATIONS.some((prefix) => messageId.startsWith(prefix)) &&
    isHumanInput(human)
    ? human
    : null;
}

export function requirePublicationTrigger<T>(
  value: T,
  draft: { triggerId?: string },
  trigger: string | null
): { value: T & { triggerId?: string } } | { reason: Rejection } {
  if (draft.triggerId && draft.triggerId !== trigger)
    return {
      reason: {
        accepted: false,
        reason: 'wrong_trigger',
        detail: trigger
          ? `This turn's trigger is ${trigger}, not ${draft.triggerId}. Publish with triggerId ${trigger}, or omit it.`
          : 'This turn has no trigger; omit triggerId.',
      },
    };
  return { value: { ...value, triggerId: trigger ?? undefined } };
}
