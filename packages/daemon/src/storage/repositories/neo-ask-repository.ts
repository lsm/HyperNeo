import type { NeoAsk } from '@hyperneo/shared/types/neo-snapshot';
import type { Database } from '../sqlite-compat.ts';

const askColumns = `id, request_key AS requestKey, concern_id AS concernId,
  origin_session_id AS originSessionId, origin_message_id AS originMessageId,
  title, ask, done_when AS doneWhen, done_source AS doneSource, status, outcome,
  created_at AS createdAt, updated_at AS updatedAt, settled_at AS settledAt`;

type NeoAskRow = Omit<NeoAsk, 'workIds'>;
export type NeoAskInput = Omit<
  NeoAsk,
  'workIds' | 'status' | 'outcome' | 'createdAt' | 'updatedAt' | 'settledAt'
>;

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

  open(input: NeoAskInput): NeoAsk | null {
    if (!this.hasTable()) return null;
    const now = Date.now();
    const result = this.db
      .prepare(`INSERT INTO neo_asks
        (id, request_key, concern_id, origin_session_id, origin_message_id, title, ask,
          done_when, done_source, status, outcome, created_at, updated_at, settled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', NULL, ?, ?, NULL)
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
        now,
        now
      );
    if (result.changes > 0) this.notify();
    const row = this.db
      .prepare(`SELECT ${askColumns} FROM neo_asks WHERE request_key = ?`)
      .get(input.requestKey) as NeoAskRow;
    return this.withWork([row])[0];
  }

  get(id: string): NeoAsk | null {
    if (!this.hasTable()) return null;
    const row = this.db.prepare(`SELECT ${askColumns} FROM neo_asks WHERE id = ?`).get(id) as
      | NeoAskRow
      | undefined;
    return row ? this.withWork([row])[0] : null;
  }

  list(concernId?: string | null): NeoAsk[] {
    if (!this.hasTable()) return [];
    const condition = concernId === undefined ? '' : 'WHERE concern_id IS ?';
    const rows = this.db
      .prepare(`SELECT ${askColumns} FROM neo_asks ${condition} ORDER BY updated_at DESC, id`)
      .all(...(concernId === undefined ? [] : [concernId])) as NeoAskRow[];
    return this.withWork(rows);
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
      this.db.prepare('UPDATE neo_asks SET updated_at = ? WHERE id = ?').run(Date.now(), askId);
      return true;
    })();
    if (linked) this.notify();
    const owner = this.db
      .prepare('SELECT ask_id AS askId FROM neo_ask_work WHERE work_id = ?')
      .get(workId) as { askId: string } | undefined;
    return owner?.askId ?? null;
  }

  private withWork(rows: NeoAskRow[]): NeoAsk[] {
    if (rows.length === 0) return [];
    const links = this.db
      .prepare(`SELECT l.ask_id AS askId, l.work_id AS workId FROM neo_ask_work l
        JOIN neo_work w ON w.id = l.work_id
        WHERE l.ask_id IN (SELECT value FROM json_each(?))
        ORDER BY w.created_at, w.id`)
      .all(JSON.stringify(rows.map((row) => row.id))) as { askId: string; workId: string }[];
    return rows.map((row) => ({
      ...row,
      workIds: links.filter((link) => link.askId === row.id).map((link) => link.workId),
    }));
  }
}
