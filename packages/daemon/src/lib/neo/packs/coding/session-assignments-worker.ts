import type { WorkRef } from '../../../drivers/types.ts';
import { WORK_START_EXCLUDE_REFS_MAX } from '../../../drivers/work-operations.ts';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';

const workKey = (ref: WorkRef) => `${ref.adapter}:${ref.daemon ?? ''}:${ref.id}`;

class CodingSessionAssignments {
  constructor(private readonly db: Database) {}

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

  repo(todoId: string) {
    return (
      (
        this.db.prepare('SELECT repo FROM pack_coding_todos WHERE todo_id = ?').get(todoId) as {
          repo: string | null;
        } | null
      )?.repo ?? null
    );
  }
}

export const codingSessionAssignmentReads = defineRepositoryOp(
  'coding.sessionAssignmentReads',
  'read',
  CodingSessionAssignments,
  ['actorRefs', 'repo']
);
