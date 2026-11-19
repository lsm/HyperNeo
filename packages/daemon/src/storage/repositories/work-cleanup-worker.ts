import type { NeoTodo } from '@hyperneo/shared/types/neo-ask';
import type { WorkRef } from '../../lib/drivers/types.ts';
import type { WorkOwner } from '../../lib/work-cleanup/plan.ts';
import { mentionsFolder } from '../../lib/work-cleanup/references.ts';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';

const QUESTION_COLUMNS = [
  'text',
  'options',
  'labels',
  'no_label',
  'yes_label',
  'todos',
  'confirm_json',
  'document',
  'reply_to_json',
  'todo_id',
  'artifacts_json',
  'source_session_json',
  'worker_answers_json',
  'retire_when_json',
  'answer',
  'cause',
  'hold_requests',
].join(', ');
const TODO_COLUMNS = [
  'title',
  'done_when',
  'check_json',
  'instruction',
  'named',
  'reason',
  'report',
  'evidence',
  'blocked_reason',
  'next_action',
  'blocked_by',
  'artifacts_json',
  'depends_on',
].join(', ');

class WorkCleanupRepository {
  constructor(private db: Database) {}

  owners(
    refs?: readonly WorkRef[],
    folder?: string
  ): {
    ref: WorkRef;
    owner: WorkOwner;
    path: string | null;
    repo: string | null;
    todoId: string | null;
  }[] {
    const selected = refs ? JSON.stringify(refs) : null;
    const removed = `WITH removed AS MATERIALIZED (
      SELECT json_extract(s.ref, '$.adapter') AS adapter, json_extract(s.ref, '$.id') AS id
      FROM neo_todo_sessions s JOIN pack_facts f ON f.todo_id = s.todo_id
      WHERE f.pack = 'core' AND f.key = 'released'
        AND json_extract(s.ref, '$.daemon') IS NULL
        AND json_extract(f.value_json, '$.ok') = 1
        AND json_extract(f.value_json, '$.value.worktree.removed') = 1
    )`;
    const bindings = this.db
      .prepare(`${removed} SELECT s.ref, t.state, t.id AS todoId,
        EXISTS (SELECT 1 FROM neo_todo_sessions peer JOIN neo_todos live ON live.id = peer.todo_id
          WHERE (live.state IN ('todo', 'doing', 'blocked')
              OR (EXISTS (SELECT 1 FROM pack_facts k WHERE k.todo_id = peer.todo_id AND k.pack = 'core' AND k.key = 'release_kept')
                AND NOT EXISTS (SELECT 1 FROM pack_facts r WHERE r.todo_id = peer.todo_id AND r.pack = 'core' AND r.key = 'released')))
            AND COALESCE(json_extract(peer.ref, '$.adapter'), json_extract(peer.target, '$.ref.adapter')) = json_extract(s.ref, '$.adapter')
            AND COALESCE(json_extract(peer.ref, '$.id'), json_extract(peer.target, '$.ref.id')) = json_extract(s.ref, '$.id')
            AND COALESCE(json_extract(peer.ref, '$.daemon'), json_extract(peer.target, '$.ref.daemon')) IS NULL
        ) AS live
      FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id
      WHERE s.ref IS NOT NULL AND json_extract(s.ref, '$.daemon') IS NULL
        AND NOT EXISTS (SELECT 1 FROM removed WHERE removed.adapter = json_extract(s.ref, '$.adapter') AND removed.id = json_extract(s.ref, '$.id'))
        AND json_extract(s.target, '$.verb') = 'start'
        AND COALESCE(json_extract(s.target, '$.name'), '') = ''
        AND (?1 IS NULL OR EXISTS (SELECT 1 FROM json_each(?1) requested
          WHERE json_extract(requested.value, '$.adapter') = json_extract(s.ref, '$.adapter')
            AND json_extract(requested.value, '$.id') = json_extract(s.ref, '$.id')))`)
      .all(selected) as {
      ref: string;
      state: NeoTodo['state'];
      todoId: string;
      live: number;
    }[];
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
      .prepare(`${removed} SELECT id, status, COALESCE(worktree_path, workspace_path) AS path,
      main_repo_path AS repo FROM sessions WHERE (worktree_path IS NOT NULL
          OR ?2 IS NOT NULL AND status != 'archived')
        AND NOT EXISTS (SELECT 1 FROM removed WHERE removed.adapter = 'hyperneo' AND removed.id = sessions.id)
        AND (?1 IS NULL OR COALESCE(worktree_path, workspace_path) = ?2
          OR ?2 IS NOT NULL AND status != 'archived' OR EXISTS (SELECT 1 FROM json_each(?1) requested
          WHERE json_extract(requested.value, '$.adapter') = 'hyperneo'
            AND json_extract(requested.value, '$.id') = sessions.id))`)
      .all(selected, folder ?? null) as {
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

  evidence(name: string): {
    todo: { state: NeoTodo['state']; since: number } | null;
    goneAt: number | null;
  } {
    const todo = this.db
      .prepare(
        'SELECT state, COALESCE(finished_at, updated_at) AS since FROM neo_todos WHERE id = ?'
      )
      .get(name) as { state: NeoTodo['state']; since: number } | null;
    const gone = this.db
      .prepare('SELECT gone_at AS goneAt FROM work_cleanup_gone WHERE key = ?')
      .get(name) as { goneAt: number } | null;
    return { todo, goneAt: gone?.goneAt ?? null };
  }

  referenced(paths: readonly string[]): string[] {
    const stored = [
      ...this.db
        .prepare(`SELECT ${QUESTION_COLUMNS} FROM neo_questions WHERE state = 'open'`)
        .all(),
      ...this.db
        .prepare(
          `SELECT ${TODO_COLUMNS} FROM neo_todos WHERE state IN ('todo', 'doing', 'blocked')`
        )
        .all(),
    ]
      .flatMap((row) => Object.values(row as Record<string, unknown>))
      .filter((value) => typeof value === 'string');
    return paths.filter((path) => stored.some((value) => mentionsFolder(value, path)));
  }

  workerFolders(): string[] {
    return (
      this.db
        .prepare(`SELECT json_extract(value_json, '$.value.worktree.directory') AS path
        FROM pack_facts WHERE pack = 'core' AND key = 'released'
          AND json_extract(value_json, '$.value.worktree.directory') IS NOT NULL
        UNION SELECT path FROM (SELECT CASE WHEN json_valid(metadata)
          THEN json_extract(metadata, '$.archivedWorktree.worktreePath') END AS path FROM sessions)
        WHERE path IS NOT NULL`)
        .all() as { path: string }[]
    ).map(({ path }) => path);
  }

  gone(): { key: string; goneAt: number }[] {
    return this.db.prepare('SELECT key, gone_at AS goneAt FROM work_cleanup_gone').all() as {
      key: string;
      goneAt: number;
    }[];
  }

  markGone(key: string, at: number): void {
    this.db
      .prepare('INSERT OR IGNORE INTO work_cleanup_gone (key, gone_at) VALUES (?, ?)')
      .run(key, at);
  }

  forgetGone(keys: readonly string[]): void {
    const forget = this.db.prepare('DELETE FROM work_cleanup_gone WHERE key = ?');
    for (const key of keys) forget.run(key);
  }

  liveBindings(): { ref: WorkRef | null; todoId: string; state: NeoTodo['state'] }[] {
    return (
      this.db
        .prepare(`SELECT COALESCE(s.ref, json_extract(s.target, '$.ref')) AS ref, t.id AS todoId, t.state
        FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id
        WHERE t.state IN ('todo', 'doing', 'blocked')
          AND COALESCE(json_extract(s.ref, '$.daemon'), json_extract(s.target, '$.ref.daemon')) IS NULL
          AND (COALESCE(s.ref, json_extract(s.target, '$.ref')) IS NOT NULL OR t.state = 'doing')`)
        .all() as { ref: string | null; todoId: string; state: NeoTodo['state'] }[]
    ).map((row) => ({ ...row, ref: row.ref ? (JSON.parse(row.ref) as WorkRef) : null }));
  }
}

export const workCleanupReads = defineRepositoryOp(
  'work.cleanup.reads',
  'read',
  WorkCleanupRepository,
  ['owners', 'liveBindings', 'evidence', 'referenced', 'workerFolders', 'gone']
);

export const workCleanupWrites = defineRepositoryOp(
  'work.cleanup.writes',
  'write',
  WorkCleanupRepository,
  ['markGone', 'forgetGone']
);
