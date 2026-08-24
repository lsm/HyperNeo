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
    configRepo = new SpaceAgentInactivityConfigRepository(db as never);
    claimRepo = new SpaceAgentInactivityClaimRepository(db as never);
    spaceId = new SpaceRepository(db as never).createSpace({
      workspacePath: '/w',
      slug: 'w',
      name: 'W',
    }).id;
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
      const held = claimRepo.applyReset(spaceId, 'agent-1', {
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
        claimKey: 'inactivity-nag:agent-1:200:0',
        windowAnchoredAt: 200,
        attemptGeneration: 0,
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
        claimRepo.applyReset(spaceId, 'agent-1', {
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
      const degraded = claimRepo.applyReset(spaceId, 'agent-1', {
        releaseClaim: false,
        markDegraded: true,
        advanceAttemptGeneration: true,
      });
      expect(degraded?.degraded).toBe(true);
      expect(degraded?.attemptGeneration).toBe(1);
      expect(degraded?.state).toBe('none');
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
      claimRepo.applyReset(spaceId, 'agent-1', {
        releaseClaim: false,
        markDegraded: true,
        advanceAttemptGeneration: false,
      });
      expect(claimRepo.clearDegraded(spaceId, 'agent-1')).toBe(true);
      const cleared = claimRepo.getByAgent(spaceId, 'agent-1');
      expect(cleared?.degraded).toBe(false);
      expect(cleared?.state).toBe('none');
    });
  });
});
