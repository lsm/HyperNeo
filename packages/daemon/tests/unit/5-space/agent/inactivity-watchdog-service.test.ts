import { describe, expect, it, beforeEach, afterEach, mock } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import {
  SpaceAgentInactivityClaimRepository,
  SpaceAgentInactivityConfigRepository,
} from '../../../../src/storage/repositories/space-agent-inactivity-repository';
import {
  SpaceAgentInactivityWatchdogService,
  boundInactivityNagPrompt,
  DEFAULT_INACTIVITY_NAG_PROMPT,
  INACTIVITY_NAG_PROMPT_MAX_CHARS,
  type InactivityNagDeliveryOutcome,
  type InactivityWatchdogSessionSnapshot,
} from '../../../../src/lib/space/agents/inactivity-watchdog-service';
import { buildInactivityNagClaimKey } from '../../../../src/lib/space/agents/inactivity-watchdog-gates';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

const NOW = 10_000_000;
const THRESHOLD_MS = 3_600_000;

function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-1',
    spaceId: 'space-1',
    status: 'active',
    createdAt: NOW - THRESHOLD_MS - 10_000,
    ...overrides,
  };
}

describe('SpaceAgentInactivityWatchdogService', () => {
  let db: Database;
  let configRepo: SpaceAgentInactivityConfigRepository;
  let claimRepo: SpaceAgentInactivityClaimRepository;
  let spaceId: string;
  let agentRepo: { getById: ReturnType<typeof mock> };
  let spaceManager: { getSpace: ReturnType<typeof mock> };
  let sessionSnapshot: InactivityWatchdogSessionSnapshot;
  let outcomes: Array<{ idempotencyKey: string; prompt: string }>;
  let nextOutcome: InactivityNagDeliveryOutcome;

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
    db.prepare(
      `INSERT INTO space_long_horizon_agents
       (id, space_id, handle, display_name, instructions, tool_permissions_json, created_at, updated_at)
       VALUES ('agent-1', ?, 'agent-1', 'agent-1', '', '{}', ?, 1)`
    ).run(spaceId, NOW - THRESHOLD_MS - 10_000);
    agentRepo = { getById: mock(() => makeAgent({ spaceId })) };
    spaceManager = {
      getSpace: mock(async () => ({
        status: 'active',
        paused: false,
        stopped: false,
      })),
    };
    sessionSnapshot = {
      latestConsumedMessageAt: NOW - THRESHOLD_MS - 5000,
      sessionCreatedAt: NOW - THRESHOLD_MS - 9000,
      busyWithOtherWork: false,
      pendingOtherAcceptedDelivery: false,
    };
    outcomes = [];
    nextOutcome = 'consumed';
  });

  afterEach(() => {
    db.close();
  });

  function makeService(
    overrides: Partial<{
      scannerToken: string;
      getSessionSnapshot: () => InactivityWatchdogSessionSnapshot | null;
    }> = {}
  ) {
    return new SpaceAgentInactivityWatchdogService({
      configRepo,
      claimRepo,
      agentRepo: agentRepo as never,
      spaceManager: spaceManager as never,
      scannerToken: overrides.scannerToken ?? 'scanner-a',
      now: () => NOW,
      getSessionSnapshot: overrides.getSessionSnapshot ?? (() => sessionSnapshot),
      deliverNag: async (args) => {
        outcomes.push({ idempotencyKey: args.idempotencyKey, prompt: args.prompt });
        return nextOutcome;
      },
    });
  }

  it('nags a due idle agent, marks the claim, and releases it on consumption', async () => {
    configRepo.upsert({ spaceId, agentId: 'agent-1', enabled: true, thresholdMs: THRESHOLD_MS });
    await makeService().scanSpace(spaceId);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].idempotencyKey).toContain('inactivity-nag:agent-1:');
    expect(outcomes[0].prompt).toBe(DEFAULT_INACTIVITY_NAG_PROMPT);
    expect(claimRepo.getByAgent(spaceId, 'agent-1')).toBeNull();
  });

  it('does not nag before the threshold elapses', async () => {
    configRepo.upsert({ spaceId, agentId: 'agent-1', enabled: true, thresholdMs: THRESHOLD_MS });
    sessionSnapshot.latestConsumedMessageAt = NOW - 1000;
    await makeService().scanSpace(spaceId);
    expect(outcomes).toHaveLength(0);
  });

  it('rearms without delivering when the admission recheck rejects a moved window', async () => {
    configRepo.upsert({ spaceId, agentId: 'agent-1', enabled: true, thresholdMs: THRESHOLD_MS });
    let calls = 0;
    const service = new SpaceAgentInactivityWatchdogService({
      configRepo,
      claimRepo,
      agentRepo: agentRepo as never,
      spaceManager: spaceManager as never,
      scannerToken: 'scanner-a',
      now: () => NOW,
      getSessionSnapshot: () => {
        calls += 1;
        return {
          ...sessionSnapshot,
          latestConsumedMessageAt: calls <= 1 ? sessionSnapshot.latestConsumedMessageAt : NOW - 10,
        };
      },
      deliverNag: async (args) => {
        outcomes.push({ idempotencyKey: args.idempotencyKey, prompt: args.prompt });
        return nextOutcome;
      },
    });
    await service.scanSpace(spaceId);
    expect(outcomes).toHaveLength(0);
    expect(claimRepo.getByAgent(spaceId, 'agent-1')).toBeNull();
  });

  it('marks the claim degraded on terminal failure and blocks the next scan', async () => {
    configRepo.upsert({ spaceId, agentId: 'agent-1', enabled: true, thresholdMs: THRESHOLD_MS });
    nextOutcome = 'terminal_failure';
    await makeService().scanSpace(spaceId);
    const degraded = claimRepo.getByAgent(spaceId, 'agent-1');
    expect(degraded?.degraded).toBe(true);
    nextOutcome = 'consumed';
    await makeService().scanSpace(spaceId);
    expect(outcomes).toHaveLength(1);
  });

  it('advances no generation after a post-consumption terminal failure', async () => {
    configRepo.upsert({ spaceId, agentId: 'agent-1', enabled: true, thresholdMs: THRESHOLD_MS });
    nextOutcome = 'terminal_failure_after_consumption';
    await makeService().scanSpace(spaceId);
    const claim = claimRepo.getByAgent(spaceId, 'agent-1');
    expect(claim?.degraded).toBe(true);
    expect(claim?.attemptGeneration).toBe(0);
  });

  it('skips agents with competing session work or pending deliveries', async () => {
    configRepo.upsert({ spaceId, agentId: 'agent-1', enabled: true, thresholdMs: THRESHOLD_MS });
    sessionSnapshot.busyWithOtherWork = true;
    await makeService().scanSpace(spaceId);
    expect(outcomes).toHaveLength(0);
    sessionSnapshot.busyWithOtherWork = false;
    sessionSnapshot.pendingOtherAcceptedDelivery = true;
    await makeService().scanSpace(spaceId);
    expect(outcomes).toHaveLength(0);
  });

  it('skips when the agent is paused or the space is not wakeable', async () => {
    configRepo.upsert({ spaceId, agentId: 'agent-1', enabled: true, thresholdMs: THRESHOLD_MS });
    agentRepo.getById.mockImplementationOnce(() => makeAgent({ spaceId, status: 'paused' }));
    await makeService().scanSpace(spaceId);
    expect(outcomes).toHaveLength(0);
    spaceManager.getSpace.mockImplementationOnce(async () => ({
      status: 'active',
      paused: true,
      stopped: false,
    }));
    await makeService().scanSpace(spaceId);
    expect(outcomes).toHaveLength(0);
  });

  it('falls back to the session-creation baseline when no message was consumed', async () => {
    configRepo.upsert({ spaceId, agentId: 'agent-1', enabled: true, thresholdMs: THRESHOLD_MS });
    sessionSnapshot.latestConsumedMessageAt = null;
    await makeService().scanSpace(spaceId);
    expect(outcomes).toHaveLength(1);
  });

  it('uses the configured prompt when present and truncates oversized prompts', () => {
    configRepo.upsert({ spaceId, agentId: 'agent-1', enabled: true, thresholdMs: THRESHOLD_MS });
    expect(boundInactivityNagPrompt(null)).toBe(DEFAULT_INACTIVITY_NAG_PROMPT);
    expect(boundInactivityNagPrompt('  Check your queue.  ')).toBe('Check your queue.');
    const oversized = 'x'.repeat(INACTIVITY_NAG_PROMPT_MAX_CHARS + 500);
    const bounded = boundInactivityNagPrompt(oversized);
    expect(bounded.length).toBe(INACTIVITY_NAG_PROMPT_MAX_CHARS);
  });

  it('truncates oversized prompts at code-point boundaries', () => {
    const emoji = '😀'.repeat(INACTIVITY_NAG_PROMPT_MAX_CHARS + 100);
    const bounded = boundInactivityNagPrompt(emoji);
    expect(bounded.endsWith('…')).toBe(true);
    expect([...bounded].length).toBe(INACTIVITY_NAG_PROMPT_MAX_CHARS);
    expect(bounded.includes('�')).toBe(false);
    const astralUnderLimit = '😀'.repeat(INACTIVITY_NAG_PROMPT_MAX_CHARS / 2 + 1);
    expect(boundInactivityNagPrompt(astralUnderLimit)).toBe(astralUnderLimit);
  });

  it('holds the claim when a delivery times out and applies the late outcome', async () => {
    configRepo.upsert({ spaceId, agentId: 'agent-1', enabled: true, thresholdMs: THRESHOLD_MS });
    let resolveDelivery: (outcome: InactivityNagDeliveryOutcome) => void = () => {};
    const service = new SpaceAgentInactivityWatchdogService({
      configRepo,
      claimRepo,
      agentRepo: agentRepo as never,
      spaceManager: spaceManager as never,
      scannerToken: 'scanner-a',
      now: () => NOW,
      getSessionSnapshot: () => sessionSnapshot,
      deliveryTimeoutMs: 50,
      deliverNag: async (args) => {
        outcomes.push({ idempotencyKey: args.idempotencyKey, prompt: args.prompt });
        return new Promise((resolve) => {
          resolveDelivery = resolve;
        });
      },
    });
    await service.scanSpace(spaceId);
    expect(outcomes).toHaveLength(1);
    const held = claimRepo.getByAgent(spaceId, 'agent-1');
    expect(held?.degraded).toBe(false);
    expect(held?.state).toBe('in_flight');
    resolveDelivery('consumed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(claimRepo.getByAgent(spaceId, 'agent-1')).toBeNull();
  });

  it('does not redeliver a claim already held by this scanner', async () => {
    configRepo.upsert({ spaceId, agentId: 'agent-1', enabled: true, thresholdMs: THRESHOLD_MS });
    nextOutcome = 'accepted';
    await makeService().scanSpace(spaceId);
    expect(outcomes).toHaveLength(1);
    expect(claimRepo.getByAgent(spaceId, 'agent-1')?.state).toBe('in_flight');
    await makeService().scanSpace(spaceId);
    expect(outcomes).toHaveLength(1);
  });

  it('does not deliver or reset a claim replaced by a newer scan revision', async () => {
    configRepo.upsert({ spaceId, agentId: 'agent-1', enabled: true, thresholdMs: THRESHOLD_MS });
    let getSpaceCalls = 0;
    const service = new SpaceAgentInactivityWatchdogService({
      configRepo,
      claimRepo,
      agentRepo: agentRepo as never,
      spaceManager: {
        getSpace: mock(async () => {
          getSpaceCalls += 1;
          if (getSpaceCalls === 3) {
            configRepo.upsert({
              spaceId,
              agentId: 'agent-1',
              enabled: true,
              thresholdMs: THRESHOLD_MS,
              prompt: 'bump',
            });
            claimRepo.acquire({
              spaceId,
              agentId: 'agent-1',
              claimKey: buildInactivityNagClaimKey({
                agentId: 'agent-1',
                windowAnchoredAt: sessionSnapshot.latestConsumedMessageAt!,
                attemptGeneration: 0,
              }),
              windowAnchoredAt: sessionSnapshot.latestConsumedMessageAt!,
              attemptGeneration: 0,
              ownerToken: 'scanner-a',
              configRevision: 2,
            });
          }
          return { status: 'active', paused: false, stopped: false };
        }),
      },
      scannerToken: 'scanner-a',
      now: () => NOW,
      getSessionSnapshot: () => sessionSnapshot,
      deliverNag: async (args) => {
        outcomes.push({ idempotencyKey: args.idempotencyKey, prompt: args.prompt });
        return nextOutcome;
      },
    });
    await service.scanSpace(spaceId);
    expect(outcomes).toHaveLength(0);
    const claim = claimRepo.getByAgent(spaceId, 'agent-1');
    expect(claim?.configRevision).toBe(2);
    expect(claim?.degraded).toBe(false);
    expect(claim?.state).toBe('accepted');
  });

  it('reclaims a stale claim left behind by a crashed scanner process', async () => {
    configRepo.upsert({ spaceId, agentId: 'agent-1', enabled: true, thresholdMs: THRESHOLD_MS });
    claimRepo.acquire({
      spaceId,
      agentId: 'agent-1',
      claimKey: 'inactivity-nag:agent-1:stale:0',
      windowAnchoredAt: NOW - THRESHOLD_MS - 5000,
      attemptGeneration: 0,
      ownerToken: 'scanner-old',
      configRevision: 1,
    });
    db.prepare(
      `UPDATE space_agent_inactivity_claims SET updated_at = 1 WHERE space_id = ? AND agent_id = ?`
    ).run(spaceId, 'agent-1');
    await makeService().scanSpace(spaceId);
    expect(outcomes).toHaveLength(1);
    expect(claimRepo.getByAgent(spaceId, 'agent-1')).toBeNull();
  });
});
