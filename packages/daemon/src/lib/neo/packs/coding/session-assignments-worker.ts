import type { WorkRef } from '../../../drivers/types.ts';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { codingPrKey } from './pr-key.ts';
import type { CodingSessionStrategy } from './session-strategy.ts';

type Owner = { todoId: string; ref: WorkRef | null };

const SESSION_OF = `COALESCE(s.ref, json_extract(s.target, '$.ref')) AS ref`;

class CodingSessionAssignments {
  constructor(private readonly db: Database) {}

  reserveFeature(input: { repo: string; featureKey: string; todoId: string; now: number }): Owner {
    this.db
      .prepare(
        `INSERT INTO pack_coding_feature_sessions (repo, feature_key, todo_id, reserved_at)
         VALUES (?, ?, ?, ?) ON CONFLICT (repo, feature_key) DO NOTHING`
      )
      .run(input.repo.toLowerCase(), input.featureKey, input.todoId, input.now);
    return this.feature(input.repo, input.featureKey)!;
  }

  owner(input: {
    strategy: CodingSessionStrategy;
    repo: string;
    featureKey: string;
    todoId: string;
    prUrl?: string;
  }): Owner | null {
    const held = input.prUrl ? this.prHolder(input.prUrl) : null;
    if (held) return held;
    if (input.strategy === 'long_lived') return this.feature(input.repo, input.featureKey);
    return this.session(input.todoId);
  }

  private feature(repo: string, featureKey: string): Owner | null {
    const row = this.db
      .prepare(
        `SELECT f.todo_id AS todoId, ${SESSION_OF} FROM pack_coding_feature_sessions f
         LEFT JOIN neo_todo_sessions s ON s.todo_id = f.todo_id
         WHERE f.repo = ? AND f.feature_key = ?`
      )
      .get(repo.toLowerCase(), featureKey) as { todoId: string; ref: string | null } | null;
    return row ? { todoId: row.todoId, ref: row.ref ? JSON.parse(row.ref) : null } : null;
  }

  private session(todoId: string): Owner | null {
    const row = this.db
      .prepare(`SELECT ${SESSION_OF} FROM neo_todo_sessions s WHERE s.todo_id = ?`)
      .get(todoId) as { ref: string | null } | null;
    return row?.ref ? { todoId, ref: JSON.parse(row.ref) } : null;
  }

  private prHolder(url: string): Owner | null {
    const key = codingPrKey(url);
    const rows = this.db
      .prepare(
        `SELECT p.todo_id AS todoId, p.prs_json AS prs FROM pack_coding_todo_prs p
         JOIN neo_todos t ON t.id = p.todo_id AND t.state <> 'removed'
         ORDER BY t.created_at, t.position`
      )
      .all() as { todoId: string; prs: string }[];
    for (const row of rows) {
      if (!(JSON.parse(row.prs) as { url: string }[]).some((pr) => codingPrKey(pr.url) === key))
        continue;
      const owner = this.session(row.todoId);
      if (owner) return owner;
    }
    return null;
  }
}

export const codingSessionAssignmentReads = defineRepositoryOp(
  'coding.sessionAssignmentReads',
  'read',
  CodingSessionAssignments,
  ['owner']
);
export const codingSessionAssignmentWrites = defineRepositoryOp(
  'coding.sessionAssignmentWrites',
  'write',
  CodingSessionAssignments,
  ['reserveFeature']
);
