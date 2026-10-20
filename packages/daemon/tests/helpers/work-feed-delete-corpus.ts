import { createHash } from 'node:crypto';
import type { Database } from '../../src/storage/sqlite-compat.ts';

export function seedWorkFeedDeleteCorpus(db: Database, turns: number, bodyChars = 8192): void {
  const now = new Date().toISOString();
  const session = db.prepare(`INSERT INTO sessions
    (id, title, workspace_path, created_at, last_active_at, status, config, metadata, sdk_session_id)
    VALUES (?, ?, '/synthetic', ?, ?, 'active', '{}', '{}', ?)`);
  const message = db.prepare(`INSERT INTO sdk_messages
    (id, session_id, message_type, sdk_message, timestamp) VALUES (?, ?, 'user', ?, ?)`);
  const derived = db.prepare(`INSERT INTO message_search_content
    (kind, source_id, session_id, message_type, title, body, timestamp)
    VALUES (?, ?, ?, 'user', 'Synthetic transcript', ?, 1)`);
  const vector = db.prepare(`INSERT INTO message_search_vectors
    (content_id, model, dimensions, embedding, embedded_at) VALUES (?, 'synthetic', 4, ?, 1)`);
  db.transaction(() => {
    for (let i = 0; i < 100; i++)
      session.run(`stored-${i}`, `Synthetic ${i}`, now, now, `sdk-${i}`);
    for (let i = 0; i < turns; i++) {
      const body = Array.from({ length: 150 }, (_, word) => `synthetic${i}token${word}`)
        .join(' ')
        .repeat(8)
        .slice(0, bodyChars);
      const sdk = JSON.stringify({
        type: 'user',
        uuid: `m-${i}`,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `tool-${i}`, content: body }],
        },
        parent_tool_use_id: null,
      });
      message.run(`m-${i}`, `stored-${i % 100}`, sdk, now);
      const row = derived.run('claude', `duplicate-${i}`, `sdk-${i % 100}`, body);
      vector.run(row.lastInsertRowid, new Uint8Array(16));
      if (i % 10 === 0)
        derived.run('codex', `keep-${i}`, `sdk-${i % 100}`, `Keep codex result ${i}`);
    }
  })();
}

export function storedWorkFeedDigest(db: Database): string {
  const hash = createHash('sha256');
  for (const row of db.prepare('SELECT id, sdk_message FROM sdk_messages ORDER BY id').all() as {
    id: string;
    sdk_message: string;
  }[]) {
    hash.update(JSON.stringify([row.id, row.sdk_message]));
  }
  return hash.digest('hex');
}
