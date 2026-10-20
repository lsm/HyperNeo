import { z } from 'zod';
import { neoStatusLine, type NeoStatusLine } from './status-codes.ts';

const targets = z.array(
  z.object({ workId: z.string(), target: z.string(), title: z.string().optional() })
);
export type NeoStartTarget = z.infer<typeof targets>[number];

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

export function isNeoStartQuestionText(text: string): boolean {
  return Object.values(START_QUESTION_EN).some((template) =>
    new RegExp(
      `^${template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\w+\\\}/g, '.+')}$`
    ).test(text)
  );
}
