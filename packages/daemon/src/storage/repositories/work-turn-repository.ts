import type { WorkRef, WorkTurnFact } from '../../lib/drivers/types.ts';
import { gatewayFor } from '../db-gateway/db-gateway.ts';
import { defineDbOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';

const storedRef = ({ adapter, daemon, id }: WorkRef) =>
  JSON.stringify({ adapter, id, ...(daemon ? { daemon } : {}) });

export const recordWorkTurns = defineDbOp({
  name: 'work.turn.record',
  mode: 'write',
  run: (db: Database, { ref, turns }: { ref: WorkRef; turns: readonly WorkTurnFact[] }): void => {
    const write = db.prepare(`INSERT OR REPLACE INTO work_turns
      (ref, id, started_at, ended_at, ended, inputs, urls, complete, cursor)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const turn of turns)
      write.run(
        storedRef(ref),
        turn.id,
        turn.startedAt,
        turn.endedAt,
        turn.ended,
        JSON.stringify(turn.inputs),
        JSON.stringify(turn.urls),
        Number(turn.complete),
        turn.cursor
      );
  },
});

type TurnRow = Omit<WorkTurnFact, 'inputs' | 'urls' | 'complete'> & {
  inputs: string;
  urls: string;
  complete: number;
};

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

  list(ref: WorkRef): WorkTurnFact[] {
    const rows = this.db
      .prepare(`SELECT id, started_at AS startedAt, ended_at AS endedAt, ended, inputs, urls,
        complete, cursor FROM work_turns WHERE ref = ? ORDER BY ended_at`)
      .all(storedRef(ref)) as TurnRow[];
    return rows.map((row) => ({
      ...row,
      inputs: JSON.parse(row.inputs),
      urls: JSON.parse(row.urls),
      complete: !!row.complete,
    }));
  }
}
