import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/database.ts';
import { workerOwnershipFacts } from '../../storage/repositories/worker-ownership-read-worker.ts';
import { workerOwnershipWrites } from '../../storage/repositories/worker-ownership-write-worker.ts';
import { reviewedWorkerListId, type WorkRef } from './worker-ownership-apply.ts';
import { defineOperation } from '../operations/registry.ts';

export type WorkerOwnershipRow = {
  adapter: string;
  id: string;
  startedAt: number;
  claimedBy: string | null;
  releasedAt: number | null;
  role: string | null;
};
export type WorkerOwnershipTouch = {
  adapter: string;
  id: string;
  verb: string;
  humanNamed: boolean;
};

export function inferWorkerOwnership(
  rows: readonly WorkerOwnershipRow[],
  touches: readonly WorkerOwnershipTouch[]
) {
  const candidates = rows.flatMap((row) => {
    if (row.role || row.releasedAt !== null) return [];
    const related = touches.filter((touch) => touch.adapter === row.adapter && touch.id === row.id);
    if (related.some((touch) => touch.humanNamed || ['send', 'adopt', 'bind'].includes(touch.verb)))
      return [];
    const verbs = [...new Set(related.map((touch) => touch.verb))].sort();
    return [
      {
        adapter: row.adapter,
        id: row.id,
        evidence: {
          basis: 'row present with empty role',
          startedAt: row.startedAt,
          claimedBy: row.claimedBy,
          verbs,
          strength: verbs.includes('start') ? 'inferred' : 'inferred, weak',
        },
      },
    ];
  });
  return {
    notice: 'Creation is inferred, not proven. Review every candidate before applying.',
    candidates,
    counts: { candidates: candidates.length, examined: rows.length },
  };
}

async function readFacts(db: Database) {
  const { rows, touches } = await db.gateway.call(workerOwnershipFacts, 'readFacts');
  return inferWorkerOwnership(rows, touches);
}

const dryRun = (superpipe({})('neo.workerOwnership.candidates') as PipelineAPI)
  .input(['db'])
  .pipe(readFacts, 'db', 'result')
  .endAsync('result') as (db: Database) => Promise<ReturnType<typeof inferWorkerOwnership>>;
const applyReviewed = (superpipe({})('neo.workerOwnership.apply') as PipelineAPI)
  .input(['reviewedListId', 'reviewed', 'criteria', 'db'])
  .pipe(
    (
      reviewedListId: string | undefined,
      reviewed: WorkRef[] | undefined,
      criteria: string | undefined
    ) => {
      if (!reviewedListId || !reviewed || criteria !== 'start-unclaimed')
        return {
          reason: {
            accepted: false as const,
            reason: 'A reviewed list and start-unclaimed criteria are required.',
          },
        };
      if (
        new Set(reviewed.map((ref) => JSON.stringify([ref.adapter, ref.id]))).size !==
          reviewed.length ||
        reviewedWorkerListId(reviewed) !== reviewedListId
      )
        return {
          reason: {
            accepted: false as const,
            reason: 'Reviewed list id does not match the supplied list.',
          },
        };
      return { value: reviewed };
    },
    ['reviewedListId', 'reviewed', 'criteria'],
    'result:outcome'
  )
  .pipe(
    (reviewed: WorkRef[], db: Database) =>
      db.gateway.call(workerOwnershipWrites, 'apply', reviewed),
    ['outcome', 'db'],
    'outcome'
  )
  .endAsync('outcome') as (
  id: string | undefined,
  reviewed: WorkRef[] | undefined,
  criteria: string | undefined,
  db: Database
) => Promise<
  { accepted: false; reason: string } | { accepted: true; applied: number; reviewed: number }
>;

const CandidateSchema = z.object({
  adapter: z.string(),
  id: z.string(),
  evidence: z.object({
    basis: z.string(),
    startedAt: z.number(),
    claimedBy: z.string().nullable(),
    verbs: z.array(z.string()),
    strength: z.string(),
  }),
});
export function createWorkerOwnershipBackfillOperations(db: Database) {
  return [
    defineOperation({
      name: 'neo.workerOwnership.candidates',
      description: 'List inferred historical worker ownership for human review.',
      inputSchema: z.object({}),
      resultSchema: z.object({
        notice: z.string(),
        candidates: z.array(CandidateSchema),
        counts: z.object({ candidates: z.number(), examined: z.number() }),
      }),
      policy: { safetyClass: 'read', roles: ['neo'] },
      execute: async () => dryRun(db),
    }),
    defineOperation({
      name: 'neo.workerOwnership.apply',
      description: 'Apply reviewed historical worker ownership for unclaimed start bindings.',
      inputSchema: z.object({
        reviewedListId: z.string().trim().min(1).optional(),
        reviewed: z
          .array(z.object({ adapter: z.string().min(1), id: z.string().min(1) }))
          .min(1)
          .optional(),
        criteria: z.string().optional(),
      }),
      resultSchema: z.discriminatedUnion('accepted', [
        z.object({ accepted: z.literal(false), reason: z.string() }),
        z.object({ accepted: z.literal(true), applied: z.number(), reviewed: z.number() }),
      ]),
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input) =>
        applyReviewed(input.reviewedListId, input.reviewed, input.criteria, db),
    }),
  ];
}
