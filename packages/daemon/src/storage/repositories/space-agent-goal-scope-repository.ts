import type { SpaceLongHorizonAgentForgeScope, SpaceLongHorizonAgentGoal } from '@hyperneo/shared';
import { SPACE_MANAGER_HANDLE } from '../../lib/space/agent-handle.ts';
import {
  decideGoalOwnerResolution,
  type GoalOwnerAgentState,
  type GoalOwnerResolutionDecision,
} from '../../lib/space/goals/goal-owner-resolution.ts';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { SpaceAgentRepository } from './space-agent-repository.ts';

export class SpaceAgentGoalScopeRepository {
  constructor(
    private db: BunDatabase,
    private agents: Pick<SpaceAgentRepository, 'getById' | 'getByHandle'>
  ) {}

  assignGoal(
    agentId: string,
    goalId: string,
    relationship: SpaceLongHorizonAgentGoal['relationship'] = 'owner'
  ): void {
    const agent = this.requireAgent(agentId);
    this.requireMatchingSpace('space_goals', goalId, agent.spaceId, 'Goal');
    const now = Date.now();
    const replace = this.db.transaction(() => {
      if (relationship === 'owner') {
        this.db
          .prepare(
            `DELETE FROM space_long_horizon_agent_goals WHERE goal_id = ? AND relationship = 'owner'`
          )
          .run(goalId);
      }
      this.db
        .prepare(
          `INSERT INTO space_long_horizon_agent_goals (agent_id, goal_id, relationship, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(agent_id, goal_id, relationship) DO UPDATE SET updated_at = excluded.updated_at`
        )
        .run(agentId, goalId, relationship, now, now);
    });
    replace();
  }

  listGoals(agentId: string): SpaceLongHorizonAgentGoal[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_long_horizon_agent_goals WHERE agent_id = ? ORDER BY created_at ASC`
      )
      .all(agentId) as Record<string, unknown>[];
    return rows.map(rowToGoalLink);
  }

  listGoalAssignments(goalId: string): SpaceLongHorizonAgentGoal[] {
    const rows = this.db
      .prepare(`SELECT * FROM space_long_horizon_agent_goals WHERE goal_id = ?`)
      .all(goalId) as Record<string, unknown>[];
    return rows.map(rowToGoalLink);
  }

  deleteGoalAssignment(agentId: string, goalId: string): void {
    this.db
      .prepare(`DELETE FROM space_long_horizon_agent_goals WHERE agent_id = ? AND goal_id = ?`)
      .run(agentId, goalId);
  }

  deleteGoalAssignmentByRelationship(
    agentId: string,
    goalId: string,
    relationship: SpaceLongHorizonAgentGoal['relationship']
  ): void {
    this.db
      .prepare(
        `DELETE FROM space_long_horizon_agent_goals WHERE agent_id = ? AND goal_id = ? AND relationship = ?`
      )
      .run(agentId, goalId, relationship);
  }

  getPrimaryGoalOwner(goalId: string, spaceId: string): GoalOwnerResolutionDecision {
    const assignments = this.listGoalAssignments(goalId);
    const candidates = assignments
      .filter((a) => a.relationship === 'owner')
      .map((a) => ({ agentId: a.agentId, relationship: a.relationship, createdAt: a.createdAt }));
    const agentStates: Record<string, GoalOwnerAgentState> = {};
    for (const candidate of candidates) {
      const agent = this.agents.getById(candidate.agentId);
      if (!agent) {
        agentStates[candidate.agentId] = { state: 'missing' };
      } else if (agent.spaceId !== spaceId) {
        agentStates[candidate.agentId] = { state: 'missing' };
      } else {
        agentStates[candidate.agentId] = { state: agent.status };
      }
    }
    const coordinator = this.getCoordinator(spaceId);
    return decideGoalOwnerResolution({
      candidates,
      agentStates,
      coordinatorAgentId: coordinator?.id ?? null,
    });
  }

  assignForgeScope(
    agentId: string,
    scopeId: string,
    relationship: SpaceLongHorizonAgentForgeScope['relationship'] = 'owner'
  ): void {
    const agent = this.requireAgent(agentId);
    this.requireMatchingSpace('evolution_scopes', scopeId, agent.spaceId, 'Forge scope');
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO space_long_horizon_agent_forge_scopes (agent_id, scope_id, relationship, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(agent_id, scope_id, relationship) DO UPDATE SET updated_at = excluded.updated_at`
      )
      .run(agentId, scopeId, relationship, now, now);
  }

  listForgeScopes(agentId: string): SpaceLongHorizonAgentForgeScope[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM space_long_horizon_agent_forge_scopes WHERE agent_id = ? ORDER BY created_at ASC`
      )
      .all(agentId) as Record<string, unknown>[];
    return rows.map(rowToForgeScopeLink);
  }

  deleteForgeScopeAssignment(agentId: string, scopeId: string): void {
    this.db
      .prepare(
        `DELETE FROM space_long_horizon_agent_forge_scopes WHERE agent_id = ? AND scope_id = ?`
      )
      .run(agentId, scopeId);
  }

  private getCoordinator(spaceId: string): { id: string } | null {
    return (
      this.agents.getByHandle(spaceId, SPACE_MANAGER_HANDLE) ??
      this.agents.getByHandle(spaceId, 'coordinator')
    );
  }

  private requireAgent(agentId: string): { spaceId: string } {
    const agent = this.agents.getById(agentId);
    if (!agent) throw new Error(`Long-horizon agent not found: ${agentId}`);
    return agent;
  }

  private requireMatchingSpace(
    tableName: 'space_goals' | 'evolution_scopes',
    id: string,
    spaceId: string,
    label: string
  ): void {
    const row = this.db.prepare(`SELECT space_id FROM ${tableName} WHERE id = ?`).get(id) as
      | { space_id: string }
      | undefined;
    if (!row) throw new Error(`${label} not found: ${id}`);
    if (row.space_id !== spaceId) {
      throw new Error(`${label} ${id} does not belong to space ${spaceId}`);
    }
  }
}

function rowToGoalLink(row: Record<string, unknown>): SpaceLongHorizonAgentGoal {
  return {
    agentId: row.agent_id as string,
    goalId: row.goal_id as string,
    relationship: row.relationship as SpaceLongHorizonAgentGoal['relationship'],
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToForgeScopeLink(row: Record<string, unknown>): SpaceLongHorizonAgentForgeScope {
  return {
    agentId: row.agent_id as string,
    scopeId: row.scope_id as string,
    relationship: row.relationship as SpaceLongHorizonAgentForgeScope['relationship'],
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
