import type { WorkRef, WorkTurnFact } from '../../lib/drivers/types.ts';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';

const storedRef = ({ adapter, daemon, id }: WorkRef) =>
  JSON.stringify({ adapter, id, ...(daemon ? { daemon } : {}) });

const urlKey = (url: string) => url.toLowerCase().replace(/^https?:\/\//, '');

export const recordWorkTurns = defineDbOp({
  name: 'work.turn.record',
  mode: 'write',
  run: (db: Database, { ref, turns }: { ref: WorkRef; turns: readonly WorkTurnFact[] }): void => {
    const write = db.prepare(`INSERT OR REPLACE INTO work_turns
      (ref, id, started_at, ended_at, ended, inputs, urls, final_urls, complete, cursor)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const index = db.prepare(
      'INSERT OR IGNORE INTO work_turn_urls (url, ref, turn_id) VALUES (?, ?, ?)'
    );
    for (const turn of turns) {
      for (const url of turn.urls) index.run(urlKey(url), storedRef(ref), turn.id);
      write.run(
        storedRef(ref),
        turn.id,
        turn.startedAt,
        turn.endedAt,
        turn.ended,
        JSON.stringify(turn.inputs),
        JSON.stringify(turn.urls),
        JSON.stringify(turn.finalUrls),
        Number(turn.complete),
        turn.cursor
      );
    }
  },
});

type TurnRow = Omit<WorkTurnFact, 'inputs' | 'urls' | 'finalUrls' | 'complete'> & {
  inputs: string;
  urls: string;
  finalUrls: string;
  complete: number;
};

export type WorkTurnMention = WorkTurnFact & {
  ref: WorkRef;
  previous: Pick<WorkTurnFact, 'id' | 'ended' | 'inputs'> | null;
};

const TURN_COLUMNS = `id, started_at AS startedAt, ended_at AS endedAt, ended, inputs, urls,
  final_urls AS finalUrls, complete, cursor`;

const readTurnRow = (row: TurnRow): WorkTurnFact => ({
  ...row,
  inputs: JSON.parse(row.inputs),
  urls: JSON.parse(row.urls),
  finalUrls: JSON.parse(row.finalUrls),
  complete: !!row.complete,
});

export class WorkTurnRepository {
  constructor(private readonly db: Database) {}

  record(ref: WorkRef, turns: readonly WorkTurnFact[]): Promise<void> {
    return gatewayFor(this.db).run(recordWorkTurns, { ref, turns });
  }

  cursor(ref: WorkRef): string | null {
    const row = this.db
      .prepare('SELECT cursor FROM work_turns WHERE ref = ? ORDER BY ended_at DESC LIMIT 1')
      .get(storedRef(ref)) as { cursor: string } | null;
    return row?.cursor ?? null;
  }

  lastEndedAt(ref: WorkRef): number | null {
    const row = this.db
      .prepare('SELECT MAX(ended_at) AS endedAt FROM work_turns WHERE ref = ?')
      .get(storedRef(ref)) as { endedAt: number | null };
    return row.endedAt;
  }

  list(ref: WorkRef): WorkTurnFact[] {
    const rows = this.db
      .prepare(`SELECT ${TURN_COLUMNS} FROM work_turns WHERE ref = ? ORDER BY ended_at`)
      .all(storedRef(ref)) as TurnRow[];
    return rows.map(readTurnRow);
  }

  mentioning(prefixes: readonly string[]): WorkTurnMention[] {
    const find = this.db.prepare(`SELECT DISTINCT work_turns.ref AS ref, ${TURN_COLUMNS}
      FROM work_turn_urls JOIN work_turns
        ON work_turns.ref = work_turn_urls.ref AND work_turns.id = turn_id
      WHERE url >= ? AND url <= ?`);
    const before = this.db.prepare(`SELECT ${TURN_COLUMNS} FROM work_turns
      WHERE ref = ? AND ended_at < ? ORDER BY ended_at DESC LIMIT 1`);
    const found = prefixes
      .map(urlKey)
      .flatMap((prefix) => find.all(prefix, `${prefix}\uffff`) as (TurnRow & { ref: string })[]);
    const unique = new Map(found.map((row) => [`${row.ref}\n${row.id}`, row]));
    return [...unique.values()].map(({ ref, ...row }) => {
      const fact = readTurnRow(row);
      const previous = before.get(ref, fact.endedAt) as TurnRow | null;
      return {
        ...fact,
        ref: JSON.parse(ref) as WorkRef,
        previous: previous ? readTurnRow(previous) : null,
      };
    });
  }
}
