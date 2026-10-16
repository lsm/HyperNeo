import superpipe, { type PipelineAPI } from 'superpipe';
import { neoOutcomeBindingPolicy } from '../../lib/neo/outcome-binding-policy.ts';
import {
  NEO_ASK_CONTINUE_WINDOW_MS,
  type NeoAsk,
  type NeoAskItem,
  type NeoAskQuestionBecause,
  type NeoAskStatus,
} from '@hyperneo/shared/types/neo-snapshot';
import type { Database } from '../sqlite-compat.ts';
import { neoAskRevisionPolicy } from '../../lib/neo/ask-revision-policy.ts';

const askColumns = `id, request_key AS requestKey, concern_id AS projectId,
  origin_session_id AS originSessionId, origin_message_id AS originMessageId,
  revision, approved_revision AS approvedRevision,
  title, ask, done_when AS doneWhen, done_source AS doneSource, pack, approved_at AS approvedAt,
  approved_continues AS approvedContinues, waiting_item AS waitingItem, refused, refused_count AS refusedCount, status, outcome, evidence,
  created_at AS createdAt, updated_at AS updatedAt, settled_at AS settledAt`;

const REOPEN = "status = 'open', outcome = NULL, settled_at = NULL, waiting_item = NULL";
const REOPENABLE = "status IN ('waiting', 'blocked')";
type NeoAskRow = Omit<NeoAsk, 'workIds' | 'doneItems'>;
export type NeoAskInput = Omit<
  NeoAsk,
  | 'revision'
  | 'approvedRevision'
  | 'workIds'
  | 'doneItems'
  | 'status'
  | 'outcome'
  | 'evidence'
  | 'createdAt'
  | 'updatedAt'
  | 'settledAt'
>;
export type NeoAskItemInput = Pick<NeoAskItem, 'text' | 'check' | 'watch' | 'deliveredBy'> &
  Partial<Pick<NeoAskItem, 'outcomeKind'>>;
type NeoAskItemRow = Omit<
  NeoAskItem,
  | 'removed'
  | 'removedReason'
  | 'options'
  | 'decision'
  | 'action'
  | 'waitCard'
  | 'kind'
  | 'question'
  | 'decides'
  | 'because'
  | 'watch'
  | 'outcomeKind'
> & {
  askId: string;
  removed: number;
  removedReason: string | null;
  options: string | null;
  decision: number;
  action: string | null;
  waitCard: string | null;
  kind: NeoAskItem['kind'] | null;
  question: string | null;
  decides: string | null;
  because: string | null;
  watch: string | null;
  outcomeKind: NonNullable<NeoAskItem['outcomeKind']>;
};

const watchJson = (item: Pick<NeoAskItem, 'watch'>) =>
  item.watch?.length ? JSON.stringify(item.watch) : null;

const itemColumns = `ask_id AS askId, id, text, state, evidence, check_kind AS "check",
  delivered_by AS deliveredBy, verified_definition_hash AS verifiedDefinitionHash, met_by AS metBy, removed, removed_reason AS removedReason, added_at AS addedAt, options, decision, action, wait_card AS waitCard, kind, question, decides, because, watch, outcome_kind AS outcomeKind`;

export interface NeoAskOwner {
  projectId: string;
  originSessionId: string;
  originMessageId: string;
}

export class NeoAskBindingError extends Error {}

export class NeoAskRepository {
  readonly revisionPolicy = neoAskRevisionPolicy;
  readonly bindingPolicy = neoOutcomeBindingPolicy;
  constructor(
    private readonly db: Database,
    private readonly notify: () => void = () => {},
    private readonly outcomeVerified: (cardId: string) => void = () => {}
  ) {}

  open(input: NeoAskInput, items: readonly NeoAskItemInput[] = []): NeoAsk | null {
    const now = Date.now();
    const created = this.db.transaction(() => {
      const opened = this.insertAsk(input, now);
      if (opened) {
        const insert = this.db.prepare(`INSERT INTO neo_ask_items
          (ask_id, id, position, text, state, check_kind, watch, outcome_kind, updated_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`);
        items.forEach((item, index) =>
          insert.run(
            input.id,
            `i${index + 1}`,
            index,
            item.text,
            item.check,
            watchJson(item),
            item.outcomeKind ?? 'state',
            now
          )
        );
      }
      if (opened) {
        const bindings = items.flatMap((item, index) =>
          item.deliveredBy ? [{ itemId: `i${index + 1}`, deliveredBy: item.deliveredBy }] : []
        );
        for (const id of new Set(bindings.map((binding) => binding.deliveredBy))) {
          const owned = this.db
            .prepare(`SELECT w.id FROM neo_work w
            LEFT JOIN neo_ask_work a ON a.work_id = w.id
            WHERE w.id = ? AND w.origin_session_id = ? AND w.concern_id IS ? AND a.ask_id IS NULL`)
            .get(id, input.originSessionId, input.projectId);
          if (!owned) throw new NeoAskBindingError('binding_card_not_owned');
          this.db
            .prepare('INSERT INTO neo_ask_work(work_id, ask_id) VALUES (?, ?)')
            .run(id, input.id);
        }
        if (bindings.length) this.bindOrThrow(input.id, bindings, 0, now);
      }
      return opened;
    })();
    if (created) this.notify();
    const row = this.db
      .prepare(`SELECT ${askColumns} FROM neo_asks WHERE request_key = ?`)
      .get(input.requestKey) as NeoAskRow;
    return this.withWork([row])[0];
  }

  private insertAsk(input: NeoAskInput, now: number): boolean {
    const result = this.db
      .prepare(`INSERT INTO neo_asks
        (id, request_key, concern_id, origin_session_id, origin_message_id, title, ask,
          done_when, done_source, pack, status, outcome, created_at, updated_at, settled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, NULL)
        ON CONFLICT(request_key) DO NOTHING`)
      .run(
        input.id,
        input.requestKey,
        input.projectId,
        input.originSessionId,
        input.originMessageId,
        input.title,
        input.ask,
        input.doneWhen,
        input.doneSource,
        input.pack ?? null,
        now,
        now
      );
    return result.changes > 0;
  }

  get(id: string): NeoAsk | null {
    const row = this.db.prepare(`SELECT ${askColumns} FROM neo_asks WHERE id = ?`).get(id) as
      | NeoAskRow
      | undefined;
    return row ? this.withWork([row])[0] : null;
  }

  itemChanges(askId: string): { metAt: number; removedAt: number } {
    return this.db
      .prepare(
        `SELECT COALESCE(MAX(CASE WHEN removed = 0 AND state = 'met' THEN updated_at END), 0) AS metAt,
          COALESCE(MAX(CASE WHEN removed = 1 AND decision = 0 THEN updated_at END), 0) AS removedAt
          FROM neo_ask_items WHERE ask_id = ?`
      )
      .get(askId) as { metAt: number; removedAt: number };
  }

  forRequest(requestKey: string): NeoAsk | null {
    const row = this.db.prepare('SELECT id FROM neo_asks WHERE request_key = ?').get(requestKey) as
      | { id: string }
      | undefined;
    return row ? this.get(row.id) : null;
  }

  forWork(workId: string): NeoAsk | null {
    const link = this.db
      .prepare('SELECT ask_id AS askId FROM neo_ask_work WHERE work_id = ?')
      .get(workId) as { askId: string } | undefined;
    return link ? this.get(link.askId) : null;
  }

  liveForOrigin(originSessionId: string, originMessageId: string): NeoAsk | null {
    const row = this.db
      .prepare(
        `SELECT ${askColumns} FROM neo_asks
          WHERE origin_session_id = ? AND origin_message_id = ?
            AND status NOT IN ('achieved', 'abandoned')
          ORDER BY created_at LIMIT 1`
      )
      .get(originSessionId, originMessageId) as NeoAskRow | null;
    return row ? this.withWork([row])[0] : null;
  }

  openedBy(originSessionId: string, since: number, until: number): NeoAsk[] {
    const rows = this.db
      .prepare(
        `SELECT ${askColumns} FROM neo_asks
          WHERE origin_session_id = ? AND created_at > ? AND created_at <= ?
          ORDER BY created_at, id`
      )
      .all(originSessionId, since, until) as NeoAskRow[];
    return this.withWork(rows);
  }

  listLive(): NeoAsk[] {
    const rows = this.db
      .prepare(
        `SELECT ${askColumns} FROM neo_asks WHERE status NOT IN ('achieved', 'abandoned')
          ORDER BY updated_at DESC, id`
      )
      .all() as NeoAskRow[];
    return this.withWork(rows);
  }

  achievedSince(since: number): NeoAsk[] {
    const rows = this.db
      .prepare(
        `SELECT ${askColumns} FROM neo_asks WHERE status = 'achieved' AND settled_at > ?
          ORDER BY settled_at DESC, id`
      )
      .all(since) as NeoAskRow[];
    return this.withWork(rows);
  }

  list(projectId?: string | null): NeoAsk[] {
    const condition = projectId === undefined ? '' : 'WHERE concern_id IS ?';
    const rows = this.db
      .prepare(`SELECT ${askColumns} FROM neo_asks ${condition} ORDER BY updated_at DESC, id`)
      .all(...(projectId === undefined ? [] : [projectId])) as NeoAskRow[];
    return this.withWork(rows);
  }

  tickItem(
    askId: string,
    item: Pick<
      NeoAskItem,
      | 'id'
      | 'state'
      | 'evidence'
      | 'metBy'
      | 'options'
      | 'action'
      | 'waitCard'
      | 'kind'
      | 'question'
    >,
    at: number,
    expected?: Pick<NeoAskItem, 'text' | 'check' | 'watch' | 'deliveredBy'>,
    verify = false
  ): boolean {
    const changed = this.db.transaction(() => {
      const current = this.get(askId)?.doneItems?.find((entry) => entry.id === item.id);
      const hash = expected ? this.revisionPolicy.definitionHash(expected) : null;
      if (!current || (hash && hash !== this.revisionPolicy.definitionHash(current))) return false;
      if (expected && (expected.deliveredBy ?? null) !== (current.deliveredBy ?? null))
        return false;
      const verified =
        verify && item.state === 'met' && ['daemon', 'human'].includes(item.metBy ?? '');
      const ticked = this.db
        .prepare(`UPDATE neo_ask_items SET state = ?, evidence = ?, met_by = ?, options = ?, action = ?, wait_card = ?, kind = ?, question = ?,
          verified_definition_hash = ?, updated_at = ?
          WHERE ask_id = ? AND id = ? AND removed = 0`)
        .run(
          item.state,
          item.evidence,
          item.metBy,
          item.options?.length ? JSON.stringify(item.options) : null,
          item.action ?? null,
          item.waitCard ?? null,
          item.kind ?? null,
          item.question ?? null,
          verified ? hash : null,
          at,
          askId,
          item.id
        ).changes;
      if (ticked) this.db.prepare('UPDATE neo_asks SET updated_at = ? WHERE id = ?').run(at, askId);
      if (ticked && verified && current.deliveredBy) this.outcomeVerified(current.deliveredBy);
      return ticked > 0;
    })();
    if (changed) this.notify();
    return changed;
  }

  restateQuestion(
    askId: string,
    item: {
      id: string;
      text: string;
      question: string;
      kind: NeoAskItem['kind'];
      options: string[];
      decides: string;
      because?: NeoAskQuestionBecause | null;
    },
    at: number
  ): boolean {
    const changed = this.db.transaction(() => {
      const restated = this.db
        .prepare(`UPDATE neo_ask_items SET text = ?, question = ?, kind = ?, options = ?, decides = ?,
          because = ?, updated_at = ? WHERE ask_id = ? AND id = ? AND removed = 0 AND state = 'needs_you'`)
        .run(
          item.text,
          item.question,
          item.kind ?? 'decision',
          JSON.stringify(item.options),
          item.decides,
          item.because ? JSON.stringify(item.because) : null,
          at,
          askId,
          item.id
        ).changes;
      if (!restated) return false;
      this.db
        .prepare(`UPDATE neo_asks SET outcome = CASE WHEN waiting_item = ? THEN ? ELSE outcome END,
          evidence = CASE WHEN waiting_item = ? THEN ? ELSE evidence END, updated_at = ? WHERE id = ?`)
        .run(item.id, item.text, item.id, item.text, at, askId);
      return true;
    })();
    if (changed) this.notify();
    return changed;
  }

  editItems(
    askId: string,
    edit: {
      add: (NeoAskItemInput & { id: string; position: number })[];
      remove: string[];
      removedReason?: string | null;
      bind?: { itemId: string; deliveredBy: string | null }[];
      track?: { itemId: string; check: NeoAskItem['check']; watch?: string[] }[];
    },
    at: number,
    expectedRevision?: number
  ): boolean {
    const changed = this.db.transaction(() => {
      const before = this.get(askId);
      if (!before || (expectedRevision !== undefined && before.revision !== expectedRevision))
        return false;
      const track = this.db.prepare(`UPDATE neo_ask_items
        SET check_kind = COALESCE(?, check_kind), watch = COALESCE(?, watch), updated_at = ?
        WHERE ask_id = ? AND id = ? AND removed = 0`);
      for (const item of edit.track ?? [])
        track.run(item.check, watchJson(item), at, askId, item.itemId);
      const insert = this.db.prepare(`INSERT INTO neo_ask_items
        (ask_id, id, position, text, state, check_kind, watch, outcome_kind, added_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`);
      for (const item of edit.add)
        insert.run(
          askId,
          item.id,
          item.position,
          item.text,
          item.check,
          watchJson(item),
          item.outcomeKind ?? 'state',
          at,
          at
        );
      this.db
        .prepare(`UPDATE neo_ask_items SET removed = 1, removed_reason = ?, updated_at = ?
          WHERE ask_id = ? AND id IN (SELECT value FROM json_each(?))`)
        .run(edit.removedReason ?? null, at, askId, JSON.stringify(edit.remove));
      const bindings = [
        ...(edit.bind ?? []),
        ...edit.add.flatMap((item) =>
          item.deliveredBy === undefined ? [] : [{ itemId: item.id, deliveredBy: item.deliveredBy }]
        ),
      ];
      const fills = this.bindingPolicy.fillIds(before, bindings, this.bindingCards(askId));
      if (bindings.length) this.bindOrThrow(askId, bindings, before.revision ?? 0, at);
      const after = this.get(askId)!;
      const outcomes = (ask: NeoAsk) => (ask.doneItems ?? []).filter((item) => !item.decision);
      const filled = (ask: NeoAsk) =>
        outcomes(ask).map((item) =>
          fills.has(item.id)
            ? {
                ...item,
                deliveredBy: bindings.find((b) => b.itemId === item.id)?.deliveredBy ?? null,
              }
            : item
        );
      const plan = this.revisionPolicy.planRevision(
        before.revision ?? 0,
        { items: filled(before), cards: [] },
        { items: outcomes(after), cards: [] }
      );
      const changedBindings = (before.doneItems ?? [])
        .filter((item) => item.deliveredBy && plan.invalidateItemIds.includes(item.id))
        .map((item) => ({ itemId: item.id, deliveredBy: null }));
      if (changedBindings.length) {
        const writable = this.bindingPolicy.requireBindings(
          before,
          changedBindings,
          this.bindingCards(askId)
        );
        if ('reason' in writable) throw new NeoAskBindingError(writable.reason.reason);
      }
      if (plan.invalidateApproval) {
        this.db
          .prepare(`UPDATE neo_asks SET revision = ?, approved_at = NULL,
          approved_revision = NULL, updated_at = ? WHERE id = ?`)
          .run(plan.revision, at, askId);
        this.db
          .prepare(`UPDATE neo_ask_items SET state = 'pending', evidence = NULL,
          met_by = NULL, verified_definition_hash = NULL
          WHERE ask_id = ? AND id IN (SELECT value FROM json_each(?))`)
          .run(askId, JSON.stringify(plan.invalidateItemIds));
      }
      this.db.prepare('UPDATE neo_asks SET updated_at = ? WHERE id = ?').run(at, askId);
      return true;
    })();
    if (changed) this.notify();
    return changed;
  }

  private bindingCards(askId: string) {
    return this.db
      .prepare(`SELECT w.id,
      (w.status != 'proposed' OR d.started_at IS NOT NULL) AS dispatched,
      w.status IN ('failed', 'cancelled') AS released
      FROM neo_work w JOIN neo_ask_work a ON a.work_id = w.id
      LEFT JOIN neo_work_driver_targets d ON d.work_id = w.id WHERE a.ask_id = ?`)
      .all(askId)
      .map((row) => {
        const card = row as { id: string; dispatched: number; released: number };
        return { id: card.id, dispatched: !!card.dispatched, released: !!card.released };
      });
  }

  private bindOrThrow(
    askId: string,
    bindings: readonly { itemId: string; deliveredBy: string | null }[],
    revision: number,
    at: number
  ) {
    const result = this.bindItems(askId, bindings, revision, at, false);
    if (!result.ok) throw new NeoAskBindingError(result.reason);
  }

  bindItems(
    askId: string,
    bindings: readonly { itemId: string; deliveredBy: string | null }[],
    expectedRevision: number,
    at: number,
    notify = true
  ): { ok: boolean; reason?: string } {
    const bind = (superpipe({})('neo-ask-bindings') as PipelineAPI)
      .input(['askId'])
      .pipe((id: string) => this.get(id), 'askId', 'ask')
      .pipe(
        (ask: NeoAsk | null) =>
          ask?.revision === expectedRevision
            ? { value: ask }
            : { reason: { ok: false, reason: 'stale_ask_revision' } },
        'ask',
        'result:binding'
      )
      .pipe((ask: NeoAsk) => this.bindingCards(ask.id), 'binding', 'cards')
      .pipe(
        (ask: NeoAsk, cards: { id: string; dispatched: boolean }[]) =>
          this.bindingPolicy.requireBindings(ask, bindings, cards),
        ['binding', 'cards'],
        'result:binding'
      )
      .pipe(
        (plan: { invalidateApproval: boolean; revision: number; invalidateItemIds: string[] }) => {
          const fill = this.db.prepare(`UPDATE neo_ask_items SET delivered_by = ?, updated_at = ?
          WHERE ask_id = ? AND id = ?`);
          for (const binding of bindings)
            if (!plan.invalidateItemIds.includes(binding.itemId))
              fill.run(binding.deliveredBy, at, askId, binding.itemId);
          if (!plan.invalidateApproval) return { ok: true };
          const write =
            this.db.prepare(`UPDATE neo_ask_items SET delivered_by = ?, state = 'pending',
          evidence = NULL, met_by = NULL, verified_definition_hash = NULL, updated_at = ?
          WHERE ask_id = ? AND id = ?`);
          for (const binding of bindings)
            if (plan.invalidateItemIds.includes(binding.itemId))
              write.run(binding.deliveredBy, at, askId, binding.itemId);
          this.db
            .prepare(`UPDATE neo_asks SET revision = ?, approved_at = NULL,
          approved_revision = NULL, updated_at = ? WHERE id = ?`)
            .run(plan.revision, at, askId);
          return { ok: true };
        },
        'binding',
        'binding'
      )
      .end('binding') as (id: string) => { ok: boolean; reason?: string };
    const result = this.db.transaction(() => bind(askId))();
    if (result.ok && notify) this.notify();
    return result;
  }

  fold(
    source: Pick<NeoAsk, 'id' | 'status'>,
    target: Pick<NeoAsk, 'id' | 'status'>,
    moves: readonly { from: string; id: string; position: number }[],
    outcome: string,
    at: number,
    bindOutcomes = false
  ): boolean {
    const folded = this.db.transaction(() => {
      if (source.id === target.id || !this.get(source.id) || !this.get(target.id))
        throw new Error('neo-ask-fold-lost');
      const bindingPlan = bindOutcomes
        ? this.bindingPolicy.planFold(this.get(source.id)!, this.get(target.id)!, moves)
        : null;
      const closed = this.db
        .prepare(`UPDATE neo_asks SET status = 'abandoned', outcome = ?, evidence = ?,
          settled_at = ?, updated_at = ?, waiting_item = NULL WHERE id = ? AND status = ?`)
        .run(outcome, outcome, at, at, source.id, source.status).changes;
      const kept = this.db
        .prepare('UPDATE neo_asks SET updated_at = ? WHERE id = ? AND status = ?')
        .run(at, target.id, target.status).changes;
      if (!closed || !kept) throw new Error('neo-ask-fold-lost');
      const copy = this.db.prepare(`INSERT INTO neo_ask_items
        (ask_id, id, position, text, state, evidence, check_kind, met_by, removed, added_at,
         updated_at, options, decision, action, wait_card, kind, question, decides, because,
         outcome_kind)
        SELECT ?, ?, ?, text, state, evidence, check_kind, met_by, 0, ?, ?, options, decision,
               action, wait_card, kind, question, decides, because, outcome_kind
          FROM neo_ask_items WHERE ask_id = ? AND id = ?`);
      for (const move of moves)
        copy.run(target.id, move.id, move.position, at, at, source.id, move.from);
      this.db
        .prepare('UPDATE neo_ask_work SET ask_id = ? WHERE ask_id = ?')
        .run(target.id, source.id);
      if (bindingPlan) {
        const update = this.db.prepare(`UPDATE neo_ask_items SET delivered_by = ?, watch = ?,
          question = ?, state = ?, evidence = ?, met_by = ?, verified_definition_hash = ?
          WHERE ask_id = ? AND id = ?`);
        for (const item of bindingPlan.items)
          update.run(
            item.deliveredBy ?? null,
            watchJson(item),
            item.question ?? null,
            item.state,
            item.evidence,
            item.metBy,
            item.verifiedDefinitionHash ?? null,
            target.id,
            item.id
          );
        this.db
          .prepare(`UPDATE neo_asks SET revision = ?, approved_at = NULL,
          approved_revision = NULL, approved_continues = 0 WHERE id = ?`)
          .run(bindingPlan.revision, target.id);
      }
    });
    try {
      folded();
    } catch (error) {
      if (error instanceof Error && error.message === 'neo-ask-fold-lost') return false;
      throw error;
    }
    this.notify();
    return true;
  }

  reopen(expected: Pick<NeoAsk, 'id' | 'status'>): NeoAsk | null {
    const row = this.db
      .prepare(`UPDATE neo_asks SET ${REOPEN}, updated_at = ?
        WHERE id = ? AND status = ? RETURNING ${askColumns}`)
      .get(Date.now(), expected.id, expected.status) as NeoAskRow | null;
    if (!row) return null;
    this.notify();
    return this.withWork([row])[0];
  }

  moveTo(
    ask: Pick<NeoAsk, 'id' | 'projectId' | 'originSessionId'>,
    owner: NeoAskOwner
  ): NeoAsk | null {
    const row = this.db
      .prepare(`UPDATE neo_asks SET concern_id = ?, origin_session_id = ?, origin_message_id = ?
        WHERE id = ? AND concern_id IS ? AND origin_session_id = ?
          AND status IN ('open', 'waiting', 'blocked') RETURNING ${askColumns}`)
      .get(
        owner.projectId,
        owner.originSessionId,
        owner.originMessageId,
        ask.id,
        ask.projectId ?? null,
        ask.originSessionId
      ) as NeoAskRow | null;
    if (!row) return null;
    this.notify();
    return this.withWork([row])[0];
  }

  reopenForWork(workId: string): void {
    const reopened = this.db
      .prepare(`UPDATE neo_asks SET ${REOPEN}, updated_at = ?
        WHERE ${REOPENABLE} AND id = (SELECT ask_id FROM neo_ask_work WHERE work_id = ?)`)
      .run(Date.now(), workId);
    if (reopened.changes > 0) this.notify();
  }

  link(askId: string, workId: string): string | null {
    const linked = this.db.transaction(() => {
      const added = this.db
        .prepare(
          'INSERT INTO neo_ask_work(work_id, ask_id) VALUES (?, ?) ON CONFLICT(work_id) DO NOTHING'
        )
        .run(workId, askId);
      if (added.changes === 0) return false;
      const now = Date.now();
      this.db.prepare('UPDATE neo_asks SET updated_at = ? WHERE id = ?').run(now, askId);
      this.db.prepare(`UPDATE neo_asks SET ${REOPEN} WHERE id = ? AND ${REOPENABLE}`).run(askId);
      return true;
    })();
    if (linked) this.notify();
    const owner = this.db
      .prepare('SELECT ask_id AS askId FROM neo_ask_work WHERE work_id = ?')
      .get(workId) as { askId: string } | undefined;
    return owner?.askId ?? null;
  }

  approve(id: string, at: number, expectedRevision = 0): NeoAsk | null {
    const row = this.db.transaction(() => {
      const approved = this.db
        .prepare(`UPDATE neo_asks SET approved_at = ?, approved_revision = revision, approved_continues = 0, updated_at = ?
          WHERE id = ? AND revision = ? AND status NOT IN ('achieved', 'abandoned') RETURNING ${askColumns}`)
        .get(at, at, id, expectedRevision) as NeoAskRow | null;
      if (approved)
        this.db
          .prepare(`UPDATE neo_work_continues SET stalled = 0, progress = NULL
            WHERE work_id IN (SELECT work_id FROM neo_ask_work WHERE ask_id = ?)`)
          .run(id);
      return approved;
    })();
    if (!row) return null;
    this.notify();
    return this.withWork([row])[0];
  }

  reserveApprovedContinue(id: string): boolean {
    return (
      this.db
        .prepare(`UPDATE neo_asks SET approved_continues = approved_continues + 1
          WHERE id = ? AND approved_at IS NOT NULL`)
        .run(id).changes === 1
    );
  }

  refundApprovedContinue(id: string): void {
    this.db
      .prepare(
        'UPDATE neo_asks SET approved_continues = MAX(0, approved_continues - 1) WHERE id = ?'
      )
      .run(id);
  }

  settle(
    expected: Pick<NeoAsk, 'id' | 'status'>,
    status: Exclude<NeoAskStatus, 'open'>,
    outcome: string,
    evidence: string,
    waitingItem: string | null = null,
    decision: {
      id: string;
      position: number;
      text: string;
      action?: string;
      kind?: NeoAskItem['kind'];
      question?: string;
      decides?: string;
      because?: NeoAskQuestionBecause;
      options?: readonly string[];
    } | null = null,
    decided = false,
    dropped: string | null = null
  ): NeoAsk | null {
    const now = Date.now();
    const lost = new Error('neo-ask-settle-lost');
    const settle = this.db.transaction(() => {
      const settled = this.db
        .prepare(`UPDATE neo_asks SET status = ?, outcome = ?, evidence = ?, updated_at = ?,
          settled_at = ?, waiting_item = ? WHERE id = ? AND status = ?
          RETURNING ${askColumns}`)
        .get(
          status,
          outcome,
          evidence,
          now,
          now,
          waitingItem,
          expected.id,
          expected.status
        ) as NeoAskRow | null;
      if (
        settled &&
        decision &&
        this.db
          .prepare(`INSERT INTO neo_ask_items
            (ask_id, id, position, text, state, evidence, decision, action, kind, question, decides, because, options, added_at, updated_at)
            VALUES (?, ?, ?, ?, 'needs_you', ?, 1, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
          .run(
            expected.id,
            decision.id,
            decision.position,
            decision.text,
            evidence,
            decision.action ?? null,
            decision.kind ?? 'decision',
            decision.question ?? null,
            decision.decides ?? null,
            decision.because ? JSON.stringify(decision.because) : null,
            decision.options?.length ? JSON.stringify(decision.options) : null,
            now,
            now
          ).changes === 0
      )
        throw lost;
      if (settled && dropped !== null)
        this.db
          .prepare(`UPDATE neo_ask_items SET state = 'met', evidence = ?, met_by = 'human', updated_at = ?
            WHERE ask_id = ? AND state = 'needs_you' AND removed = 0`)
          .run(dropped, now, expected.id);
      if (settled && !decision && decided && waitingItem)
        this.db
          .prepare(`UPDATE neo_ask_items SET decision = 1, updated_at = ?
            WHERE ask_id = ? AND id = ? AND state = 'needs_you'`)
          .run(now, expected.id, waitingItem);
      return settled;
    });
    let row: NeoAskRow | null;
    try {
      row = settle();
    } catch (error) {
      if (error !== lost) throw error;
      return null;
    }
    if (!row) return null;
    this.notify();
    return this.withWork([row])[0];
  }

  waitingFor(sessionId: string): (NeoAsk & { remindedAt: number | null })[] {
    const rows = this.db
      .prepare(`SELECT ${askColumns}, reminded_at AS remindedAt FROM neo_asks
        WHERE origin_session_id = ? AND status IN ('waiting', 'blocked') ORDER BY updated_at, id`)
      .all(sessionId) as (NeoAskRow & { remindedAt: number | null })[];
    return this.withWork(rows) as (NeoAsk & { remindedAt: number | null })[];
  }

  needingHuman(): NeoAsk[] {
    const rows = this.db
      .prepare(`SELECT ${askColumns} FROM neo_asks a
        WHERE status IN ('open', 'waiting', 'blocked') AND EXISTS (SELECT 1 FROM neo_ask_items i
          WHERE i.ask_id = a.id AND i.state = 'needs_you' AND i.removed = 0)
        ORDER BY updated_at, id`)
      .all() as NeoAskRow[];
    return this.withWork(rows);
  }

  recordRefusal(id: string, refused: string | null): void {
    this.db
      .prepare(
        'UPDATE neo_asks SET refused = ?, refused_count = CASE WHEN ? IS NULL THEN 0 ELSE refused_count + 1 END WHERE id = ?'
      )
      .run(refused, refused, id);
  }

  markReminded(ids: readonly string[], at: number): void {
    if (!ids.length) return;
    this.db
      .prepare('UPDATE neo_asks SET reminded_at = ? WHERE id IN (SELECT value FROM json_each(?))')
      .run(at, JSON.stringify(ids));
  }

  private withWork(rows: NeoAskRow[]): NeoAsk[] {
    if (rows.length === 0) return [];
    const links = this.db
      .prepare(`SELECT l.ask_id AS askId, l.work_id AS workId FROM neo_ask_work l
        JOIN neo_work w ON w.id = l.work_id
        WHERE l.ask_id IN (SELECT value FROM json_each(?))
        ORDER BY w.created_at, w.id`)
      .all(JSON.stringify(rows.map((row) => row.id))) as { askId: string; workId: string }[];
    const items = this.db
      .prepare(`SELECT ${itemColumns} FROM neo_ask_items
        WHERE ask_id IN (SELECT value FROM json_each(?)) ORDER BY position`)
      .all(JSON.stringify(rows.map((row) => row.id))) as NeoAskItemRow[];
    return rows.map((row) => ({
      ...row,
      ...(row.approvedAt != null
        ? {
            approvedUntil: row.approvedAt + NEO_ASK_CONTINUE_WINDOW_MS,
          }
        : {}),
      workIds: links.filter((link) => link.askId === row.id).map((link) => link.workId),
      doneItems: items
        .filter((item) => item.askId === row.id)
        .map(
          ({
            askId: _askId,
            removed,
            removedReason,
            options,
            decision,
            action,
            waitCard,
            kind,
            question,
            decides,
            because,
            watch,
            outcomeKind,
            ...item
          }) => ({
            ...item,
            removed: removed === 1,
            ...(removedReason ? { removedReason } : {}),
            ...(options ? { options: JSON.parse(options) as string[] } : {}),
            ...(decision === 1 ? { decision: true as const } : {}),
            ...(action ? { action } : {}),
            ...(waitCard ? { waitCard } : {}),
            ...(kind ? { kind } : {}),
            ...(question ? { question } : {}),
            ...(decides ? { decides } : {}),
            ...(because ? { because: JSON.parse(because) as NeoAskQuestionBecause } : {}),
            ...(watch ? { watch: JSON.parse(watch) as string[] } : {}),
            ...(outcomeKind === 'answer' ? { outcomeKind } : {}),
          })
        ),
    }));
  }
}
