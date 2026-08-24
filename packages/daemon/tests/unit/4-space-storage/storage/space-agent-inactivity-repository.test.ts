import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  SpaceAgentInactivityClaimRepository,
  SpaceAgentInactivityConfigRepository,
} from '../../../../src/storage/repositories/space-agent-inactivity-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

describe('SpaceAgentInactivity repositories', () => {
  let db: Database;
  let configRepo: SpaceAgentInactivityConfigRepository;
  let claimRepo: SpaceAgentInactivityClaimRepository;
  let spaceId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceTables(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS space_long_horizon_agents (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL,
        handle TEXT NOT NULL,
        display_name TEXT NOT NULL,
        template_key TEXT DEFAULT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        session_id TEXT DEFAULT NULL,
        instructions TEXT NOT NULL DEFAULT '',
        autonomy_level INTEGER DEFAULT NULL,
        model TEXT DEFAULT NULL,
        thinking_level TEXT DEFAULT NULL,
        provider TEXT DEFAULT NULL,
        setting_sources TEXT DEFAULT NULL,
        tool_permissions_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (space_id) REFERENCES spaces(id) ON DELETE CASCADE
      )
    `);
    configRepo = new SpaceAgentInactivityConfigRepository(db as never);
    claimRepo = new SpaceAgentInactivityClaimRepository(db as never);
    spaceId = new SpaceRepository(db as never).createSpace({
      workspacePath: '/w',
      slug: 'w',
      name: 'W',
    }).id;
    for (const agentId of ['agent-1', 'agent-2']) {
      db.prepare(
        `INSERT INTO space_long_horizon_agents
         (id, space_id, handle, display_name, instructions, tool_permissions_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', '{}', 1, 1)`
      ).run(agentId, spaceId, agentId, agentId);
    }
  });

  afterEach(() => {
    db.close();
  });

  describe('config repository', () => {
    it('creates config with defaults disabled and unconfigured', () => {
      const config = configRepo.upsert({ spaceId, agentId: 'agent-1' });
      expect(config.enabled).toBe(false);
      expect(config.thresholdMs).toBeNull();
      expect(config.prompt).toBeNull();
      expect(config.configRevision).toBe(1);
    });

    it('bumps the revision only when config content changes', () => {
      configRepo.upsert({ spaceId, agentId: 'agent-1', enabled: true, thresholdMs: 5000 });
      const before = configRepo.getByAgent(spaceId, 'agent-1')!;
      expect(before.enabled).toBe(true);
      expect(before.thresholdMs).toBe(5000);

      const unchanged = configRepo.upsert({ spaceId, agentId: 'agent-1', thresholdMs: 5000 });
      expect(unchanged.configRevision).toBe(before.configRevision);

      const changed = configRepo.upsert({ spaceId, agentId: 'agent-1', thresholdMs: 9000 });
      expect(changed.configRevision).toBe(before.configRevision + 1);
    });

    it('clears threshold and prompt to null with a revision bump', () => {
      configRepo.upsert({
        spaceId,
        agentId: 'agent-1',
        enabled: true,
        thresholdMs: 5000,
        prompt: 'nag',
      });
      const before = configRepo.getByAgent(spaceId, 'agent-1')!;
      const cleared = configRepo.upsert({
        spaceId,
        agentId: 'agent-1',
        thresholdMs: null,
        prompt: null,
      });
      expect(cleared.thresholdMs).toBeNull();
      expect(cleared.prompt).toBeNull();
      expect(cleared.enabled).toBe(true);
      expect(cleared.configRevision).toBe(before.configRevision + 1);
    });

    it('lists only enabled configs for the space', () => {
      configRepo.upsert({ spaceId, agentId: 'agent-1', enabled: true, thresholdMs: 1000 });
      configRepo.upsert({ spaceId, agentId: 'agent-2', enabled: false });
      const enabled = configRepo.listEnabled(spaceId);
      expect(enabled.map((c) => c.agentId)).toEqual(['agent-1']);
    });
  });

  describe('claim repository', () => {
    it('acquires a claim when none exists and is idempotent per key', () => {
      const first = claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'inactivity-nag:agent-1:100:0',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });
      expect(first.acquired).toBe(true);
      expect(first.created).toBe(true);
      expect(first.claim.state).toBe('accepted');

      const retry = claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'inactivity-nag:agent-1:100:0',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });
      expect(retry.acquired).toBe(true);
      expect(retry.created).toBe(false);
    });

    it('treats a matching live claim as idempotent only for its owner', () => {
      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'k',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });
      const otherOwner = claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'k',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-b',
        configRevision: 1,
      });
      expect(otherOwner.acquired).toBe(false);
      expect(otherOwner.claim.ownerToken).toBe('scanner-a');
    });

    it('replaces a live claim left behind for an older window or revision', () => {
      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'old',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });
      const newWindow = claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'new-window',
        windowAnchoredAt: 200,
        attemptGeneration: 0,
        ownerToken: 'scanner-b',
        configRevision: 1,
      });
      expect(newWindow.acquired).toBe(true);
      expect(newWindow.created).toBe(true);
      expect(newWindow.claim.claimKey).toBe('new-window');

      const newRevision = claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'new-revision',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-c',
        configRevision: 2,
      });
      expect(newRevision.acquired).toBe(true);
      expect(newRevision.claim.claimKey).toBe('new-revision');
    });

    it('holds an accepted claim unchanged through a no-op accepted reset', () => {
      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'k',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });
      claimRepo.markInFlight(spaceId, 'agent-1', 'k');
      const held = claimRepo.applyReset(spaceId, 'agent-1', 'k', 'scanner-a', 1, {
        releaseClaim: false,
        markDegraded: false,
        advanceAttemptGeneration: false,
      });
      expect(held?.state).toBe('in_flight');
      expect(held?.claimKey).toBe('k');
    });

    it('refuses to steal a live different-key claim', () => {
      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'inactivity-nag:agent-1:100:0',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });
      const contested = claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'inactivity-nag:agent-1:100:1',
        windowAnchoredAt: 100,
        attemptGeneration: 1,
        ownerToken: 'scanner-b',
        configRevision: 1,
      });
      expect(contested.acquired).toBe(false);
      expect(contested.claim.claimKey).toBe('inactivity-nag:agent-1:100:0');
    });

    it('marks a claim in flight by key', () => {
      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'k',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });
      expect(claimRepo.markInFlight(spaceId, 'agent-1', 'k')).toBe(true);
      expect(claimRepo.getByAgent(spaceId, 'agent-1')?.state).toBe('in_flight');
      expect(claimRepo.markInFlight(spaceId, 'agent-1', 'other')).toBe(false);
    });

    it('releases the claim on a consuming reset and marks degraded on terminal failure', () => {
      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'k',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });

      expect(
        claimRepo.applyReset(spaceId, 'agent-1', 'k', 'scanner-a', 1, {
          releaseClaim: true,
          markDegraded: false,
          advanceAttemptGeneration: false,
        })
      ).toBeNull();
      expect(claimRepo.getByAgent(spaceId, 'agent-1')).toBeNull();

      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'k2',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });
      const degraded = claimRepo.applyReset(spaceId, 'agent-1', 'k2', 'scanner-a', 1, {
        releaseClaim: false,
        markDegraded: true,
        advanceAttemptGeneration: true,
      });
      expect(degraded?.degraded).toBe(true);
      expect(degraded?.attemptGeneration).toBe(1);
      expect(degraded?.state).toBe('none');
    });

    it('preserves in-flight state through an idempotent owner reacquisition', () => {
      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'k',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });
      claimRepo.markInFlight(spaceId, 'agent-1', 'k');
      const reacquired = claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'k',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });
      expect(reacquired.acquired).toBe(true);
      expect(reacquired.claim.state).toBe('in_flight');
    });

    it('ignores a late reset callback for a claim that was already replaced', () => {
      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'old',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });
      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'new',
        windowAnchoredAt: 200,
        attemptGeneration: 0,
        ownerToken: 'scanner-b',
        configRevision: 1,
      });
      const result = claimRepo.applyReset(spaceId, 'agent-1', 'old', 'scanner-a', 1, {
        releaseClaim: true,
        markDegraded: false,
        advanceAttemptGeneration: false,
      });
      expect(result?.claimKey).toBe('new');
      expect(claimRepo.getByAgent(spaceId, 'agent-1')?.claimKey).toBe('new');
    });

    it('replaces a same-key claim when only the revision changed', () => {
      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'k',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });
      const reacquired = claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'k',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 2,
      });
      expect(reacquired.acquired).toBe(true);
      expect(reacquired.claim.configRevision).toBe(2);
    });

    it('ignores a late reset from a previous owner even when the claim key matches', () => {
      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'k',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-b',
        configRevision: 2,
      });
      const result = claimRepo.applyReset(spaceId, 'agent-1', 'k', 'scanner-a', 2, {
        releaseClaim: true,
        markDegraded: false,
        advanceAttemptGeneration: false,
      });
      expect(result?.ownerToken).toBe('scanner-b');
      expect(claimRepo.getByAgent(spaceId, 'agent-1')?.ownerToken).toBe('scanner-b');
    });

    it('rejects config and claim writes for an agent outside the space', () => {
      db.prepare(
        `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
         VALUES ('space-other', 'other', '/o', 'Other', 1, 1)`
      ).run();
      db.prepare(
        `INSERT INTO space_long_horizon_agents
         (id, space_id, handle, display_name, instructions, tool_permissions_json, created_at, updated_at)
         VALUES ('agent-other', 'space-other', 'agent-other', 'agent-other', '', '{}', 1, 1)`
      ).run();
      expect(() => configRepo.upsert({ spaceId, agentId: 'agent-other', enabled: true })).toThrow(
        /does not belong to space/
      );
      expect(() =>
        claimRepo.acquire({
          spaceId,
          agentId: 'agent-other',
          claimKey: 'k',
          windowAnchoredAt: 100,
          attemptGeneration: 0,
          ownerToken: 'scanner-a',
          configRevision: 1,
        })
      ).toThrow(/does not belong to space/);
    });

    it('cascades config and claim rows when the agent is deleted', () => {
      configRepo.upsert({ spaceId, agentId: 'agent-1', enabled: true, thresholdMs: 1000 });
      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'k',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });
      db.prepare(`DELETE FROM space_long_horizon_agents WHERE id = 'agent-1'`).run();
      expect(configRepo.getByAgent(spaceId, 'agent-1')).toBeNull();
      expect(claimRepo.getByAgent(spaceId, 'agent-1')).toBeNull();
    });

    it('clears a degraded tombstone on explicit recovery', () => {
      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'k',
        windowAnchoredAt: 100,
        attemptGeneration: 2,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });
      claimRepo.applyReset(spaceId, 'agent-1', 'k', 'scanner-a', 1, {
        releaseClaim: false,
        markDegraded: true,
        advanceAttemptGeneration: false,
      });
      expect(claimRepo.clearDegraded(spaceId, 'agent-1')).toBe(true);
      const cleared = claimRepo.getByAgent(spaceId, 'agent-1');
      expect(cleared?.degraded).toBe(false);
      expect(cleared?.state).toBe('none');
    });

    it('releases stale non-degraded claims older than the cutoff', () => {
      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'k',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });
      expect(claimRepo.releaseStale(spaceId, 'agent-1', Date.now() + 1000)).toBe(true);
      expect(claimRepo.getByAgent(spaceId, 'agent-1')).toBeNull();
    });

    it('keeps fresh claims within the lease and degraded tombstones untouched', () => {
      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'k',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });
      expect(claimRepo.releaseStale(spaceId, 'agent-1', 1)).toBe(false);
      claimRepo.applyReset(spaceId, 'agent-1', 'k', 'scanner-a', 1, {
        releaseClaim: false,
        markDegraded: true,
        advanceAttemptGeneration: false,
      });
      expect(claimRepo.releaseStale(spaceId, 'agent-1', Date.now() + 1000)).toBe(false);
    });

    it('ignores a late reset when the claim was replaced with a newer revision', () => {
      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'k',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 1,
      });
      claimRepo.acquire({
        spaceId,
        agentId: 'agent-1',
        claimKey: 'k',
        windowAnchoredAt: 100,
        attemptGeneration: 0,
        ownerToken: 'scanner-a',
        configRevision: 2,
      });
      const result = claimRepo.applyReset(spaceId, 'agent-1', 'k', 'scanner-a', 1, {
        releaseClaim: true,
        markDegraded: false,
        advanceAttemptGeneration: false,
      });
      expect(result?.configRevision).toBe(2);
      expect(claimRepo.getByAgent(spaceId, 'agent-1')?.configRevision).toBe(2);
    });
  });
});
