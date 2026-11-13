import type { NeoAsk, NeoQuestion, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import {
  fitNeoPlanLines,
  neoPlanLines,
  planNeoPlanContext,
  type NeoPlanLine,
  type NeoUnansweredInput,
} from './plan-context.ts';

export type NeoPlanFacts = {
  asks: NeoAsk[];
  todos: NeoTodo[];
  questions: NeoQuestion[];
  unanswered?: NeoUnansweredInput[];
};

export function createNeoPlanContext(readFacts: () => Promise<NeoPlanFacts>, budget = 12_000) {
  let previous: NeoPlanLine[] | null = null;
  return (superpipe({})('neo.plan.context') as PipelineAPI)
    .input(['source'])
    .pipe(readFacts, 'source', 'facts')
    .pipe(
      (facts: NeoPlanFacts) =>
        fitNeoPlanLines(neoPlanLines(facts.asks, facts.todos, facts.questions), budget),
      'facts',
      'lines'
    )
    .pipe(
      (
        lines: NeoPlanLine[],
        source: Parameters<typeof planNeoPlanContext>[2],
        facts: NeoPlanFacts
      ) =>
        planNeoPlanContext(previous, lines, source, source === 'compact' ? facts.unanswered : []),
      ['lines', 'source', 'facts'],
      'context'
    )
    .pipe(
      (lines: NeoPlanLine[], context: string) => {
        previous = lines;
        return context;
      },
      ['lines', 'context'],
      'context'
    )
    .endAsync('context') as (source: Parameters<typeof planNeoPlanContext>[2]) => Promise<string>;
}
