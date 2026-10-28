import type { Database } from '../sqlite-compat.ts';

export function reserveNeoConversation(db: Database, id: string, now: number): void {
  db.prepare(
    'INSERT OR IGNORE INTO neo_conversation (singleton, id, created_at) VALUES (1, ?, ?)'
  ).run(id, now);
}
