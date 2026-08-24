import { generateUUID } from '@hyperneo/shared';
import type { Database as BunDatabase } from '../sqlite-compat.ts';
import type { SQLiteValue } from '../types.ts';

export interface SpaceAgentInactivityConfig {
  id: string;
  spaceId: string;
  agentId: string;
  enabled: boolean;
  thresholdMs: number | null;
  prompt: string | null;
  configRevision: number;
  createdAt: number;
  updatedAt: number;
}

export interface UpsertAgentInactivityConfigParams {
  spaceId: string;
  agentId: string;
  enabled?: boolean;
  thresholdMs?: number | null;
  prompt?: string | null;
}

export interface SpaceAgentInactivityClaim {
  id: string;
  spaceId: string;
  agentId: string;
  claimKey: string;
  state: 'none' | 'accepted' | 'in_flight';
  windowAnchoredAt: number;
  attemptGeneration: number;
  ownerToken: string | null;
  configRevision: number | null;
  degraded: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface AcquireAgentInactivityClaimParams {
  spaceId: string;
  agentId: string;
  claimKey: string;
  windowAnchoredAt: number;
  attemptGeneration: number;
  ownerToken: string;
  configRevision: number | null;
}

function requireAgentInSpace(db: BunDatabase, spaceId: string, agentId: string): void {
  const row = db
    .prepare(`SELECT 1 FROM space_long_horizon_agents WHERE id = ? AND space_id = ?`)
    .get(agentId, spaceId);
  if (row == null) {
    throw new Error(`Agent "${agentId}" does not belong to space "${spaceId}"`);
  }
}

export class SpaceAgentInactivityConfigRepository {
  constructor(private db: BunDatabase) {}

  getByAgent(spaceId: string, agentId: string): SpaceAgentInactivityConfig | null {
    const row = this.db
      .prepare(`SELECT * FROM space_agent_inactivity_config WHERE space_id = ? AND agent_id = ?`)
      .get(spaceId, agentId) as Record<string, unknown> | null;
    return row ? rowToConfig(row) : null;
  }

  listEnabled(spaceId: string): Array<Omit<SpaceAgentInactivityConfig, 'prompt'>> {
    const rows = this.db
      .prepare(
        `SELECT id, space_id, agent_id, enabled, threshold_ms, config_revision, created_at, updated_at
         FROM space_agent_inactivity_config WHERE space_id = ? AND enabled = 1`
      )
      .all(spaceId) as Record<string, unknown>[];
    return rows.map(rowToConfig);
  }

  upsert(params: UpsertAgentInactivityConfigParams): SpaceAgentInactivityConfig {
    requireAgentInSpace(this.db, params.spaceId, params.agentId);
    const existing = this.getByAgent(params.spaceId, params.agentId);
    const now = Date.now();
    if (existing === null) {
      const id = generateUUID();
      this.db
        .prepare(
          `INSERT INTO space_agent_inactivity_config (
             id, space_id, agent_id, enabled, threshold_ms, prompt, config_revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
        )
        .run(
          id,
          params.spaceId,
          params.agentId,
          (params.enabled ?? false) ? 1 : 0,
          params.thresholdMs ?? null,
          params.prompt ?? null,
          now,
          now
        );
      return this.getByAgent(params.spaceId, params.agentId)!;
    }
    const changed =
      (params.enabled !== undefined && existing.enabled !== params.enabled) ||
      (params.thresholdMs !== undefined && existing.thresholdMs !== params.thresholdMs) ||
      (params.prompt !== undefined && existing.prompt !== params.prompt);
    if (changed) {
      const nextEnabled = params.enabled !== undefined ? params.enabled : existing.enabled;
      const nextThreshold =
        params.thresholdMs !== undefined ? params.thresholdMs : existing.thresholdMs;
      const nextPrompt = params.prompt !== undefined ? params.prompt : existing.prompt;
      this.db
        .prepare(
          `UPDATE space_agent_inactivity_config
           SET enabled = ?, threshold_ms = ?, prompt = ?, config_revision = config_revision + 1, updated_at = ?
           WHERE id = ?`
        )
        .run(
          nextEnabled ? 1 : 0,
          nextThreshold as SQLiteValue,
          nextPrompt as SQLiteValue,
          now,
          existing.id
        );
    }
    return this.getByAgent(params.spaceId, params.agentId)!;
  }

  setEnabled(spaceId: string, agentId: string, enabled: boolean): SpaceAgentInactivityConfig {
    return this.upsert({ spaceId, agentId, enabled });
  }
}

export class SpaceAgentInactivityClaimRepository {
  constructor(private db: BunDatabase) {}

  getByAgent(spaceId: string, agentId: string): SpaceAgentInactivityClaim | null {
    const row = this.db
      .prepare(`SELECT * FROM space_agent_inactivity_claims WHERE space_id = ? AND agent_id = ?`)
      .get(spaceId, agentId) as Record<string, unknown> | null;
    return row ? rowToClaim(row) : null;
  }

  acquire(params: AcquireAgentInactivityClaimParams): {
    acquired: boolean;
    claim: SpaceAgentInactivityClaim;
  } {
    const now = Date.now();
    const result = this.db.transaction(() => {
      requireAgentInSpace(this.db, params.spaceId, params.agentId);
      const existing = this.getByAgent(params.spaceId, params.agentId);
      if (
        existing !== null &&
        existing.state !== 'none' &&
        !existing.degraded &&
        existing.claimKey === params.claimKey &&
        existing.ownerToken === params.ownerToken &&
        existing.windowAnchoredAt === params.windowAnchoredAt &&
        existing.configRevision === params.configRevision
      ) {
        return { acquired: true, claim: existing };
      }
      const blocksCurrentWindow =
        existing !== null &&
        existing.state !== 'none' &&
        !existing.degraded &&
        existing.windowAnchoredAt === params.windowAnchoredAt &&
        existing.configRevision === params.configRevision;
      if (blocksCurrentWindow) {
        return { acquired: false, claim: existing };
      }
      const id = existing?.id ?? generateUUID();
      const createdAt = existing?.createdAt ?? now;
      this.db
        .prepare(
          `INSERT INTO space_agent_inactivity_claims (
             id, space_id, agent_id, claim_key, state, window_anchored_at,
             attempt_generation, owner_token, config_revision, degraded, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'accepted', ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(space_id, agent_id) DO UPDATE SET
             claim_key = excluded.claim_key,
             state = 'accepted',
             window_anchored_at = excluded.window_anchored_at,
             attempt_generation = excluded.attempt_generation,
             owner_token = excluded.owner_token,
             config_revision = excluded.config_revision,
             degraded = 0,
             updated_at = excluded.updated_at`
        )
        .run(
          id,
          params.spaceId,
          params.agentId,
          params.claimKey,
          params.windowAnchoredAt,
          params.attemptGeneration,
          params.ownerToken,
          params.configRevision,
          createdAt,
          now
        );
      return { acquired: true, claim: this.getByAgent(params.spaceId, params.agentId)! };
    })();
    return result;
  }

  markInFlight(spaceId: string, agentId: string, claimKey: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE space_agent_inactivity_claims
         SET state = 'in_flight', updated_at = ?
         WHERE space_id = ? AND agent_id = ? AND claim_key = ?`
      )
      .run(Date.now(), spaceId, agentId, claimKey);
    return result.changes > 0;
  }

  applyReset(
    spaceId: string,
    agentId: string,
    expectedClaimKey: string,
    expectedOwnerToken: string | null,
    reset: {
      releaseClaim: boolean;
      markDegraded: boolean;
      advanceAttemptGeneration: boolean;
    }
  ): SpaceAgentInactivityClaim | null {
    const now = Date.now();
    return this.db.transaction(() => {
      const existing = this.getByAgent(spaceId, agentId);
      if (existing === null) return null;
      if (existing.claimKey !== expectedClaimKey || existing.ownerToken !== expectedOwnerToken) {
        return existing;
      }
      if (reset.releaseClaim) {
        this.db.prepare(`DELETE FROM space_agent_inactivity_claims WHERE id = ?`).run(existing.id);
        return null;
      }
      if (!reset.markDegraded && !reset.advanceAttemptGeneration) {
        return existing;
      }
      this.db
        .prepare(
          `UPDATE space_agent_inactivity_claims
           SET degraded = ?, attempt_generation = ?, state = 'none', updated_at = ?
           WHERE id = ?`
        )
        .run(
          reset.markDegraded ? 1 : 0,
          reset.advanceAttemptGeneration
            ? existing.attemptGeneration + 1
            : existing.attemptGeneration,
          now,
          existing.id
        );
      return this.getByAgent(spaceId, agentId);
    })();
  }

  clearDegraded(spaceId: string, agentId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE space_agent_inactivity_claims
         SET degraded = 0, state = 'none', updated_at = ?
         WHERE space_id = ? AND agent_id = ? AND degraded = 1`
      )
      .run(Date.now(), spaceId, agentId);
    return result.changes > 0;
  }
}

function rowToConfig(row: Record<string, unknown>): SpaceAgentInactivityConfig {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    agentId: row.agent_id as string,
    enabled: row.enabled === 1,
    thresholdMs: (row.threshold_ms as number | null) ?? null,
    prompt: (row.prompt as string | null) ?? null,
    configRevision: row.config_revision as number,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}

function rowToClaim(row: Record<string, unknown>): SpaceAgentInactivityClaim {
  return {
    id: row.id as string,
    spaceId: row.space_id as string,
    agentId: row.agent_id as string,
    claimKey: row.claim_key as string,
    state: row.state as SpaceAgentInactivityClaim['state'],
    windowAnchoredAt: row.window_anchored_at as number,
    attemptGeneration: row.attempt_generation as number,
    ownerToken: (row.owner_token as string | null) ?? null,
    configRevision: (row.config_revision as number | null) ?? null,
    degraded: row.degraded === 1,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
