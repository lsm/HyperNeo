import { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import { WorkRefSchema } from '../../../drivers/types.ts';
import { githubUrlKey, parsePrUrl } from '../../../github/parse-pr-url.ts';
import { CodingActor } from './stage-facts.ts';

export const CodingAssignment = z
  .object({
    url: z.string().refine((url) => !!parsePrUrl(url)),
    head: z.string().min(1),
    acceptanceContract: z.string().trim().min(1),
    newDispatch: z.literal(true),
    write: WorkRefSchema,
    actor: CodingActor.optional(),
    ref: WorkRefSchema.optional(),
    bot: z.string().optional(),
    effort: z.string().optional(),
    fallback: z.array(z.string()).optional(),
  })
  .refine((value) =>
    value.bot
      ? !value.actor && !value.ref
      : value.actor &&
        value.ref &&
        value.actor.id === value.ref.id &&
        (value.actor.kind === 'human'
          ? value.ref.adapter === 'human'
          : value.actor.harness === value.ref.adapter) &&
        !isDeepStrictEqual(value.write, value.ref)
  );
export type CodingAssignment = z.infer<typeof CodingAssignment>;
type Stage = 'review' | 'qa';
const key = (url: string, head: string, stage: Stage) =>
  `assignment:${githubUrlKey(url)}:${head}:${stage}`;

export class CodingAssignmentsRepository {
  constructor(private readonly db: Database) {}

  read(todoId: string, url: string, head: string): Partial<Record<Stage, CodingAssignment>> {
    const rows = this.db
      .prepare(`SELECT key, value_json FROM pack_facts
      WHERE todo_id = ? AND pack = 'coding' AND key IN (?, ?)`)
      .all(todoId, key(url, head, 'review'), key(url, head, 'qa')) as {
      key: string;
      value_json: string;
    }[];
    return Object.fromEntries(
      rows.map((row) => [
        row.key.endsWith(':review') ? 'review' : 'qa',
        CodingAssignment.parse(JSON.parse(row.value_json)),
      ])
    );
  }

  record(todoId: string, stage: Stage, input: CodingAssignment): boolean {
    const assignment = CodingAssignment.parse(input);
    assignment.url = githubUrlKey(assignment.url);
    return this.db.transaction(() => {
      if (
        this.db
          .prepare(`SELECT 1 FROM pack_facts WHERE todo_id = ? AND pack = 'coding'
        AND key LIKE 'assignment:%' AND json_extract(value_json, '$.acceptanceContract') <> ? LIMIT 1`)
          .get(todoId, assignment.acceptanceContract)
      )
        return false;
      const previous = this.read(todoId, assignment.url, assignment.head);
      if (
        Object.values(previous).some(
          (item) =>
            item.acceptanceContract !== assignment.acceptanceContract ||
            !isDeepStrictEqual(item.write, assignment.write)
        )
      )
        return false;
      if (
        stage === 'qa' &&
        (assignment.bot ||
          !previous.review ||
          isDeepStrictEqual(previous.review.ref, assignment.ref))
      )
        return false;
      return (
        this.db
          .prepare(`INSERT INTO pack_facts (todo_id, pack, key, value_json)
      SELECT ?, 'coding', ?, ? WHERE EXISTS
        (SELECT 1 FROM pack_coding_stage_heads WHERE url = ? AND head = ?)
      ON CONFLICT(todo_id, pack, key) DO NOTHING`)
          .run(
            todoId,
            key(assignment.url, assignment.head, stage),
            JSON.stringify(assignment),
            assignment.url,
            assignment.head
          ).changes === 1
      );
    })();
  }

  recordLater(todoId: string, stage: Stage, assignment: CodingAssignment): Promise<boolean> {
    return gatewayFor(this.db).call(
      codingAssignmentWrites,
      'record',
      todoId,
      stage,
      assignment
    ) as Promise<boolean>;
  }
}

export const codingAssignmentWrites = defineRepositoryOp(
  'coding.assignmentWrites',
  'write',
  CodingAssignmentsRepository,
  ['record']
);
