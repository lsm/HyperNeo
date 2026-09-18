import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import {
  SpaceAgentInactivityClaimRepository,
  SpaceAgentInactivityConfigRepository,
} from '../../../../src/storage/repositories/space-agent-inactivity-repository';
import { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';
import { SpaceRepository } from '../../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository';
import {
  createInactivityOperations,
  DEFAULT_INACTIVITY_THRESHOLD_MS,
} from '../../../../src/lib/external-events/inactivity-operations';
import type { OperationCaller, OperationDefinition } from '../../../../src/lib/operations/registry';
import { createSpaceTables } from '../../helpers/space-test-db';
import { createTestSession } from '../../../helpers/database';

let db: Database;
let sessions: SessionRepository;
let configRepo: SpaceAgentInactivityConfigRepository;
let claimRepo: SpaceAgentInactivityClaimRepository;
let agentRepo: SpaceLongHorizonAgentRepository;
let operations: Map<string, OperationDefinition>;
let scans: Array<{ spaceId: string; agentId: string }>;
let SPACE: string;
let OTHER_SPACE: string;
let AGENT: string;

function longTermSession(id: string, spaceId: string, status: 'active' | 'archived' = 'active') {
  sessions.createSession(
    {
      ...createTestSession(id),
      workspacePath: '/repo',
      type: 'worker',
      status,
      context: { spaceId },
    },
    { enforceWorkspaceOwnership: false }
  );
  return id;
}

function agentCaller(sessionId: string, agentId = AGENT, spaceId = SPACE): OperationCaller {
  return { source: 'mcp', sessionId, spaceId, role: 'long_term_agent', agentId };
}

function run(name: string, input: unknown, caller: OperationCaller) {
  const operation = operations.get(name);
  if (!operation) throw new Error(`operation ${name} not registered`);
  return operation.execute(input, caller);
}

beforeEach(() => {
  db = new Database(':memory:');
  createSpaceTables(db);
  const spaceRepo = new SpaceRepository(db);
  SPACE = spaceRepo.createSpace({ name: 'Watch', slug: 'watch', workspacePath: '/repo' }).id;
  OTHER_SPACE = spaceRepo.createSpace({ name: 'Away', slug: 'away', workspacePath: '/repo2' }).id;
  sessions = new SessionRepository(db);
  configRepo = new SpaceAgentInactivityConfigRepository(db);
  claimRepo = new SpaceAgentInactivityClaimRepository(db);
  agentRepo = new SpaceLongHorizonAgentRepository(db);
  AGENT = agentRepo.create({ spaceId: SPACE, handle: 'watcher' }).id;
  scans = [];
  operations = new Map(
    createInactivityOperations({
      configRepo,
      claimRepo,
      runNow: async (spaceId, agentId) => {
        scans.push({ spaceId, agentId });
      },
      getSession: (id) => sessions.getSession(id),
      taskRepo: new SpaceTaskRepository(db),
      nodeExecutionRepo: new NodeExecutionRepository(db),
      longHorizonAgentRepo: agentRepo,
    }).map((operation) => [operation.name, operation])
  );
});

afterEach(() => db.close());

describe('inactivity watchdog operations', () => {
  test('reads the agent own config and degraded flag', async () => {
    configRepo.upsert({ spaceId: SPACE, agentId: AGENT, enabled: true, thresholdMs: 1000 });
    const caller = agentCaller(longTermSession('s-agent', SPACE));
    const result = (await run('inactivity.config.get', {}, caller)) as {
      config: { thresholdMs: number | null; enabled: boolean } | null;
      degraded: boolean;
    };
    expect(result.config).toMatchObject({ thresholdMs: 1000, enabled: true });
    expect(result.degraded).toBe(false);
  });

  test('enabling restores the default threshold and clears the degraded claim', async () => {
    const caller = agentCaller(longTermSession('s-enable', SPACE));
    const enabled = (await run('inactivity.config.setEnabled', { enabled: true }, caller)) as {
      enabled: boolean;
      thresholdMs: number | null;
    };
    expect(enabled).toMatchObject({
      enabled: true,
      thresholdMs: DEFAULT_INACTIVITY_THRESHOLD_MS,
    });
    expect(configRepo.getByAgent(SPACE, AGENT)?.thresholdMs).toBe(DEFAULT_INACTIVITY_THRESHOLD_MS);
  });

  test('pausing keeps the configured threshold', async () => {
    configRepo.upsert({ spaceId: SPACE, agentId: AGENT, enabled: true, thresholdMs: 5000 });
    const caller = agentCaller(longTermSession('s-pause', SPACE));
    const paused = (await run('inactivity.config.setEnabled', { enabled: false }, caller)) as {
      enabled: boolean;
      thresholdMs: number | null;
    };
    expect(paused).toMatchObject({ enabled: false, thresholdMs: 5000 });
  });

  test('setting the threshold and prompt bumps the config revision', async () => {
    const caller = agentCaller(longTermSession('s-set', SPACE));
    const first = (await run('inactivity.config.set', { thresholdMs: 2000 }, caller)) as {
      configRevision: number;
    };
    const second = (await run('inactivity.config.set', { prompt: 'poke' }, caller)) as {
      configRevision: number;
      prompt: string | null;
    };
    expect(second.prompt).toBe('poke');
    expect(second.configRevision).toBeGreaterThan(first.configRevision);
  });

  test('runNow schedules a scan for the calling agent', async () => {
    const caller = agentCaller(longTermSession('s-run', SPACE));
    expect(await run('inactivity.runNow', {}, caller)).toEqual({ started: true });
    expect(scans).toEqual([{ spaceId: SPACE, agentId: AGENT }]);
  });

  test('reads the config of its own agent for a workflow worker caller', async () => {
    configRepo.upsert({ spaceId: SPACE, agentId: AGENT, enabled: true, thresholdMs: 5000 });
    const caller: OperationCaller = {
      source: 'mcp',
      sessionId: longTermSession('s-worker', SPACE),
      spaceId: SPACE,
      role: 'workflow_worker',
      agentId: AGENT,
    };
    const result = (await run('inactivity.config.get', {}, caller)) as {
      config: { thresholdMs: number | null } | null;
    };
    expect(result.config?.thresholdMs).toBe(5000);
  });

  test('denies an MCP caller that names another agent', async () => {
    const other = agentRepo.create({ spaceId: SPACE, handle: 'other' }).id;
    const caller = agentCaller(longTermSession('s-other', SPACE));
    expect(await run('inactivity.config.get', { agentId: other }, caller)).toBe('caller_denied');
  });

  test('rejects agent_unknown when the agent is registered in another space', async () => {
    const stranger = agentRepo.create({ spaceId: OTHER_SPACE, handle: 'stranger' }).id;
    const caller = agentCaller(longTermSession('s-stranger', SPACE), stranger);
    expect(await run('inactivity.config.get', {}, caller)).toBe('agent_unknown');
  });

  test('refuses mutations from an archived session and changes nothing', async () => {
    configRepo.upsert({ spaceId: SPACE, agentId: AGENT, enabled: false, thresholdMs: 7000 });
    const caller = agentCaller(longTermSession('s-archived', SPACE, 'archived'));
    expect(await run('inactivity.config.setEnabled', { enabled: true }, caller)).toBe(
      'session_inactive'
    );
    expect(await run('inactivity.runNow', {}, caller)).toBe('session_inactive');
    expect(configRepo.getByAgent(SPACE, AGENT)).toMatchObject({
      enabled: false,
      thresholdMs: 7000,
    });
    expect(scans).toEqual([]);
  });

  test('still admits the same archived session for reads', async () => {
    configRepo.upsert({ spaceId: SPACE, agentId: AGENT, enabled: true, thresholdMs: 7000 });
    const caller = agentCaller(longTermSession('s-archived-read', SPACE, 'archived'));
    const result = (await run('inactivity.config.get', {}, caller)) as {
      config: { thresholdMs: number | null } | null;
    };
    expect(result.config?.thresholdMs).toBe(7000);
  });

  test('an RPC caller names the space and agent explicitly', async () => {
    const rpc: OperationCaller = { source: 'rpc' };
    expect(await run('inactivity.runNow', { spaceId: SPACE, agentId: AGENT }, rpc)).toEqual({
      started: true,
    });
    expect(await run('inactivity.runNow', { agentId: AGENT }, rpc)).toBe('caller_denied');
    expect(scans).toEqual([{ spaceId: SPACE, agentId: AGENT }]);
  });
});
