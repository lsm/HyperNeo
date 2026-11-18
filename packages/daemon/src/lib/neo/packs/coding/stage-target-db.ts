import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { CodingAssignmentsRepository } from './assignments.ts';
import { codingLineScope } from './stage-lines.ts';
import { codingStagePreference } from './stage-preferences.ts';

class CodingStageTargetQueries {
  constructor(private readonly db: Database) {}

  repo(todoId: string) {
    return (
      (
        this.db.prepare('SELECT repo FROM pack_coding_todos WHERE todo_id = ?').get(todoId) as {
          repo: string | null;
        } | null
      )?.repo ?? null
    );
  }

  planTarget(input: Parameters<CodingAssignmentsRepository['planTarget']>[0]) {
    return new CodingAssignmentsRepository(this.db).planTarget(input);
  }

  stagePreference(input: Parameters<typeof codingStagePreference>[1]) {
    return codingStagePreference(this.db, input);
  }

  lineScope(input: { todoId: string; repo?: string }) {
    return codingLineScope(this.db, input.todoId, input.repo);
  }
}

export const codingStageTargetReads = defineRepositoryOp(
  'coding.stageTarget.reads',
  'read',
  CodingStageTargetQueries,
  ['planTarget', 'stagePreference', 'lineScope', 'repo']
);
