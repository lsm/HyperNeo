import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAsk, NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { NeoSessionNotice } from '../../lib/neo/session-watch.ts';
import { requireNeoTrackRoot, requireNeoTrackableSession } from '../../lib/neo/session-track.ts';
import { type ChangeRecorder, defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoAskTodoRepository } from './neo-ask-todo-repository.ts';
import { NeoRepository } from './neo-repository.ts';
import { NeoTodoSessionRepository } from './neo-todo-session-repository.ts';

type Input = {
  askId: string;
  todoId: string;
  notice: NeoSessionNotice;
  now: number;
};
type Result =
  | { ok: false; reason: string }
  | {
      ok: true;
      root: string;
      messageId: string;
      ask: NeoAsk;
      todo: NeoTodo;
      ref: NeoSessionNotice['ref'];
      link: string | null;
    };

const track = (superpipe({})('neo.session.track-commit') as PipelineAPI)
  .input(['db', 'input', 'changes'])
  .pipe(
    (db: Database) => requireNeoTrackRoot(new NeoRepository(db).defaultBinding()?.sessionId),
    'db',
    'result:outcome'
  )
  .pipe((root: string) => root, 'outcome', 'root')
  .pipe(
    (db: Database, changes: ChangeRecorder) =>
      new NeoAskTodoRepository(
        db,
        () => {
          changes.notifyChange('neo_asks');
          changes.notifyChange('neo_todos');
        },
        undefined,
        () => changes.notifyChange('neo_questions')
      ),
    ['db', 'changes'],
    'store'
  )
  .pipe((db: Database) => new NeoTodoSessionRepository(db), 'db', 'sessions')
  .pipe(
    (store: NeoAskTodoRepository, input: Input) =>
      requireNeoTrackableSession(input.notice, store.followedRefs()),
    ['store', 'input'],
    'result:outcome'
  )
  .pipe(
    (
      store: NeoAskTodoRepository,
      sessions: NeoTodoSessionRepository,
      root: string,
      input: Input,
      changes: ChangeRecorder
    ): Result => {
      const { notice, now } = input;
      const messageId = `neo-track:${notice.key}:${input.askId}`;
      const done = 'The session finishes its work';
      const ask = store.openAsk({
        id: input.askId,
        projectId: null,
        sessionId: root,
        originMessageId: messageId,
        title: notice.title,
        request: `See ${notice.title} through.`,
        createdAt: now,
      });
      const initial = store.addTodo(
        input.todoId,
        ask.id,
        { title: done, doneWhen: done, check: null, instruction: null, named: null },
        now
      );
      sessions.create(initial.id, { verb: 'adopt', ref: notice.ref });
      sessions.recordRef(initial.id, notice.ref, now, notice.link);
      sessions.recordFollowAnchor(initial.id, now);
      const committed = store.commitState(initial.id, { state: 'doing', startedAt: now }, now, {
        state: 'no_opinion',
      });
      changes.notifyChange('neo_todo_sessions');
      return {
        ok: true,
        root,
        messageId,
        ask: store.getAsk(ask.id)!,
        todo: committed.todo!,
        ref: sessions.readRef(initial.id)!,
        link: sessions.readLinks(initial.id).link,
      };
    },
    ['store', 'sessions', 'root', 'input', 'changes'],
    'outcome'
  )
  .end('outcome') as (db: Database, input: Input, changes: ChangeRecorder) => Result;

export const neoSessionTrackWrites = defineDbOp({
  name: 'neo.sessionTrackWrites',
  mode: 'write',
  run: (db: Database, input: Input, changes: ChangeRecorder) => {
    const workerStartedAt = Date.now();
    const result = track(db, input, changes);
    return result.ok
      ? { ...result, timings: { workerStartedAt, workerPreparedAt: Date.now() } }
      : result;
  },
});
