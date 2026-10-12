import type { Database } from '../sqlite-compat.ts';

const NEO_ASK_NEEDS_YOU_RESOLVED =
  'Moved back to pending: a decision now reaches the human only as neo.ask.question.';

export function runMigration354(db: Database, now = Date.now()): void {
  if (
    !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_ask_items' AND type = 'table'").get()
  )
    return;
  db.transaction(() => {
    db.prepare(`UPDATE neo_ask_items SET decision = 1, kind = COALESCE(kind, 'decision'),
        question = COALESCE(question,
          CASE WHEN kind = 'action' AND options IS NULL THEN 'Did it work?' ELSE text END),
        options = COALESCE(options, '["Yes","Not yet"]'), updated_at = ?
      WHERE state = 'needs_you' AND removed = 0 AND wait_card IS NULL
        AND (options IS NOT NULL OR kind = 'action')`).run(now);
    db.prepare(`UPDATE neo_ask_items SET state = 'pending', evidence = ?, met_by = NULL,
        decision = 0, options = NULL, action = NULL, wait_card = NULL, kind = NULL,
        question = NULL, updated_at = ?
      WHERE state = 'needs_you' AND (removed = 1 OR options IS NULL OR wait_card IS NOT NULL)`).run(
      NEO_ASK_NEEDS_YOU_RESOLVED,
      now
    );
    const stranded = `status IN ('waiting', 'blocked') AND EXISTS (SELECT 1 FROM neo_ask_items i
        WHERE i.ask_id = neo_asks.id AND i.id = neo_asks.waiting_item AND i.evidence = ?)`;
    const asked = `(SELECT i.id FROM neo_ask_items i WHERE i.ask_id = neo_asks.id
        AND i.state = 'needs_you' AND i.removed = 0 ORDER BY i.position LIMIT 1)`;
    db.prepare(`UPDATE neo_asks SET waiting_item = ${asked}, updated_at = ?
      WHERE ${stranded} AND ${asked} IS NOT NULL`).run(now, NEO_ASK_NEEDS_YOU_RESOLVED);
    db.prepare(`UPDATE neo_asks SET status = 'open', outcome = NULL, settled_at = NULL,
        waiting_item = NULL, updated_at = ?
      WHERE ${stranded}`).run(now, NEO_ASK_NEEDS_YOU_RESOLVED);
  })();
}
