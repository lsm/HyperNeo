import type { WorkRef } from '../../../drivers/types.ts';
import { WORK_START_EXCLUDE_REFS_MAX } from '../../../drivers/work-operations.ts';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { codingPrKey } from './pr-key.ts';
import { type CodingSessionStrategy, codingSessionStrategy } from './session-strategy.ts';

type Owner = { todoId: string; ref: WorkRef | null };
type Holder = Owner & { assignedAt: number };
type PoolSession = { ref: WorkRef; name: string; held: boolean };
const workKey = (ref: WorkRef) => `${ref.adapter}:${ref.daemon ?? ''}:${ref.id}`;

const SESSION_OF = `COALESCE(s.ref, json_extract(s.target, '$.ref')) AS ref`;
const RELEASED = (row: string) =>
  `NOT EXISTS (SELECT 1 FROM neo_todo_sessions r WHERE r.todo_id = ${row}.todo_id
     AND COALESCE(r.ref, json_extract(r.target, '$.ref')) IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM neo_todos t WHERE t.id = ${row}.todo_id
     AND (t.state IN ('todo', 'doing') OR (t.state NOT IN ('done', 'removed')
       AND EXISTS (SELECT 1 FROM neo_todo_sessions u WHERE u.todo_id = t.id
         AND u.start_interrupted = 1))))`;

class CodingSessionAssignments {
  constructor(private readonly db: Database) {}

  reserveFeature(input: {
    repo: string;
    featureKey: string;
    todoId: string;
    now: number;
    replace?: { todoId: string; ref: WorkRef };
  }): Owner {
    this.db
      .prepare(
        `INSERT INTO pack_coding_feature_sessions (repo, feature_key, todo_id, reserved_at)
         VALUES (?1, ?2, ?3, ?4) ON CONFLICT (repo, feature_key) DO UPDATE
         SET todo_id = excluded.todo_id, reserved_at = excluded.reserved_at
         WHERE (pack_coding_feature_sessions.todo_id = ?5 AND EXISTS (
             SELECT 1 FROM neo_todo_sessions r WHERE r.todo_id = ?5
               AND json_extract(COALESCE(r.ref, json_extract(r.target, '$.ref')), '$.adapter') = ?6
               AND json_extract(COALESCE(r.ref, json_extract(r.target, '$.ref')), '$.id') = ?7
               AND json_extract(COALESCE(r.ref, json_extract(r.target, '$.ref')), '$.daemon') IS ?8))
           OR ${RELEASED('pack_coding_feature_sessions')}`
      )
      .run(
        input.repo.toLowerCase(),
        input.featureKey,
        input.todoId,
        input.now,
        input.replace?.todoId ?? null,
        input.replace?.ref.adapter ?? null,
        input.replace?.ref.id ?? null,
        input.replace?.ref.daemon ?? null
      );
    return this.feature(input.repo, input.featureKey)!;
  }

  releaseFeature(input: { todoId: string }) {
    this.db
      .prepare(
        `DELETE FROM pack_coding_feature_sessions WHERE todo_id = ?1
         AND NOT EXISTS (SELECT 1 FROM neo_todo_sessions r WHERE r.todo_id = ?1
           AND (COALESCE(r.ref, json_extract(r.target, '$.ref')) IS NOT NULL
             OR r.start_interrupted = 1))
         AND EXISTS (SELECT 1 FROM neo_todos t WHERE t.id = ?1
           AND t.state = 'todo' AND t.started_at IS NULL)`
      )
      .run(input.todoId);
  }

  owner(input: {
    strategy: CodingSessionStrategy;
    repo: string;
    featureKey: string;
    todoId: string;
    prUrl?: string;
  }): Owner | null {
    return this.ownerAmong(input.prUrl ? this.prHolders(input.prUrl) : [], input);
  }

  private ownerAmong(
    holders: Holder[],
    input: { strategy: CodingSessionStrategy; repo: string; featureKey: string; todoId: string }
  ): Owner | null {
    const held = holders[0];
    if (held) return { todoId: held.todoId, ref: held.ref };
    if (input.strategy === 'long_lived') return this.feature(input.repo, input.featureKey);
    const own = this.session(input.todoId);
    return own && { todoId: own.todoId, ref: own.ref };
  }

  actorRefs(input?: { adapter?: string }): WorkRef[] {
    const seen = new Set<string>();
    return (
      this.db
        .prepare(
          `SELECT json_extract(value_json, '$.ref') AS ref FROM pack_facts
           WHERE pack = 'coding' AND key LIKE 'assignment:%' ORDER BY rowid DESC`
        )
        .all() as { ref: string | null }[]
    )
      .flatMap((row) => (row.ref ? [JSON.parse(row.ref) as WorkRef] : []))
      .filter(
        (ref) =>
          (!input?.adapter || ref.adapter === input.adapter) &&
          !seen.has(workKey(ref)) &&
          (seen.add(workKey(ref)), true)
      )
      .slice(0, WORK_START_EXCLUDE_REFS_MAX);
  }

  dispatchFacts(input: { todoId: string; featureKey: string; adapter: string; prUrl?: string }) {
    const repo = (
      this.db.prepare('SELECT repo FROM pack_coding_todos WHERE todo_id = ?').get(input.todoId) as {
        repo: string | null;
      } | null
    )?.repo;
    if (!repo) return null;
    const strategy = codingSessionStrategy(this.db, repo);
    const rows = this.db
      .prepare(
        `SELECT t.id, t.state, ${SESSION_OF}, json_extract(s.target, '$.name') AS name
         FROM neo_todo_sessions s JOIN pack_coding_todos p ON p.todo_id = s.todo_id
         JOIN neo_todos t ON t.id = s.todo_id WHERE lower(p.repo) = lower(?)`
      )
      .all(repo) as { id: string; state: string; ref: string | null; name: string | null }[];
    const pool = new Map<string, PoolSession>();
    for (const row of rows) {
      if (!row.ref) continue;
      const ref = JSON.parse(row.ref) as WorkRef;
      const known = pool.get(workKey(ref)) ?? { ref, name: '', held: false };
      known.name ||= row.name ?? '';
      known.held ||= row.id !== input.todoId && ['doing', 'blocked'].includes(row.state);
      pool.set(workKey(ref), known);
    }
    const holders = input.prUrl ? this.prHolders(input.prUrl) : [];
    const actors = new Set(this.actorRefs({ adapter: input.adapter }).map(workKey));
    const pooled = (owner: Owner | null) =>
      owner && {
        todoId: owner.todoId,
        session:
          owner.ref && (pool.get(workKey(owner.ref)) ?? { ref: owner.ref, name: '', held: false }),
      };
    return {
      repo,
      strategy,
      owner: pooled(this.ownerAmong(holders, { ...input, repo, strategy })),
      feature: pooled(strategy === 'long_lived' ? this.feature(repo, input.featureKey) : null),
      successors: [...holders].sort((a, b) => b.assignedAt - a.assignedAt).map(pooled),
      pool: [...pool.values()].filter(
        (session) => session.ref.adapter === input.adapter && !actors.has(workKey(session.ref))
      ),
    };
  }

  private feature(repo: string, featureKey: string): Owner | null {
    const row = this.db
      .prepare(
        `SELECT f.todo_id AS todoId, ${SESSION_OF} FROM pack_coding_feature_sessions f
         LEFT JOIN neo_todo_sessions s ON s.todo_id = f.todo_id
         WHERE f.repo = ? AND f.feature_key = ? AND NOT (${RELEASED('f')})`
      )
      .get(repo.toLowerCase(), featureKey) as { todoId: string; ref: string | null } | null;
    return row ? { todoId: row.todoId, ref: row.ref ? JSON.parse(row.ref) : null } : null;
  }

  private session(todoId: string): Holder | null {
    const row = this.db
      .prepare(
        `SELECT ${SESSION_OF}, COALESCE(s.started_at, 0) AS assignedAt
         FROM neo_todo_sessions s WHERE s.todo_id = ?`
      )
      .get(todoId) as { ref: string | null; assignedAt: number } | null;
    return row?.ref ? { todoId, ref: JSON.parse(row.ref), assignedAt: row.assignedAt } : null;
  }

  private prHolders(url: string): Holder[] {
    const key = codingPrKey(url);
    if (!key) return [];
    const rows = this.db
      .prepare(
        `SELECT p.todo_id AS todoId, p.prs_json AS prs FROM pack_coding_todo_prs p
         JOIN neo_todos t ON t.id = p.todo_id AND t.state <> 'removed'
         ORDER BY t.created_at, t.position`
      )
      .all() as { todoId: string; prs: string }[];
    return rows.flatMap((row) => {
      const named = (JSON.parse(row.prs) as { url: string }[]).some(
        (pr) => codingPrKey(pr.url) === key
      );
      const holder = named ? this.session(row.todoId) : null;
      return holder ? [holder] : [];
    });
  }
}

export const codingSessionAssignmentReads = defineRepositoryOp(
  'coding.sessionAssignmentReads',
  'read',
  CodingSessionAssignments,
  ['owner', 'dispatchFacts', 'actorRefs']
);
export const codingSessionAssignmentWrites = defineRepositoryOp(
  'coding.sessionAssignmentWrites',
  'write',
  CodingSessionAssignments,
  ['reserveFeature', 'releaseFeature']
);
