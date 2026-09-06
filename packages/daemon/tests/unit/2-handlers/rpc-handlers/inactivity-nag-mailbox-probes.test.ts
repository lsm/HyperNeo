import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  RPCHandlerDependencies,
  RPCHandlerSetupResult,
} from '../../../../src/lib/rpc-handlers';
import { setupRPCHandlers } from '../../../../src/lib/rpc-handlers';
import { Database } from '../../../../src/storage/index';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import {
  SpaceAgentInactivityClaimRepository,
  SpaceAgentInactivityConfigRepository,
} from '../../../../src/storage/repositories/space-agent-inactivity-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';

const THRESHOLD_MS = 60_000;
const IDLE_SINCE_MS = 2 * 60 * 60 * 1000;
const CLAIM_LEASE_MS = 5 * 60 * 1000;

function makeTempDbPath(): string {
  return join(tmpdir(), `nag-probes-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function noopProxy(overrides: Record<string, unknown> = {}): unknown {
  const make = (): unknown =>
    new Proxy((() => {}) as unknown as () => unknown, {
      get: (_target, prop) => {
        if (typeof prop === 'string' && prop in overrides) return overrides[prop];
        if (prop === 'then') return undefined;
        if (prop === Symbol.toPrimitive) return () => '';
        return make();
      },
      apply: () => make(),
    });
  return make();
}

function mailboxPayload(
  id: string,
  sessionId: string,
  messageUuid: string,
  text: string
): Record<string, unknown> {
  return {
    id,
    to: { kind: 'session', sessionId },
    origin: 'long_term_agent',
    messageUuid,
    message: {
      type: 'user',
      message: { content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
    },
    status: 'enqueued',
    policy: { ttlMs: 86_400_000, maxAttempts: 5, priority: 0 },
    deliveryMode: 'immediate',
  };
}

type Fixture = { spaceId: string; agentId: string; sessionId: string };

describe('inactivity nag probes reconciled with mailbox admissions', () => {
  let db: Database;
  let dbPath: string;
  let setup: RPCHandlerSetupResult;
  let claimRepo: SpaceAgentInactivityClaimRepository;
  let configRepo: SpaceAgentInactivityConfigRepository;
  let deliveries: string[];
  let admittedJobIds: string[];
  let fixtureSeq = 0;

  beforeEach(async () => {
    dbPath = makeTempDbPath();
    db = new Database(dbPath);
    const reactiveDb = createReactiveDatabase(db);
    await db.initialize(reactiveDb);
    const spaceManager = noopProxy({
      listSpaces: async () => [],
      getSpace: async () => ({ id: 'space', status: 'active', paused: false, stopped: false }),
      onSpaceResumedRegister: () => {},
    });
    const deps = {
      messageHub: noopProxy(),
      sessionManager: noopProxy({ getCachedSession: () => null }),
      authManager: noopProxy(),
      settingsManager: noopProxy(),
      daemonConfigService: noopProxy(),
      config: {
        host: 'localhost',
        port: 8484,
        nodeEnv: 'test',
        dbPath,
        workspaceRoot: tmpdir(),
        defaultModel: 'claude-sonnet-4-5-20250929',
        maxTokens: 4096,
        temperature: 0.7,
      },
      internalEventBus: noopProxy(),
      commandBus: noopProxy(),
      externalEventStore: noopProxy(),
      externalEventService: noopProxy(),
      externalEventExtensionManager: noopProxy(),
      externalEventExtensionConfigStore: noopProxy(),
      externalEventExtensionContext: noopProxy(),
      db,
      spaceManager,
      jobQueue: db.getJobQueueRepo(),
      jobProcessor: noopProxy(),
      messageDeliveryProcessor: noopProxy(),
      reactiveDb,
      liveQueries: noopProxy(),
      appMcpManager: noopProxy(),
      skillsManager: noopProxy(),
      mcpImportService: noopProxy(),
    } as unknown as RPCHandlerDependencies;
    setup = setupRPCHandlers(deps);
    claimRepo = new SpaceAgentInactivityClaimRepository(db.getDatabase());
    configRepo = new SpaceAgentInactivityConfigRepository(db.getDatabase());
    deliveries = [];
    admittedJobIds = [];
    setup.spaceRuntimeService.deliverLongHorizonAgentNag = async (args) => {
      deliveries.push(args.idempotencyKey);
      const sessionId = new SpaceLongHorizonAgentRepository(db.getDatabase()).getById(
        args.agentId
      )?.sessionId;
      if (sessionId === null || sessionId === undefined) return 'terminal_failure';
      const job = db.getJobQueueRepo().enqueue({
        queue: 'mailbox',
        payload: mailboxPayload(
          `mbx-admission-${deliveries.length}`,
          sessionId,
          args.idempotencyKey,
          args.message
        ),
      });
      admittedJobIds.push(job.id);
      return 'accepted';
    };
  });

  afterEach(async () => {
    await setup.cleanup();
    try {
      db.close();
    } catch {}
    rmSync(dbPath, { force: true });
  });

  function seedWatchedAgent(): Fixture {
    fixtureSeq += 1;
    const spaceId = new SpaceRepository(db.getDatabase()).createSpace({
      workspacePath: '/w',
      slug: `w${fixtureSeq}`,
      name: `W${fixtureSeq}`,
    }).id;
    const agentId = `lh-agent-${fixtureSeq}`;
    const sessionId = `session-${fixtureSeq}`;
    const createdAt = new Date(Date.now() - IDLE_SINCE_MS).toISOString();
    db.getDatabase()
      .prepare(
        `INSERT INTO sessions
         (id, title, workspace_path, created_at, last_active_at, status, config, metadata)
         VALUES (?, 'nag probe test', '/w', ?, ?, 'active', '{}', '{}')`
      )
      .run(sessionId, createdAt, createdAt);
    db.getDatabase()
      .prepare(
        `INSERT INTO space_long_horizon_agents
         (id, space_id, handle, display_name, instructions, tool_permissions_json, session_id,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, '', '{}', ?, ?, ?)`
      )
      .run(
        agentId,
        spaceId,
        agentId,
        agentId,
        sessionId,
        Date.now() - IDLE_SINCE_MS,
        Date.now() - IDLE_SINCE_MS
      );
    configRepo.upsert({ spaceId, agentId, enabled: true, thresholdMs: THRESHOLD_MS });
    return { spaceId, agentId, sessionId };
  }

  async function scan(fixture: Fixture): Promise<void> {
    await setup.spaceAgentInactivityWatchdog.scanAgent(fixture.spaceId, fixture.agentId);
  }

  it('counts an active mailbox admission as pending delivery so scans do not double-admit', async () => {
    const fixture = seedWatchedAgent();
    const other = db.getJobQueueRepo().enqueue({
      queue: 'mailbox',
      payload: mailboxPayload(
        'mbx-other',
        fixture.sessionId,
        'unrelated-in-flight-message',
        'unrelated'
      ),
    });
    await scan(fixture);
    expect(deliveries).toHaveLength(0);
    db.getDatabase()
      .prepare(`UPDATE job_queue SET status = 'completed' WHERE id = ?`)
      .run(other.id);
    await scan(fixture);
    expect(deliveries).toHaveLength(1);
  });

  it('treats an active admission for the nag claim key as pending delivery', async () => {
    const fixture = seedWatchedAgent();
    await scan(fixture);
    expect(deliveries).toHaveLength(1);
    expect(claimRepo.getByAgent(fixture.spaceId, fixture.agentId)?.state).toBe('accepted');
    db.getDatabase()
      .prepare(
        `UPDATE space_agent_inactivity_claims SET updated_at = ?
         WHERE space_id = ? AND agent_id = ?`
      )
      .run(Date.now() - CLAIM_LEASE_MS - 10_000, fixture.spaceId, fixture.agentId);
    await scan(fixture);
    expect(deliveries).toHaveLength(1);
    const claim = claimRepo.getByAgent(fixture.spaceId, fixture.agentId);
    expect(claim?.state).toBe('accepted');
    expect(claim?.degraded).toBe(false);
  });

  it('fails the nag delivery when its admission dies without an SDK row', async () => {
    const fixture = seedWatchedAgent();
    await scan(fixture);
    expect(deliveries).toHaveLength(1);
    db.getJobQueueRepo().markDeadIfActive(admittedJobIds[0], 'retry exhausted');
    await scan(fixture);
    const claim = claimRepo.getByAgent(fixture.spaceId, fixture.agentId);
    expect(claim?.degraded).toBe(true);
    expect(claim?.attemptGeneration).toBe(1);
    expect(deliveries).toHaveLength(1);
  });

  it('suppresses the failed verdict while the admission is still active', async () => {
    const fixture = seedWatchedAgent();
    await scan(fixture);
    expect(deliveries).toHaveLength(1);
    db.getDatabase()
      .prepare(
        `INSERT INTO sdk_messages
         (id, session_id, message_type, sdk_message, timestamp, send_status, sdk_uuid)
         VALUES (?, ?, 'user', '{}', ?, 'failed', ?)`
      )
      .run(`sdk-row-${fixtureSeq}`, fixture.sessionId, new Date().toISOString(), deliveries[0]);
    await scan(fixture);
    let claim = claimRepo.getByAgent(fixture.spaceId, fixture.agentId);
    expect(claim?.state).toBe('accepted');
    expect(claim?.degraded).toBe(false);
    expect(deliveries).toHaveLength(1);
    db.getJobQueueRepo().markDeadIfActive(admittedJobIds[0], 'retry exhausted');
    await scan(fixture);
    claim = claimRepo.getByAgent(fixture.spaceId, fixture.agentId);
    expect(claim?.degraded).toBe(true);
  });
});
