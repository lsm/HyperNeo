import superpipe, { type PipelineAPI } from 'superpipe';
import { neoDerivedId } from './derived-id.ts';
import type { NeoService } from './service.ts';

const WAITING_AFTER_MS = 2 * 60 * 60 * 1000;

function readCounts(service: NeoService, now: number) {
  const asks = service.todos.listOpenAsks();
  const todos = service.todos.listCheckable();
  const active = new Set(
    todos.filter((todo) => ['todo', 'doing'].includes(todo.state)).map((todo) => todo.askId)
  );
  const questioned = new Set(
    service.todos
      .listQuestionsForAsks(asks.map((ask) => ask.id))
      .filter((question) => question.state === 'open')
      .map((question) => question.askId)
  );
  return {
    'stalled asks': asks.filter(
      (ask) =>
        ask.updatedAt <= now - WAITING_AFTER_MS && !active.has(ask.id) && !questioned.has(ask.id)
    ).length,
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
  .input(['service', 'now'])
  .pipe(
    (service: NeoService) => {
      const conversation = service.repo.conversationId();
      return conversation ? { value: conversation } : { reason: null };
    },
    'service',
    'result:conversation'
  )
  .pipe((now: number) => new Date(now).toISOString().slice(0, 10), 'now', 'day')
  .pipe((day: string) => neoDerivedId(`dropped-work:${day}`), 'day', 'id')
  .pipe(
    (service: NeoService, conversation: string, id: string) =>
      service.publications.get(conversation, id) ? { reason: null } : { value: id },
    ['service', 'conversation', 'id'],
    'result:publicationId'
  )
  .pipe(
    (service: NeoService, now: number, day: string) =>
      [
        `Daily dropped work ${day} (UTC)`,
        `Core: ${format(readCounts(service, now))}`,
        ...service
          .packs()
          .filter((pack) => pack.stats)
          .map((pack) => `${pack.id}: ${format(pack.stats!(now))}`),
      ].join('\n'),
    ['service', 'now', 'day'],
    'text'
  )
  .pipe(
    (service: NeoService, conversation: string, publicationId: string, text: string) => {
      const receipt = service.publications.append({
        conversationId: conversation,
        publicationId,
        shortText: text.slice(0, 2000),
        fullText: text,
        links: [],
      });
      if (!receipt.accepted) throw new Error(`Daily counts: ${receipt.reason}`);
      if (receipt.created) service.notifyPublicationsChanged(conversation);
    },
    ['service', 'conversation', 'publicationId', 'text'],
    'result'
  )
  .end('result') as (service: NeoService, now: number) => void;
