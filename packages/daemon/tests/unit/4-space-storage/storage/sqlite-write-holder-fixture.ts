import { Database } from 'bun:sqlite';

declare const self: Worker;

self.onmessage = (event: MessageEvent<{ path: string; holdMs: number }>) => {
  const db = new Database(event.data.path);
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('BEGIN IMMEDIATE');
  db.exec("UPDATE neo_asks SET updated_at = updated_at + 1 WHERE id = 'ask'");
  postMessage('held');
  const until = Date.now() + event.data.holdMs;
  while (Date.now() < until) {}
  db.exec('COMMIT');
  db.close();
  postMessage('released');
};
