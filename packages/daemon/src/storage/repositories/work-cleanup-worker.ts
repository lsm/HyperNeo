import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../../lib/drivers/types.ts';
import type { WorkOwner } from '../../lib/work-cleanup/plan.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';

class WorkCleanupRepository {
  constructor(private db: Database) {}

  owners(refs?: readonly WorkRef[]): {
    ref: WorkRef;
    owner: WorkOwner;
    path: string | null;
    repo: string | null;
    todoId: string | null;
  }[] {
    const selected = refs ? JSON.stringify(refs) : null;
    const bindings = this.db
      .prepare(`SELECT s.ref, t.state, t.id AS todoId,
        EXISTS (SELECT 1 FROM neo_todo_sessions peer JOIN neo_todos live ON live.id = peer.todo_id
          WHERE live.state IN ('todo', 'doing', 'blocked', 'failed')
            AND COALESCE(json_extract(peer.ref, '$.adapter'), json_extract(peer.target, '$.ref.adapter')) = json_extract(s.ref, '$.adapter')
            AND COALESCE(json_extract(peer.ref, '$.id'), json_extract(peer.target, '$.ref.id')) = json_extract(s.ref, '$.id')
            AND COALESCE(json_extract(peer.ref, '$.daemon'), json_extract(peer.target, '$.ref.daemon')) IS NULL
        ) AS live
      FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id
      WHERE s.ref IS NOT NULL AND json_extract(s.ref, '$.daemon') IS NULL
        AND json_extract(s.target, '$.verb') = 'start'
        AND COALESCE(json_extract(s.target, '$.name'), '') = ''
        AND (?1 IS NULL OR EXISTS (SELECT 1 FROM json_each(?1) requested
          WHERE json_extract(requested.value, '$.adapter') = json_extract(s.ref, '$.adapter')
            AND json_extract(requested.value, '$.id') = json_extract(s.ref, '$.id')))`)
      .all(selected) as { ref: string; state: NeoTodo['state']; todoId: string; live: number }[];
    const owned = bindings.map(({ ref, state, todoId, live }) => ({
      todoId,
      ref: JSON.parse(ref) as WorkRef,
      owner: { kind: 'todo' as const, state, boundToLiveTodo: live === 1 },
      path: null as string | null,
      repo: null as string | null,
    }));
    const workers = new Set(
      owned.filter(({ ref }) => ref.adapter === 'hyperneo').map(({ ref }) => ref.id)
    );
    const sessions = this.db
      .prepare(`SELECT id, status, worktree_path AS path,
      main_repo_path AS repo FROM sessions WHERE worktree_path IS NOT NULL
        AND (?1 IS NULL OR EXISTS (SELECT 1 FROM json_each(?1) requested
          WHERE json_extract(requested.value, '$.adapter') = 'hyperneo'
            AND json_extract(requested.value, '$.id') = sessions.id))`)
      .all(selected) as {
      id: string;
      status: string;
      path: string;
      repo: string | null;
    }[];
    return [
      ...owned,
      ...sessions
        .filter((session) => !workers.has(session.id))
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
