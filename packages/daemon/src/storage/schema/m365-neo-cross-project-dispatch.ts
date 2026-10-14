import type { Database } from '../sqlite-compat.ts';

export function runMigration365(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS neo_cross_project_dispatches (
    id TEXT PRIMARY KEY,
    root_session_id TEXT NOT NULL,
    origin_message_id TEXT NOT NULL,
    ask_session_id TEXT NOT NULL,
    ask_message_id TEXT NOT NULL,
    parts_json TEXT NOT NULL,
    publication_id TEXT,
    UNIQUE(ask_session_id, ask_message_id)
  );
  CREATE TABLE IF NOT EXISTS neo_cross_project_dispatch_members (
    group_id TEXT NOT NULL REFERENCES neo_cross_project_dispatches(id),
    receipt_id TEXT NOT NULL UNIQUE REFERENCES neo_consultation_waiters(id),
    project_id TEXT NOT NULL REFERENCES neo_concerns(id),
    PRIMARY KEY(group_id, project_id)
  )`);
  for (const table of ['neo_asks', 'neo_work', 'neo_consultations', 'neo_concerns', 'sessions'])
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table))
      db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_route_id ON ${table}(id COLLATE NOCASE)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_neo_work_target_session ON neo_work(target_session_id);
    CREATE INDEX IF NOT EXISTS idx_neo_route_folder ON neo_project_workspaces(CAST(substr(CAST(alias AS BLOB), instr(CAST(alias AS BLOB), x'00') + 1) AS TEXT) COLLATE NOCASE) WHERE alias LIKE 'folder:%';
    CREATE INDEX IF NOT EXISTS idx_neo_route_work ON neo_project_workspaces(CAST(substr(CAST(alias AS BLOB), instr(CAST(alias AS BLOB), x'00') + instr(substr(CAST(alias AS BLOB), instr(CAST(alias AS BLOB), x'00') + 1), x'00') + 1) AS TEXT) COLLATE NOCASE) WHERE alias LIKE 'work:%';
    CREATE INDEX IF NOT EXISTS idx_neo_route_repo ON neo_project_workspaces(substr(alias, 6, instr(alias, char(0)) - 6)) WHERE alias LIKE 'repo:%';
    CREATE TABLE IF NOT EXISTS neo_route_pr_refs (
      reference TEXT NOT NULL, number INTEGER NOT NULL,
      work_id TEXT NOT NULL REFERENCES neo_work(id) ON DELETE CASCADE,
      PRIMARY KEY(reference, work_id)
    );
    CREATE INDEX IF NOT EXISTS idx_neo_route_pr_number ON neo_route_pr_refs(number)`);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'neo_work_prs'").get()) return;
  const select = `SELECT lower(replace(replace(json_extract(p.value, '$.url'), 'http://', 'https://'), '/issues/', '/pull/')),
    CAST(substr(json_extract(p.value, '$.url'), length(rtrim(json_extract(p.value, '$.url'), '0123456789')) + 1) AS INTEGER), r.work_id
    FROM neo_work_prs r, json_each(r.prs_json) p WHERE json_extract(p.value, '$.url') IS NOT NULL`;
  db.exec(`INSERT OR IGNORE INTO neo_route_pr_refs ${select};
    CREATE TRIGGER IF NOT EXISTS neo_route_pr_insert AFTER INSERT ON neo_work_prs BEGIN
      INSERT OR IGNORE INTO neo_route_pr_refs ${select} AND r.work_id = NEW.work_id;
    END;
    CREATE TRIGGER IF NOT EXISTS neo_route_pr_update AFTER UPDATE OF prs_json ON neo_work_prs BEGIN
      DELETE FROM neo_route_pr_refs WHERE work_id = OLD.work_id;
      INSERT OR IGNORE INTO neo_route_pr_refs ${select} AND r.work_id = NEW.work_id;
    END;
    CREATE TRIGGER IF NOT EXISTS neo_route_pr_delete AFTER DELETE ON neo_work_prs BEGIN
      DELETE FROM neo_route_pr_refs WHERE work_id = OLD.work_id;
    END`);
}
