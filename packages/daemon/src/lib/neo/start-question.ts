import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { z } from 'zod';
import { readNeoAskAnswerOption } from './ask-answer-evidence.ts';
import { neoStatusLine, type NeoStatusLine } from './status-codes.ts';

export const NEO_START_QUESTION_PREFIX = 'neo-start:';
const targets = z.array(
  z.object({ workId: z.string(), target: z.string(), title: z.string().optional() })
);
export type NeoStartTarget = z.infer<typeof targets>[number];

export function neoQuestionStartTargets(item: NeoAskItem): NeoStartTarget[] {
  if (!item.action?.startsWith(NEO_START_QUESTION_PREFIX)) return [];
  return targets.parse(JSON.parse(item.action.slice(NEO_START_QUESTION_PREFIX.length)));
}

export function neoStartChoice(item: NeoAskItem, choice: string | null) {
  const normalize = (text: string | undefined) =>
    text?.normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ');
  const answer = normalize(choice ?? undefined);
  return answer && answer === normalize(item.options?.at(-1))
    ? 'approved'
    : answer && answer === normalize(item.options?.[0])
      ? 'declined'
      : 'pending';
}

export function neoStartDecision(ask: NeoAsk, target: NeoStartTarget) {
  const related = (ask.doneItems ?? []).filter((item) =>
    neoQuestionStartTargets(item).some((entry) => entry.workId === target.workId)
  );
  const answered = related.find(
    (item) =>
      !item.removed &&
      item.state === 'met' &&
      item.metBy === 'human' &&
      neoQuestionStartTargets(item).some(
        (entry) => entry.workId === target.workId && entry.target === target.target
      )
  );
  return answered
    ? neoStartChoice(answered, readNeoAskAnswerOption(answered.evidence))
    : related.length
      ? 'pending'
      : null;
}

const START_QUESTION_EN = {
  'question.startOne': 'Start "{title}"?',
  'question.startMany': 'Start these {count}?',
} as const;

export function neoStartQuestionLine(steps: readonly { title?: string }[]): NeoStatusLine {
  return neoStatusLine(START_QUESTION_EN, [
    steps.length === 1 && steps[0].title
      ? { code: 'question.startOne', params: { title: steps[0].title } }
      : { code: 'question.startMany', params: { count: String(steps.length) } },
  ]);
}

export function neoStartQuestionTitle(steps: readonly { title?: string }[]): string {
  return neoStartQuestionLine(steps).status;
}
