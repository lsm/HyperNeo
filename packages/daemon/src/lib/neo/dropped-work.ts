import { Logger } from '../logger.ts';
import { STALLED_ASK_AFTER_MS } from './stalled-asks.ts';
import type {
  NeoPublicationInput,
  NeoPublicationAppendResult,
} from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import { neoDerivedId } from './derived-id.ts';
import type { NeoService } from './service.ts';

const WAITING_AFTER_MS = 2 * 60 * 60 * 1000;
const log = new Logger('neo-dropped-work');

async function readCounts(service: NeoService, now: number) {
  const todos = await service.todos.read('listCheckable');
  return {
    'stalled asks': (await service.todos.read('listStalledAsks', now - STALLED_ASK_AFTER_MS))
      .length,
    'todos waiting >2h': todos.filter(
      (todo) => todo.state === 'todo' && todo.updatedAt <= now - WAITING_AFTER_MS
    ).length,
    'idle workers without a report': todos.filter((todo) => {
      const observed = service.todoSessions.readCardCheck(todo.id);
      return (
        ['doing', 'blocked'].includes(todo.state) &&
        !todo.report &&
        observed &&
        !observed.unchecked &&
        observed.checkedAt >= todo.updatedAt &&
        ['done', 'failed', 'stopped'].includes(service.todoSessions.readLiveStatus(todo.id) ?? '')
      );
    }).length,
  };
}

const format = (counts: Record<string, number>) =>
  Object.entries(counts)
    .map(([label, count]) => `${label}: ${count}`)
    .join('; ');

export const publishDroppedWork = (superpipe({})('neo-daily-dropped-work') as PipelineAPI)
  .input(['service', 'now', 'append'])
  .pipe(
    (service: NeoService) => {
      const conversation = service.repo.conversationId();
      return conversation ? { value: { conversation } } : { reason: null };
    },
    'service',
    'result:result'
  )
  .pipe((now: number) => new Date(now).toISOString().slice(0, 10), 'now', 'day')
  .pipe((day: string) => neoDerivedId(`dropped-work:${day}`), 'day', 'id')
  .pipe(
    (service: NeoService, result: { conversation: string }, id: string) =>
      service.publications.get(result.conversation, id)
        ? { reason: null }
        : { value: { ...result, publicationId: id } },
    ['service', 'result', 'id'],
    'result:result'
  )
  .pipe(
    async (service: NeoService, now: number, day: string) =>
      [
        `Daily dropped work ${day} (UTC)`,
        `Core: ${format(await readCounts(service, now))}`,
        ...service
          .packs()
          .filter((pack) => pack.stats)
          .map((pack) => {
            try {
              return `${pack.id}: ${format(pack.stats!(now))}`;
            } catch (error) {
              log.warn(`Daily counts unavailable for ${pack.id}`, error);
              return `${pack.id}: unavailable`;
            }
          }),
      ].join('\n'),
    ['service', 'now', 'day'],
    'text'
  )
  .pipe(
    (
      service: NeoService,
      result: { conversation: string; publicationId: string },
      text: string,
      append: (input: NeoPublicationInput) => NeoPublicationAppendResult
    ) => {
      const receipt = append({
        conversationId: result.conversation,
        publicationId: result.publicationId,
        shortText: text.slice(0, 2000),
        fullText: text.slice(0, 16000),
        links: [],
      });
      if (!receipt.accepted) throw new Error(`Daily counts: ${receipt.reason}`);
      if (receipt.created) service.notifyPublicationsChanged(result.conversation);
      return null;
    },
    ['service', 'result', 'text', 'append'],
    'result'
  )
  .endAsync('result') as (
  service: NeoService,
  now: number,
  append: (input: NeoPublicationInput) => NeoPublicationAppendResult
) => Promise<void>;
