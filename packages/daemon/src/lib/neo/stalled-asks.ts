import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import { Logger } from '../logger.ts';
import type { NeoService } from './service.ts';

export const STALLED_ASK_AFTER_MS = 2 * 60 * 60 * 1000;
const REPEAT_AFTER_MS = 4 * 60 * 60 * 1000;
const log = new Logger('neo-stalled-asks');

export const wakeStalledAsks = (superpipe({})('neo-stalled-ask-wake') as PipelineAPI)
  .input(['store', 'tell', 'now'])
  .pipe(
    async (store: NeoAskTodoRepository, tell: NeoService['deliverForward'], now: number) => {
      for (const ask of store.listStalledAsks(now - STALLED_ASK_AFTER_MS, now - REPEAT_AFTER_MS)) {
        try {
          await tell(
            ask.sessionId,
            ask.wakeKey,
            `Ask: ${ask.title} (${ask.id})\nThis ask has nothing in progress. Add the next todo, or settle it.`,
            ask.sessionId
          );
          store.recordStalledAskWake(ask.id, now);
        } catch (error) {
          log.warn(`Stalled ask ${ask.id} wake pending`, error);
        }
      }
    },
    ['store', 'tell', 'now'],
    'result'
  )
  .endAsync('result') as (
  store: NeoAskTodoRepository,
  tell: NeoService['deliverForward'],
  now: number
) => Promise<void>;
