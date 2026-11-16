import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { Logger } from '../logger.ts';
import {
  NEO_ATTENTION_KINDS,
  type NeoAttentionEvent,
  neoAttentionUuids,
} from './attention/decide.ts';

export const STALLED_ASK_AFTER_MS = 2 * 60 * 60 * 1000;
const log = new Logger('neo-stalled-asks');
type StalledAsk = { id: string; title: string; since: number; finished: number };
type Tell = (event: NeoAttentionEvent, now: number) => Promise<unknown>;

export const neoStalledAskNote = (ask: { id: string; title: string; finished: number }) =>
  `Ask: ${ask.title} (${ask.id})\n${
    ask.finished
      ? 'All todos are finished: write the outcome with neo.ask.settle, or add the next todo.'
      : 'This ask has nothing in progress. Add the next todo, or settle it.'
  }`;

export const neoStalledAskEvent = (ask: StalledAsk): NeoAttentionEvent => ({
  kind: ask.finished ? 'ask.finished' : 'ask.idle',
  subject: { type: 'ask', id: ask.id },
  since: ask.since,
  facts: { text: neoStalledAskNote(ask) },
});

export const neoStalledAskUuids = (ask: Omit<StalledAsk, 'finished'>): string[] =>
  [1, 0].flatMap((finished) =>
    neoAttentionUuids(neoStalledAskEvent({ ...ask, finished }), NEO_ATTENTION_KINDS)
  );

export const wakeStalledAsks = (superpipe({})('neo-stalled-ask-wake') as PipelineAPI)
  .input(['store', 'tell', 'now'])
  .pipe(
    async (store: NeoAskTodoRepository, tell: Tell, now: number) => {
      for (const ask of store.listStalledAsks(now - STALLED_ASK_AFTER_MS, false, true)) {
        try {
          await tell(neoStalledAskEvent(ask), now);
        } catch (error) {
          log.warn(`Stalled ask ${ask.id} wake pending`, error);
        }
      }
    },
    ['store', 'tell', 'now'],
    'result'
  )
  .endAsync('result') as (store: NeoAskTodoRepository, tell: Tell, now: number) => Promise<void>;
