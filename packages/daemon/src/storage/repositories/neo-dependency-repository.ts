import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoAsk, NeoAskItem } from '@hyperneo/shared/types/neo-snapshot';
import { neoDependencyGraphPolicy } from '../../lib/neo/dependency-graph-policy.ts';
import type { Database } from '../sqlite-compat.ts';
import type { NeoAskRepository } from './neo-ask-repository.ts';

type Edge = { workId: string; prerequisiteId: string };
type Eligibility = (ask: NeoAsk, item: NeoAskItem) => boolean;

export class NeoDependencyRepository {
  readonly policy = neoDependencyGraphPolicy;
  constructor(
    private readonly db: Database,
    private readonly asks: NeoAskRepository,
    private readonly notify: () => void = () => {}
  ) {}

  edges(): Edge[] {
    return this.db
      .prepare(`SELECT work_id AS workId, prerequisite_id AS prerequisiteId
      FROM neo_work_dependencies ORDER BY work_id, prerequisite_id`)
      .all() as Edge[];
  }

  hasStartIntent(workId: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM neo_work_start_intents WHERE work_id = ?').get(workId);
  }

  recordStartIntent(workId: string, at: number): void {
    this.db
      .prepare(
        'INSERT INTO neo_work_start_intents(work_id, intent_at) VALUES (?, ?) ON CONFLICT(work_id) DO NOTHING'
      )
      .run(workId, at);
  }

  clearStartIntent(workId: string): void {
    this.db.prepare('DELETE FROM neo_work_start_intents WHERE work_id = ?').run(workId);
  }

  dependents(prerequisiteId: string): string[] {
    return (
      this.db
        .prepare('SELECT work_id AS workId FROM neo_work_dependencies WHERE prerequisite_id = ?')
        .all(prerequisiteId) as { workId: string }[]
    ).map((row) => row.workId);
  }

  private cards(eligible: Eligibility = () => false) {
    const asks = new Map(this.asks.list().map((ask) => [ask.id, ask]));
    const rows = this.db
      .prepare(`SELECT w.id, w.status, a.ask_id AS askId, d.started_at AS startedAt
      FROM neo_work w LEFT JOIN neo_ask_work a ON a.work_id = w.id
      LEFT JOIN neo_work_driver_targets d ON d.work_id = w.id`)
      .all() as { id: string; status: string; askId: string | null; startedAt: number | null }[];
    return rows.map((card) => {
      const ask = card.askId ? asks.get(card.askId) : undefined;
      return {
        ...card,
        revision: ask?.revision ?? 0,
        askStatus: ask?.status ?? null,
        items: (ask?.doneItems ?? [])
          .filter(
            (item) => !item.removed && !item.decision && !item.kind && item.deliveredBy === card.id
          )
          .map((item) => ({
            id: item.id,
            state: item.state,
            verified:
              !!ask &&
              this.asks.revisionPolicy.matchesVerifiedDefinition(
                item,
                item.verifiedDefinitionHash ?? null
              ) &&
              eligible(ask, item),
          })),
      };
    });
  }

  waiting(eligible?: Eligibility) {
    return this.db.transaction(() => {
      const cards = this.cards(eligible);
      const edges = this.edges();
      const proposed = new Set(cards.filter((card) => card.status === 'proposed').map((c) => c.id));
      return new Map(
        [...new Set(edges.map((edge) => edge.workId))]
          .filter((id) => proposed.has(id))
          .map((id) => [
            id,
            this.policy.blockers(id, cards, edges).filter((blocker) => blocker.workId !== id),
          ])
          .filter(([, blockers]) => blockers.length) as [
          string,
          ReturnType<typeof this.policy.blockers>,
        ][]
      );
    })();
  }

  blockers(workId: string, eligible?: Eligibility) {
    return this.db.transaction(() =>
      this.policy.blockers(workId, this.cards(eligible), this.edges())
    )();
  }

  replace(
    input: { workId: string; dependsOn: readonly string[]; expectedRevision: number },
    visible: ReadonlySet<string>,
    at: number
  ): { ok: boolean; reason?: string; revision?: number } {
    const replace = (superpipe({})('neo-dependency-edit') as PipelineAPI)
      .input(['input', 'visible'])
      .pipe(() => this.cards(), 'input', 'cards')
      .pipe(() => this.edges(), 'input', 'edges')
      .pipe(this.policy.requireEdit, ['input', 'cards', 'edges', 'visible'], 'result:edit')
      .pipe(
        (plan: {
          askId: string;
          dependsOn: string[];
          revision: number;
          invalidateApproval: boolean;
        }) => {
          if (plan.invalidateApproval) {
            this.db
              .prepare('DELETE FROM neo_work_dependencies WHERE work_id = ?')
              .run(input.workId);
            const insert = this.db.prepare(
              'INSERT INTO neo_work_dependencies(work_id, prerequisite_id) VALUES (?, ?)'
            );
            for (const id of plan.dependsOn) insert.run(input.workId, id);
            this.db
              .prepare(`UPDATE legacy_neo_asks SET revision = ?, approved_at = NULL,
            approved_revision = NULL, updated_at = ? WHERE id = ?`)
              .run(plan.revision, at, plan.askId);
          }
          return { ok: true, revision: plan.revision, changed: plan.invalidateApproval };
        },
        'edit',
        'edit'
      )
      .end('edit') as (
      input: unknown,
      visible: ReadonlySet<string>
    ) => { ok: boolean; reason?: string; revision?: number; changed?: boolean };
    const { changed, ...result } = this.db.transaction(() => replace(input, visible))();
    if (changed) this.notify();
    return result;
  }
}
