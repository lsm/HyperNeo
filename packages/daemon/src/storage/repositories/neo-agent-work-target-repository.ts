import type { NeoAgentWorkOwner } from '../../lib/neo/agent-work-target.ts';
import type { Database } from '../sqlite-compat.ts';
import type { NeoWorkTarget } from './neo-repository.ts';

type AgentTarget = NonNullable<NeoWorkTarget['agent']>;

export class NeoAgentWorkTargetRepository {
  constructor(private readonly db: Database) {}

  get(workId: string): AgentTarget | null {
    return (
      (this.db
        .prepare(`SELECT space_id AS spaceId, agent_id AS agentId, session_id AS sessionId
          FROM neo_agent_work_targets WHERE work_id = ?`)
        .get(workId) as AgentTarget | null) ?? null
    );
  }

  reserve(workId: string, agent: AgentTarget): AgentTarget | null {
    this.db
      .prepare(`INSERT INTO neo_agent_work_targets(work_id, space_id, agent_id, session_id)
        SELECT id, ?, ?, ? FROM neo_work
        WHERE id = ? AND status = 'proposed' AND target_session_id = ?
        ON CONFLICT(work_id) DO NOTHING`)
      .run(agent.spaceId, agent.agentId, agent.sessionId, workId, agent.sessionId);
    return this.get(workId);
  }

  readOwner(agent: AgentTarget): NeoAgentWorkOwner | null {
    return (
      (this.db
        .prepare(`SELECT a.id AS agentId, a.space_id AS spaceId, a.session_id AS sessionId,
          a.status AS agentStatus, s.status AS spaceStatus, s.paused, s.stopped,
          (SELECT space_id FROM sessions WHERE id = a.session_id) AS nativeSpaceId,
          ((SELECT COUNT(*) FROM space_long_horizon_agents x WHERE x.session_id = a.session_id)
            + EXISTS (SELECT 1 FROM node_executions e WHERE e.agent_session_id = a.session_id)
            + EXISTS (SELECT 1 FROM direct_task_session_provenance p WHERE p.session_id = a.session_id)
            + EXISTS (SELECT 1 FROM sessions x WHERE x.id = a.session_id AND x.task_id IS NOT NULL)
          ) AS ownerCount
          FROM space_long_horizon_agents a JOIN spaces s ON s.id = a.space_id
          WHERE a.id = ? AND a.space_id = ?`)
        .get(agent.agentId, agent.spaceId) as NeoAgentWorkOwner | null) ?? null
    );
  }
}
