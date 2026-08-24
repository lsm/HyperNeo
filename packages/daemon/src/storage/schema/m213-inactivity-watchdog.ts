import type { Database as BunDatabase } from '../sqlite-compat.ts';

export function runMigration213(db: BunDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS space_agent_inactivity_config (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      threshold_ms INTEGER,
      prompt TEXT,
      config_revision INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(space_id, agent_id),
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES space_long_horizon_agents(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS space_agent_inactivity_claims (
      id TEXT PRIMARY KEY,
      space_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      claim_key TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'accepted'
        CHECK(state IN ('none', 'accepted', 'in_flight')),
      window_anchored_at INTEGER NOT NULL,
      attempt_generation INTEGER NOT NULL DEFAULT 0,
      owner_token TEXT,
      config_revision INTEGER,
      degraded INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(space_id, agent_id),
      FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (agent_id) REFERENCES space_long_horizon_agents(id) ON DELETE CASCADE
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_space_agent_inactivity_claims_space
    ON space_agent_inactivity_claims(space_id, agent_id)
  `);
}
