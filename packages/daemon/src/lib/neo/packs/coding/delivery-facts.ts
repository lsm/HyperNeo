import { WorkRefSchema, type WorkRef } from '../../../drivers/types.ts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../../../storage/db-gateway/db-gateway.ts';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import { githubUrlKey, parsePrUrl } from '../../../github/parse-pr-url.ts';
import { CodingActor, CodingStageFactsRepository, type CodingStageFact } from './stage-facts.ts';
import type { NeoDeployRead } from './deploy-checks.ts';
const Text = z.string().trim().min(1);
const Evidence = z.array(Text).min(1);
export const CodingMergeGate = z.object({
  url: Text.refine((url) => !!parsePrUrl(url)),
  head: Text,
  acceptanceContract: Text,
  write: WorkRefSchema,
  reviewer: z.union([Text, WorkRefSchema]),
  qa: WorkRefSchema,
  evidence: Evidence,
});
export type CodingMergeGate = z.infer<typeof CodingMergeGate>;
export const CodingSmoke = z.object({
  actor: CodingActor,
  ref: WorkRefSchema,
  mergeCommit: Text,
  verdict: z.enum(['pass', 'fail', 'inapplicable']),
  evidence: Evidence,
  reason: Text.optional(),
  build: z.object({ daemon: Text, commit: Text }).optional(),
});
export type CodingSmoke = z.infer<typeof CodingSmoke>;
export const sameCodingWorkRef = (a: WorkRef, b: WorkRef) =>
  a.adapter === b.adapter && a.id === b.id && a.daemon === b.daemon;
export type CodingDelivery = { gate: CodingMergeGate; smoke: CodingSmoke | null };
export type CodingDeliverySnapshot = {
  required: boolean;
  deliveries: (CodingDelivery & { stages: CodingStageFact[] })[];
};
export class CodingDeliveryFactsRepository {
  constructor(private readonly db: Database) {}
  snapshot(todoId: string, prs: readonly { url: string; head?: string }[]): CodingDeliverySnapshot {
    const required = !!this.db
      .prepare(`SELECT 1 FROM pack_facts WHERE todo_id = ? AND pack = 'coding'
      AND key LIKE 'assignment:%' AND json_extract(value_json, '$.newDispatch') = 1 LIMIT 1`)
      .get(todoId);
    return {
      required,
      deliveries: required
        ? prs.flatMap((pr) => {
            const delivery = pr.head ? this.read(todoId, pr.url, pr.head) : null;
            return delivery
              ? [{ ...delivery, stages: new CodingStageFactsRepository(this.db).read(pr.url) }]
              : [];
          })
        : [],
    };
  }
  read(todoId: string, url: string, head: string): CodingDelivery | null {
    const row = this.db
      .prepare(`SELECT gate_json AS gate, smoke_json AS smoke FROM pack_coding_delivery_facts
        WHERE todo_id = ? AND url = ? AND head = ?`)
      .get(todoId, githubUrlKey(url), head) as { gate: string; smoke: string | null } | undefined;
    return row
      ? {
          gate: CodingMergeGate.parse(JSON.parse(row.gate)),
          smoke: row.smoke ? CodingSmoke.parse(JSON.parse(row.smoke)) : null,
        }
      : null;
  }
  recordGate(todoId: string, input: CodingMergeGate): void {
    const gate = CodingMergeGate.parse(input);
    this.db
      .prepare(`INSERT INTO pack_coding_delivery_facts (todo_id, url, head, gate_json)
      VALUES (?, ?, ?, ?) ON CONFLICT(todo_id, url, head) DO UPDATE SET gate_json = excluded.gate_json
      WHERE json_remove(gate_json, '$.evidence') = json_remove(excluded.gate_json, '$.evidence')`)
      .run(todoId, githubUrlKey(gate.url), gate.head, JSON.stringify(gate));
  }
  recordSmoke(todoId: string, gate: CodingMergeGate, smoke: CodingSmoke): boolean {
    return (
      this.db
        .prepare(`UPDATE pack_coding_delivery_facts SET smoke_json = ?
      WHERE todo_id = ? AND url = ? AND head = ? AND gate_json = ?`)
        .run(
          JSON.stringify(CodingSmoke.parse(smoke)),
          todoId,
          githubUrlKey(gate.url),
          gate.head,
          JSON.stringify(gate)
        ).changes === 1
    );
  }
  write<K extends 'recordGate' | 'recordSmoke'>(
    method: K,
    ...args: Parameters<CodingDeliveryFactsRepository[K]>
  ): Promise<ReturnType<CodingDeliveryFactsRepository[K]>> {
    return gatewayFor(this.db).run(codingDeliveryWrites, { method, args }) as Promise<
      ReturnType<CodingDeliveryFactsRepository[K]>
    >;
  }
}
export const codingDeliveryWrites = defineRepositoryOp(
  'coding.deliveryWrites',
  'write',
  CodingDeliveryFactsRepository,
  ['recordGate', 'recordSmoke']
);
type Rejection = { accepted: false; reason: string };
type Gate<T> = { value: T } | { reason: Rejection };
const refuse = (reason: string): { reason: Rejection } => ({ reason: { accepted: false, reason } });
export const recordCodingSmoke = (superpipe({})('coding.record-smoke') as PipelineAPI)
  .input(['repo', 'todoId', 'url', 'head', 'input', 'deploys'])
  .pipe(
    (
      repo: CodingDeliveryFactsRepository,
      todoId: string,
      url: string,
      head: string
    ): Gate<CodingDelivery> => {
      const delivery = repo.read(todoId, url, head);
      return delivery ? { value: delivery } : refuse('matching_merge_gate_required');
    },
    ['repo', 'todoId', 'url', 'head'],
    'result:result'
  )
  .pipe((result: CodingDelivery) => result, 'result', 'delivery')
  .pipe(
    (delivery: CodingDelivery, input: CodingSmoke, deploys: NeoDeployRead): Gate<CodingSmoke> => {
      const smoke = CodingSmoke.parse(input),
        gate = delivery.gate;
      if (
        smoke.actor.id !== gate.qa.id ||
        (smoke.actor.kind === 'agent' && smoke.actor.harness !== gate.qa.adapter) ||
        !sameCodingWorkRef(smoke.ref, gate.qa) ||
        sameCodingWorkRef(smoke.ref, gate.write) ||
        (typeof gate.reviewer !== 'string' && sameCodingWorkRef(smoke.ref, gate.reviewer))
      )
        return refuse('independent_qa_required');
      const merged = deploys.prs.find((pr) => githubUrlKey(pr.url) === githubUrlKey(gate.url));
      if (
        !merged?.mergeCommit ||
        merged.head !== gate.head ||
        merged.mergeCommit !== smoke.mergeCommit
      )
        return refuse('matching_merge_commit_required');
      if (smoke.verdict === 'inapplicable')
        return smoke.reason ? { value: smoke } : refuse('inapplicability_reason_required');
      return deploys.daemons.some(
        (daemon) =>
          daemon.daemon === smoke.build?.daemon &&
          daemon.commit === smoke.build?.commit &&
          daemon.contains.includes(smoke.mergeCommit)
      )
        ? { value: smoke }
        : refuse('running_build_must_contain_merge');
    },
    ['delivery', 'input', 'deploys'],
    'result:result'
  )
  .pipe((result: CodingSmoke) => result, 'result', 'smoke')
  .pipe(
    async (
      repo: CodingDeliveryFactsRepository,
      todoId: string,
      delivery: CodingDelivery,
      smoke: CodingSmoke
    ) => {
      const stored = await repo.write('recordSmoke', todoId, delivery.gate, smoke);
      return stored
        ? { accepted: true }
        : { accepted: false, reason: 'matching_merge_gate_required' };
    },
    ['repo', 'todoId', 'delivery', 'smoke'],
    'result'
  )
  .endAsync('result') as (
  repo: CodingDeliveryFactsRepository,
  todoId: string,
  url: string,
  head: string,
  input: CodingSmoke,
  deploys: NeoDeployRead
) => Promise<{ accepted: true } | Rejection>;
