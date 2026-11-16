import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../../lib/drivers/types.ts';
import type { WorkOwner } from '../../lib/work-cleanup/plan.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';

class WorkCleanupRepository {
  constructor(private db: Database) {}

  owners(): {
    ref: WorkRef;
    owner: WorkOwner;
    path: string | null;
    repo: string | null;
    todoId: string | null;
  }[] {
    const bindings = this.db
      .prepare(`SELECT s.ref, t.state, s.target, t.id AS todoId
      FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id
      WHERE s.ref IS NOT NULL AND json_extract(s.ref, '$.daemon') IS NULL`)
      .all() as {
      ref: string;
      state: NeoTodo['state'];
      target: string;
      todoId: string;
    }[];
    const live = ['todo', 'doing', 'blocked', 'failed'];
    const owned = bindings
      .filter(({ target }) => {
        const start = JSON.parse(target) as { verb: string; name?: string };
        return start.verb === 'start' && !start.name;
      })
      .map(({ ref, state, todoId }) => ({
        todoId,
        ref: JSON.parse(ref) as WorkRef,
        owner: {
          kind: 'todo' as const,
          state,
          boundToLiveTodo: bindings.some((other) => {
            const peer = JSON.parse(other.ref) as WorkRef;
            const own = JSON.parse(ref) as WorkRef;
            return peer.adapter === own.adapter && peer.id === own.id && live.includes(other.state);
          }),
        },
        path: null as string | null,
        repo: null as string | null,
      }));
    const sessions = this.db
      .prepare(`SELECT id, status, worktree_path AS path,
      main_repo_path AS repo FROM sessions WHERE worktree_path IS NOT NULL`)
      .all() as {
      id: string;
      status: string;
      path: string;
      repo: string | null;
    }[];
    return [
      ...owned,
      ...sessions
        .filter(
          (session) => !owned.some(({ ref }) => ref.adapter === 'hyperneo' && ref.id === session.id)
        )
        .map((session) => ({
          todoId: null,
          ref: { adapter: 'hyperneo', id: session.id },
          owner: { kind: 'session' as const, archived: session.status === 'archived' },
          path: session.path,
          repo: session.repo,
        })),
    ];
  }
}

export const workCleanupReads = defineRepositoryOp(
  'work.cleanup.reads',
  'read',
  WorkCleanupRepository,
  ['owners']
);
