import type { NeoAsk, NeoAskItem, NeoAskStatus } from '@hyperneo/shared/types/neo-snapshot';
import type { Database } from '../sqlite-compat.ts';

const askColumns = `id, request_key AS requestKey, concern_id AS concernId,
  origin_session_id AS originSessionId, origin_message_id AS originMessageId,
  title, ask, done_when AS doneWhen, done_source AS doneSource`;

type NeoAskRow = Omit<NeoAsk, 'workIds' | 'doneItems'>;
export type NeoAskInput = Omit<
  NeoAsk,
  | 'workIds'
  | 'doneItems'
  | 'status'
  | 'outcome'
  | 'evidence'
  | 'createdAt'
  | 'updatedAt'
  | 'settledAt'
>;
export type NeoAskItemInput = Pick<NeoAskItem, 'text' | 'check'>;
type NeoAskItemRow = Omit<NeoAskItem, 'removed'> & { askId: string; removed: number };

const itemColumns = `ask_id AS askId, id, text, state, evidence, check_kind AS "check",
  met_by AS metBy, removed, added_at AS addedAt`;

export class NeoAskRepository {
  constructor(
    private readonly db: Database,
    private readonly notify: () => void = () => {}
  ) {}

  private hasTable(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_ask_work' AND type = 'table'")
      .get();
  }

  private hasColumn(name: string): boolean {
    return (this.db.prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[]).some(
      (column) => column.name === name
    );
  }

  private hasPack(): boolean {
    return this.hasColumn('pack');
  }

  private askColumns(): string {
    return `${askColumns}${this.hasPack() ? ', pack' : ''}${this.hasColumn('approved_at') ? ', approved_at AS approvedAt' : ''}, status, outcome, evidence,
  created_at AS createdAt, updated_at AS updatedAt, settled_at AS settledAt`;
  }

  private hasItems(): boolean {
    return !!this.db
      .prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_ask_items' AND type = 'table'")
      .get();
  }

  open(input: NeoAskInput, items: readonly NeoAskItemInput[] = []): NeoAsk | null {
    if (!this.hasTable()) return null;
    const now = Date.now();
    const created = this.db.transaction(() => {
      const opened = this.insertAsk(input, now);
      if (opened && this.hasItems()) {
        const insert = this.db.prepare(`INSERT INTO neo_ask_items
          (ask_id, id, position, text, state, check_kind, updated_at)
          VALUES (?, ?, ?, ?, 'pending', ?, ?)`);
        items.forEach((item, index) =>
          insert.run(input.id, `i${index + 1}`, index, item.text, item.check, now)
        );
      }
      return opened;
    })();
    if (created) this.notify();
    const row = this.db
      .prepare(`SELECT ${this.askColumns()} FROM neo_asks WHERE request_key = ?`)
      .get(input.requestKey) as NeoAskRow;
    return this.withWork([row])[0];
  }

  private insertAsk(input: NeoAskInput, now: number): boolean {
    const pack = this.hasPack();
    const result = this.db
      .prepare(`INSERT INTO neo_asks
        (id, request_key, concern_id, origin_session_id, origin_message_id, title, ask,
          done_when, done_source${pack ? ', pack' : ''}, status, outcome, created_at, updated_at, settled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?${pack ? ', ?' : ''}, 'open', NULL, ?, ?, NULL)
        ON CONFLICT(request_key) DO NOTHING`)
      .run(
        input.id,
        input.requestKey,
        input.concernId,
        input.originSessionId,
        input.originMessageId,
        input.title,
        input.ask,
        input.doneWhen,
        input.doneSource,
        ...(pack ? [input.pack ?? null] : []),
        now,
        now
      );
    return result.changes > 0;
  }

  get(id: string): NeoAsk | null {
    if (!this.hasTable()) return null;
    const row = this.db.prepare(`SELECT ${this.askColumns()} FROM neo_asks WHERE id = ?`).get(id) as
      | NeoAskRow
      | undefined;
    return row ? this.withWork([row])[0] : null;
  }

  forWork(workId: string): NeoAsk | null {
    if (!this.hasTable()) return null;
    const link = this.db
      .prepare('SELECT ask_id AS askId FROM neo_ask_work WHERE work_id = ?')
      .get(workId) as { askId: string } | undefined;
    return link ? this.get(link.askId) : null;
  }

  listLive(): NeoAsk[] {
    if (!this.hasTable()) return [];
    const rows = this.db
      .prepare(
        `SELECT ${this.askColumns()} FROM neo_asks WHERE status NOT IN ('achieved', 'abandoned')
          ORDER BY updated_at DESC, id`
      )
      .all() as NeoAskRow[];
    return this.withWork(rows);
  }

  list(concernId?: string | null): NeoAsk[] {
    if (!this.hasTable()) return [];
    const condition = concernId === undefined ? '' : 'WHERE concern_id IS ?';
    const rows = this.db
      .prepare(
        `SELECT ${this.askColumns()} FROM neo_asks ${condition} ORDER BY updated_at DESC, id`
      )
      .all(...(concernId === undefined ? [] : [concernId])) as NeoAskRow[];
    return this.withWork(rows);
  }

  tickItem(
    askId: string,
    item: Pick<NeoAskItem, 'id' | 'state' | 'evidence' | 'metBy'>,
    at: number
  ): boolean {
    if (!this.hasItems()) return false;
    const changed = this.db.transaction(() => {
      const ticked = this.db
        .prepare(`UPDATE neo_ask_items SET state = ?, evidence = ?, met_by = ?, updated_at = ?
          WHERE ask_id = ? AND id = ? AND removed = 0`)
        .run(item.state, item.evidence, item.metBy, at, askId, item.id).changes;
      if (ticked) this.db.prepare('UPDATE neo_asks SET updated_at = ? WHERE id = ?').run(at, askId);
      return ticked > 0;
    })();
    if (changed) this.notify();
    return changed;
  }

  editItems(
    askId: string,
    edit: { add: (NeoAskItemInput & { id: string; position: number })[]; remove: string[] },
    at: number
  ): boolean {
    if (!this.hasItems()) return false;
    this.db.transaction(() => {
      const insert = this.db.prepare(`INSERT INTO neo_ask_items
        (ask_id, id, position, text, state, check_kind, added_at, updated_at)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`);
      for (const item of edit.add)
        insert.run(askId, item.id, item.position, item.text, item.check, at, at);
      this.db
        .prepare(`UPDATE neo_ask_items SET removed = 1, updated_at = ?
          WHERE ask_id = ? AND id IN (SELECT value FROM json_each(?))`)
        .run(at, askId, JSON.stringify(edit.remove));
      this.db.prepare('UPDATE neo_asks SET updated_at = ? WHERE id = ?').run(at, askId);
    })();
    this.notify();
    return true;
  }

  reopen(expected: Pick<NeoAsk, 'id' | 'status'>): NeoAsk | null {
    const row = this.db
      .prepare(`UPDATE neo_asks SET status = 'open', outcome = NULL, settled_at = NULL,
        updated_at = ? WHERE id = ? AND status = ? RETURNING ${this.askColumns()}`)
      .get(Date.now(), expected.id, expected.status) as NeoAskRow | null;
    if (!row) return null;
    this.notify();
    return this.withWork([row])[0];
  }

  reopenForWork(workId: string): void {
    if (!this.hasTable()) return;
    const reopened = this.db
      .prepare(`UPDATE neo_asks SET status = 'open', settled_at = NULL, updated_at = ?
        WHERE status IN ('waiting', 'blocked')
          AND id = (SELECT ask_id FROM neo_ask_work WHERE work_id = ?)`)
      .run(Date.now(), workId);
    if (reopened.changes > 0) this.notify();
  }

  link(askId: string, workId: string): string | null {
    if (!this.hasTable()) return null;
    const linked = this.db.transaction(() => {
      const added = this.db
        .prepare(
          'INSERT INTO neo_ask_work(work_id, ask_id) VALUES (?, ?) ON CONFLICT(work_id) DO NOTHING'
        )
        .run(workId, askId);
      if (added.changes === 0) return false;
      this.db
        .prepare(`UPDATE neo_asks SET updated_at = ?,
          status = CASE WHEN status IN ('waiting', 'blocked') THEN 'open' ELSE status END,
          settled_at = CASE WHEN status IN ('waiting', 'blocked') THEN NULL ELSE settled_at END
          WHERE id = ?`)
        .run(Date.now(), askId);
      return true;
    })();
    if (linked) this.notify();
    const owner = this.db
      .prepare('SELECT ask_id AS askId FROM neo_ask_work WHERE work_id = ?')
      .get(workId) as { askId: string } | undefined;
    return owner?.askId ?? null;
  }

  approve(id: string, at: number): NeoAsk | null {
    if (!this.hasTable() || !this.hasColumn('approved_at')) return null;
    const row = this.db
      .prepare(`UPDATE neo_asks SET approved_at = COALESCE(approved_at, ?), updated_at = ?
        WHERE id = ? AND status NOT IN ('achieved', 'abandoned') RETURNING ${this.askColumns()}`)
      .get(at, at, id) as NeoAskRow | null;
    if (!row) return null;
    this.notify();
    return this.withWork([row])[0];
  }

  settle(
    expected: Pick<NeoAsk, 'id' | 'status'>,
    status: Exclude<NeoAskStatus, 'open'>,
    outcome: string,
    evidence: string
  ): NeoAsk | null {
    const now = Date.now();
    const row = this.db
      .prepare(`UPDATE neo_asks SET status = ?, outcome = ?, evidence = ?, updated_at = ?,
        settled_at = ? WHERE id = ? AND status = ? RETURNING ${this.askColumns()}`)
      .get(status, outcome, evidence, now, now, expected.id, expected.status) as NeoAskRow | null;
    if (!row) return null;
    this.notify();
    return this.withWork([row])[0];
  }

  waitingFor(sessionId: string): (NeoAsk & { remindedAt: number | null })[] {
    if (!this.hasTable() || !this.hasReminders()) return [];
    const rows = this.db
      .prepare(`SELECT ${this.askColumns()}, reminded_at AS remindedAt FROM neo_asks
        WHERE origin_session_id = ? AND status IN ('waiting', 'blocked') ORDER BY updated_at, id`)
      .all(sessionId) as (NeoAskRow & { remindedAt: number | null })[];
    return this.withWork(rows) as (NeoAsk & { remindedAt: number | null })[];
  }

  markReminded(ids: readonly string[], at: number): void {
    if (!ids.length || !this.hasReminders()) return;
    this.db
      .prepare('UPDATE neo_asks SET reminded_at = ? WHERE id IN (SELECT value FROM json_each(?))')
      .run(at, JSON.stringify(ids));
  }

  private hasReminders(): boolean {
    return (this.db.prepare('PRAGMA table_info(neo_asks)').all() as { name: string }[]).some(
      (column) => column.name === 'reminded_at'
    );
  }

  private withWork(rows: NeoAskRow[]): NeoAsk[] {
    if (rows.length === 0) return [];
    const links = this.db
      .prepare(`SELECT l.ask_id AS askId, l.work_id AS workId FROM neo_ask_work l
        JOIN neo_work w ON w.id = l.work_id
        WHERE l.ask_id IN (SELECT value FROM json_each(?))
        ORDER BY w.created_at, w.id`)
      .all(JSON.stringify(rows.map((row) => row.id))) as { askId: string; workId: string }[];
    const items = this.hasItems()
      ? (this.db
          .prepare(`SELECT ${itemColumns} FROM neo_ask_items
            WHERE ask_id IN (SELECT value FROM json_each(?)) ORDER BY position`)
          .all(JSON.stringify(rows.map((row) => row.id))) as NeoAskItemRow[])
      : [];
    return rows.map((row) => ({
      ...row,
      workIds: links.filter((link) => link.askId === row.id).map((link) => link.workId),
      doneItems: items
        .filter((item) => item.askId === row.id)
        .map(({ askId: _askId, removed, ...item }) => ({ ...item, removed: removed === 1 })),
    }));
  }
}
