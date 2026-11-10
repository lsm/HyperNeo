import { Logger } from '../../lib/logger.ts';
import type { Database } from '../sqlite-compat.ts';

const log = new Logger('migration-472');

const CHILDREN_FIRST: [table: string, children: string[]][] = [
  ['mission_executions', []],
  ['mission_metric_history', []],
  ['room_github_mappings', []],
  ['room_mcp_enablement', []],
  ['room_skill_overrides', []],
  ['tasks', []],
  ['goals', ['mission_executions', 'mission_metric_history']],
  [
    'rooms',
    ['room_github_mappings', 'room_mcp_enablement', 'room_skill_overrides', 'tasks', 'goals'],
  ],
];

function tableExists(db: Database, table: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?`).get(table);
}

function detachInboxItemsFromRooms(db: Database): void {
  const linked = db
    .prepare(`SELECT 1 FROM pragma_foreign_key_list('inbox_items') WHERE "table" = 'rooms'`)
    .get();
  if (!linked) return;
  db.exec(`ALTER TABLE inbox_items RENAME TO inbox_items_m472`);
  db.exec(`CREATE TABLE inbox_items (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('github_issue', 'github_comment', 'github_pr')),
        repository TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        comment_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        author TEXT NOT NULL,
        author_permission TEXT,
        labels TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'routed', 'dismissed', 'blocked')),
        routed_to_room_id TEXT,
        routed_at INTEGER,
        security_check TEXT NOT NULL,
        raw_event TEXT NOT NULL,
        received_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
  db.exec(`INSERT INTO inbox_items SELECT * FROM inbox_items_m472`);
  db.exec(`DROP TABLE inbox_items_m472`);
  db.exec(`CREATE INDEX idx_inbox_items_status ON inbox_items(status)`);
  db.exec(`CREATE INDEX idx_inbox_items_repository ON inbox_items(repository, issue_number)`);
}

function dropEmptyTables(db: Database): void {
  const kept = new Set<string>();
  for (const [table, children] of CHILDREN_FIRST) {
    if (!tableExists(db, table)) continue;
    const hasRows = !!db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
    if (hasRows || children.some((child) => kept.has(child))) {
      kept.add(table);
      log.warn(`Keeping ${table}: it or a table that references it still has rows`);
      continue;
    }
    db.exec(`DROP TABLE ${table}`);
  }
}

export function runMigration472(db: Database): void {
  db.transaction(() => {
    detachInboxItemsFromRooms(db);
    dropEmptyTables(db);
  })();
}
