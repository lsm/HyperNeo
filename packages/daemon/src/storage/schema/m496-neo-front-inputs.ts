import type { Database } from '../sqlite-compat.ts';

export function runMigration496(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_front_inputs (
    conversation_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
    owner TEXT CHECK (owner IN ('front', 'neo')),
    catch_up_from INTEGER,
    catch_up_through INTEGER,
    PRIMARY KEY (conversation_id, message_id)
  )`);
}
