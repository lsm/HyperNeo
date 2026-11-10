import type { NeoQuestion } from '@hyperneo/shared/types/neo-ask';
import type { NeoSettings } from '@hyperneo/shared/types/settings';

export type NeoRelayInput = {
  questionId: string;
  sender: string;
  where: string;
  when: string;
  words: string;
  at: number;
};
export type NeoRelayQuestion = NeoQuestion & {
  ruleProposal?: boolean;
  preferenceProposal?: boolean;
};

export function planNeoRelayAnswer(
  settings: NeoSettings | undefined,
  question: NeoRelayQuestion | null,
  input: NeoRelayInput
) {
  const relay = settings?.relaySenders?.find(({ sender }) => sender === input.sender);
  if (!relay) return { reason: 'sender_not_allowed: this sender may not relay human answers.' };
  if (!question || question.state !== 'open')
    return { reason: 'question_not_open: relay needs an open card.' };
  if (!input.where.trim() || !input.when.trim() || !input.words.trim())
    return { reason: 'relay_incomplete: where, when and words are required.' };
  if (
    question.kind === 'start' ||
    question.confirm ||
    question.ruleProposal ||
    question.preferenceProposal
  )
    return { reason: 'direct_human_required: this card needs the human’s own action.' };
  return {
    answer: input.words,
    provenance: {
      via: input.sender,
      viaName: relay.name,
      where: input.where,
      when: input.when,
      at: input.at,
    },
  };
}
