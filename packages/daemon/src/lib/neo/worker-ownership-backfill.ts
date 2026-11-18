import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/database.ts';
import { workerOwnershipFacts } from '../../storage/repositories/worker-ownership-read-worker.ts';
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
const refuseApply = (superpipe({})('neo.workerOwnership.apply') as PipelineAPI)
  .input(['reviewedListId'])
  .pipe(
    (reviewedListId: string | undefined) => ({
      accepted: false as const,
      reason: reviewedListId
        ? 'Apply is not available until the candidate list has been reviewed.'
        : 'A reviewed-list id is required.',
    }),
    'reviewedListId',
    'result'
  )
  .endAsync('result') as (id?: string) => Promise<{ accepted: false; reason: string }>;

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
      description: 'Refuse historical worker ownership application pending review.',
      inputSchema: z.object({ reviewedListId: z.string().trim().min(1).optional() }),
      resultSchema: z.object({ accepted: z.literal(false), reason: z.string() }),
      policy: { safetyClass: 'mutate', roles: ['neo'] },
      execute: async (input) => refuseApply(input.reviewedListId),
    }),
  ];
}
