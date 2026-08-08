/**
 * recover-messages script — regression test for the interrupted-rerun path.
 *
 * `touchedSessions` must include EVERY matched session on every run, not just
 * sessions that inserted a new row this invocation. Otherwise a prior run that
 * inserted rows but exited before the recompute step leaves the counter stale,
 * and a rerun skips the session entirely (the existing-UUID `continue` fires
 * before it's tracked). Since `spaceSessions.bySpace` reads only the counter,
 * the badge stays stale for the recovered session.
 *
 * This test runs the script as a subprocess against a temp DB whose session
 * already has its (visible) messages inserted with a stale counter of 0 — i.e.
 * a rerun with no new inserts — and asserts the counter is repaired.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Database } from '../../../../src/storage/sqlite-compat';

const SCRIPT = resolve(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'scripts',
    'recover-messages.ts'
  )
);

/** A visible recovered message (top-level, consumed user / assistant). */
function recoveredMessage(uuid: string, type: string): string {
  return JSON.stringify({
    type,
    uuid,
    session_id: 'sdk-S',
    message: { role: type, content: [{ type: 'text', text: 'recovered' }] },
  });
}

describe('recover-messages script — interrupted-rerun recompute', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recover-msg-'));
    dbPath = join(dir, 'test.db');

    const db = new Database(dbPath);
    // sessions carries the full column set the script's `insertSession`
    // statement prepares against (it prepares eagerly in Step 5, even with
    // zero orphans), plus the maintained visible_message_count. sdk_messages
    // holds the rows a prior (interrupted) run inserted.
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_path TEXT,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        status TEXT NOT NULL,
        config TEXT NOT NULL,
        metadata TEXT NOT NULL,
        is_worktree INTEGER DEFAULT 0,
        worktree_path TEXT,
        main_repo_path TEXT,
        worktree_branch TEXT,
        git_branch TEXT,
        sdk_session_id TEXT,
        available_commands TEXT,
        processing_state TEXT,
        archived_at TEXT,
        visible_message_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE sdk_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_type TEXT NOT NULL,
        message_subtype TEXT,
        sdk_message TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        send_status TEXT,
        parent_tool_use_id TEXT
      );
    `);
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata, sdk_session_id)
       VALUES (?, '', ?, ?, 'active', '{}', '{}', ?)`
    ).run('sess-S', now, now, 'sdk-S');
    // Prior-run bypass inserts — visible rows, but the counter was never
    // maintained, so it stays at the default 0 (stale).
    const insert = db.prepare(
      `INSERT INTO sdk_messages (id, session_id, message_type, message_subtype, sdk_message, timestamp, send_status, parent_tool_use_id)
       VALUES (?, ?, ?, NULL, ?, ?, 'consumed', NULL)`
    );
    insert.run(
      'm1',
      'sess-S',
      'assistant',
      recoveredMessage('m1', 'assistant'),
      '2026-01-01T00:00:00Z'
    );
    insert.run('m2', 'sess-S', 'user', recoveredMessage('m2', 'user'), '2026-01-01T00:00:01Z');
    expect(
      (
        db
          .prepare(`SELECT visible_message_count AS n FROM sessions WHERE id = ?`)
          .get('sess-S') as {
          n: number;
        }
      ).n
    ).toBe(0);
    db.close();
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('rerun recomputes a session a prior interrupted run left stale (no new inserts)', () => {
    // All UUIDs already exist, so this run inserts nothing for sess-S — yet the
    // counter must still be recomputed. Fails if touchedSessions only tracks
    // current-run inserts.
    execFileSync('bun', [SCRIPT, dbPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const db = new Database(dbPath);
    const row = db
      .prepare(`SELECT visible_message_count AS n FROM sessions WHERE id = ?`)
      .get('sess-S') as { n: number };
    db.close();
    // assistant + consumed user → 2 visible rows.
    expect(row.n).toBe(2);
  }, 30000);
});
