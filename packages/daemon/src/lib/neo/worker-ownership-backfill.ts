import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/database.ts';
import { workerOwnershipFacts } from '../../storage/repositories/worker-ownership-read-worker.ts';
import { workerOwnershipWrites } from '../../storage/repositories/worker-ownership-write-worker.ts';
import type { WorkRef, SkippedWork } from './worker-ownership-apply.ts';
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
  live?: boolean;
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
  .input(['reviewed', 'confirmedCount', 'db'])
  .pipe(
    (reviewed: WorkRef[] | undefined, confirmedCount: number | undefined) => {
      if (!reviewed?.length || confirmedCount !== reviewed.length)
        return {
          reason: {
            accepted: false as const,
            reason: 'A non-empty list and matching confirmed count are required.',
            invalid: [],
            skipped: [],
          },
        };
      if (
        new Set(reviewed.map((ref) => JSON.stringify([ref.adapter, ref.id]))).size !==
        reviewed.length
      )
        return {
          reason: {
            accepted: false as const,
            reason: 'Duplicate refs are not allowed.',
            invalid: [],
            skipped: [],
          },
        };
      return { value: reviewed };
    },
    ['reviewed', 'confirmedCount'],
    'result:outcome'
  )
  .pipe(
    (reviewed: WorkRef[], db: Database) =>
      db.gateway.call(workerOwnershipWrites, 'apply', reviewed),
    ['outcome', 'db'],
    'outcome'
  )
  .endAsync('outcome') as (
  reviewed: WorkRef[] | undefined,
  confirmedCount: number | undefined,
  db: Database
) => Promise<
  | { accepted: false; reason: string; invalid: WorkRef[]; skipped: SkippedWork[] }
  | { accepted: true; applied: WorkRef[]; skipped: SkippedWork[] }
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
        reviewed: z
          .array(z.object({ adapter: z.string().min(1), id: z.string().min(1) }))
          .optional(),
        confirmedCount: z.number().int().nonnegative().optional(),
      }),
      resultSchema: z.discriminatedUnion('accepted', [
        z.object({
          accepted: z.literal(false),
          reason: z.string(),
          invalid: z.array(z.object({ adapter: z.string(), id: z.string() })),
          skipped: z.array(
            z.object({
              adapter: z.string(),
              id: z.string(),
              reason: z.enum(['weak', 'claimed', 'live']),
            })
          ),
        }),
        z.object({
          accepted: z.literal(true),
          applied: z.array(z.object({ adapter: z.string(), id: z.string() })),
          skipped: z.array(
            z.object({
              adapter: z.string(),
              id: z.string(),
              reason: z.enum(['weak', 'claimed', 'live']),
            })
          ),
        }),
      ]),
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input) => applyReviewed(input.reviewed, input.confirmedCount, db),
    }),
  ];
}
