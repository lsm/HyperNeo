import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { CodingAssignmentsRepository } from './assignments.ts';

class CodingStageTargetQueries {
  constructor(private readonly db: Database) {}

  planTarget(input: Parameters<CodingAssignmentsRepository['planTarget']>[0]) {
    return new CodingAssignmentsRepository(this.db).planTarget(input);
  }
}

export const codingStageTargetReads = defineRepositoryOp(
  'coding.stageTarget.reads',
  'read',
  CodingStageTargetQueries,
  ['planTarget']
);
