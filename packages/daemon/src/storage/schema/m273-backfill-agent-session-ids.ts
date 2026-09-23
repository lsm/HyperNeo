import type { Database } from '../sqlite-compat.ts';

function tableExists(db: Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

function derivedAgentSessionId(spaceId: string, agentId: string): string {
  return `space:agent:${encodeURIComponent(spaceId)}:${encodeURIComponent(agentId)}`;
}

export function runMigration273(db: Database): void {
  if (!tableExists(db, 'space_long_horizon_agents') || !tableExists(db, 'sessions')) return;
  const agents = db
    .prepare(`SELECT id, space_id FROM space_long_horizon_agents WHERE session_id IS NULL`)
    .all() as Array<{ id: string; space_id: string }>;
  const sessionExists = db.prepare(`SELECT 1 FROM sessions WHERE id = ?`);
  const record = db.prepare(`UPDATE space_long_horizon_agents SET session_id = ? WHERE id = ?`);
  for (const agent of agents) {
    const sessionId = derivedAgentSessionId(agent.space_id, agent.id);
    if (sessionExists.get(sessionId)) record.run(sessionId, agent.id);
  }
}
