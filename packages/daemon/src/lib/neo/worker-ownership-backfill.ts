import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../storage/database.ts';
import { defineOperation } from '../operations/registry.ts';

type Row = {
  adapter: string;
  id: string;
  startedAt: number;
  claimedBy: string | null;
  releasedAt: number | null;
  role: string | null;
};
type Touch = { adapter: string; id: string; verb: string; humanNamed: boolean };

export function inferWorkerOwnership(rows: readonly Row[], touches: readonly Touch[]) {
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

function readFacts(db: Database) {
  const raw = db.getDatabase();
  const rows = raw
    .prepare(
      `SELECT adapter, id, started_at AS startedAt, claimed_by AS claimedBy, released_at AS releasedAt, role FROM work_started_sessions ORDER BY adapter, id`
    )
    .all() as Row[];
  const bindings = raw
    .prepare(
      `SELECT s.ref, s.target, t.named FROM neo_todo_sessions s JOIN neo_todos t ON t.id = s.todo_id`
    )
    .all() as { ref: string | null; target: string; named: string | null }[];
  const touches: Touch[] = [];
  for (const binding of bindings) {
    const target = JSON.parse(binding.target) as {
      verb: string;
      ref?: { adapter: string; id: string; daemon?: string };
    };
    const named = binding.named ? (JSON.parse(binding.named) as { session?: unknown }) : null;
    const refs = [
      binding.ref
        ? (JSON.parse(binding.ref) as { adapter: string; id: string; daemon?: string })
        : null,
      target.ref,
    ];
    for (const ref of refs)
      if (ref && !ref.daemon)
        touches.push({
          adapter: ref.adapter,
          id: ref.id,
          verb: target.verb,
          humanNamed: named?.session != null,
        });
  }
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
