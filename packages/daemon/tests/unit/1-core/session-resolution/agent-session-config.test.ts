import { describe, expect, mock, test } from 'bun:test';
import type { Session, Space, SpaceLongHorizonAgent, SpaceWorkerAgent } from '@hyperneo/shared';
import type { ActorRef } from '../../../../../messaging/src/types.ts';
import type { SessionManager } from '../../../../src/lib/session-manager.ts';
import { buildAgentSessionConfig } from '../../../../src/lib/session-resolution/agent-session-config';
import type { SpaceAgentManager } from '../../../../src/lib/space/managers/space-agent-manager.ts';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import type { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import {
  SpaceRuntimeService,
  type SpaceRuntimeServiceConfig,
} from '../../../../src/lib/space/runtime/space-runtime-service.ts';
import type { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import type { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const NOW = Date.now();

const mockSpace: Space = {
  id: 'space-1',
  slug: 'test-space',
  workspacePath: '/tmp/test-workspace',
  name: 'Test Space',
  description: '',
  backgroundContext: '',
  instructions: '',
  sessionIds: [],
  status: 'active',
  paused: false,
  stopped: false,
  maxConcurrentTasks: 3,
  createdAt: NOW,
  updatedAt: NOW,
};

const richSpace: Space = {
  ...mockSpace,
  defaultModel: 'space-default-model',
  settingSources: ['user'],
};

function makeAgent(
  id: string,
  overrides: Partial<SpaceLongHorizonAgent> = {}
): SpaceLongHorizonAgent {
  return {
    id,
    spaceId: 'space-1',
    handle: id,
    displayName: `Agent ${id}`,
    templateKey: null,
    status: 'active',
    sessionId: null,
    instructions: '',
    autonomyLevel: null,
    model: null,
    thinkingLevel: null,
    provider: null,
    settingSources: null,
    toolPermissions: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeWorker(id: string, overrides: Partial<SpaceWorkerAgent> = {}): SpaceWorkerAgent {
  return {
    id,
    spaceId: 'space-1',
    name: `Worker ${id}`,
    handle: id,
    customPrompt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as SpaceWorkerAgent;
}

function buildService(overrides: {
  sessionManager: SessionManager;
  spaceAgentManager?: SpaceAgentManager;
  longHorizonAgentRepo?: SpaceRuntimeServiceConfig['longHorizonAgentRepo'];
  space?: Space;
}): SpaceRuntimeService {
  const space = overrides.space ?? mockSpace;
  const svc = new SpaceRuntimeService({
    db: {} as BunDatabase,
    spaceManager: {
      getSpace: mock(async () => space),
      listSpaces: mock(async () => []),
    } as unknown as SpaceManager,
    spaceAgentManager: {} as SpaceAgentManager,
    spaceWorkflowManager: {} as SpaceWorkflowManager,
    workflowRunRepo: {} as SpaceWorkflowRunRepository,
    taskRepo: {} as SpaceTaskRepository,
    nodeExecutionRepo: {
      getByAgentSessionId: mock(() => null),
      getById: mock(() => null),
    } as unknown as NodeExecutionRepository,
    tickIntervalMs: 60_000,
    sessionManager: overrides.sessionManager,
    ...(overrides.spaceAgentManager ? { spaceAgentManager: overrides.spaceAgentManager } : {}),
    ...(overrides.longHorizonAgentRepo
      ? { longHorizonAgentRepo: overrides.longHorizonAgentRepo }
      : {}),
  } as SpaceRuntimeServiceConfig);
  (svc as unknown as { attachLongTermAgentMcpServers: () => void }).attachLongTermAgentMcpServers =
    () => {};
  (
    svc as unknown as { missingLongTermAgentMcpServers: () => boolean }
  ).missingLongTermAgentMcpServers = () => false;
  return svc;
}

function emptySessionManager(): SessionManager {
  return {
    getSessionAsync: mock(async () => null),
    createSession: mock(async () => undefined),
  } as unknown as SessionManager;
}

describe('buildAgentSessionConfig — long-horizon arm', () => {
  test('deterministic fixture produces the expected literal config', async () => {
    const agent = makeAgent('lh-set', {
      model: 'model-x',
      provider: 'provider-x',
      thinkingLevel: 'think8k',
      instructions: '  Own the goal.  ',
      toolPermissions: { tools: ['Read'] },
    });

    const config = await buildAgentSessionConfig({ kind: 'long_horizon', agent }, mockSpace);

    expect(config.model).toBe('model-x');
    expect(config.provider).toBe('provider-x');
    expect(config.thinkingLevel).toBe('think8k');
    expect(config.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
  });
});

describe('buildAgentSessionConfig — worker arm equivalence', () => {
  interface EnsureEntry {
    ensureLongTermAgentSession: (actor: ActorRef) => Promise<unknown>;
  }

  async function driveOldWorkerBuilder(
    worker: SpaceWorkerAgent,
    options: {
      existingSession?: boolean;
      currentConfig?: { provider: string; model: string };
      space?: Space;
    }
  ): Promise<{
    createdConfigs: Array<Partial<Session['config']>>;
    updatedConfigs: Array<Partial<Session['config']>>;
  }> {
    const createdConfigs: Array<Partial<Session['config']>> = [];
    const updatedConfigs: Array<Partial<Session['config']>> = [];
    const sessionMock = {
      getSessionData: () => ({
        id: 'sess-existing',
        metadata: {},
        config: options.currentConfig,
      }),
      updateConfig: mock(async (config: Partial<Session['config']>) => {
        updatedConfigs.push(config);
      }),
      resetQuery: mock(async () => ({ success: true })),
      mergeRuntimeMcpServers: () => {},
    };
    let lookups = 0;
    const sessionManager = {
      getSessionAsync: mock(async () => {
        lookups += 1;
        return options.existingSession || lookups > 1 ? sessionMock : null;
      }),
      createSession: mock(async (opts: { config: Partial<Session['config']> }) => {
        createdConfigs.push(opts.config);
      }),
    } as unknown as SessionManager;
    const svc = buildService({
      sessionManager,
      space: options.space,
      spaceAgentManager: { getById: mock(() => worker) } as unknown as SpaceAgentManager,
      longHorizonAgentRepo: {
        getById: mock(() => null),
        getCoordinator: mock(() => null),
        update: mock(() => ({})),
      } as unknown as SpaceLongHorizonAgentRepository,
    });
    await (svc as unknown as EnsureEntry).ensureLongTermAgentSession({
      actorId: `agent:${worker.id}`,
      kind: 'agent',
      spaceId: 'space-1',
      status: 'active',
    });
    return { createdConfigs, updatedConfigs };
  }

  test('reproduces the inline regularAgentConfig on the create path field-for-field', async () => {
    const workers = [
      makeWorker('worker-plain'),
      makeWorker('worker-rich', {
        name: 'Research Bot',
        customPrompt: 'Own the research loop.',
        tools: ['Read'],
        model: 'model-x',
        provider: 'provider-x',
        thinkingLevel: 'think16k',
        description: 'Runs research',
        settingSources: ['project'],
      }),
      makeWorker('worker-spacefallback', { model: undefined }),
    ];

    for (const worker of workers) {
      const space = worker.model === undefined ? richSpace : mockSpace;
      const { createdConfigs } = await driveOldWorkerBuilder(worker, { space });
      expect(createdConfigs).toHaveLength(1);
      const newConfig = await buildAgentSessionConfig({ kind: 'worker', agent: worker }, space);
      expect(newConfig).toEqual(createdConfigs[0]);
    }
  });

  test('reproduces the inline regularAgentConfig on the update path with current config', async () => {
    const worker = makeWorker('worker-current', { model: 'model-keep' });
    const currentConfig = { provider: 'provider-keep', model: 'model-keep' };
    const { updatedConfigs } = await driveOldWorkerBuilder(worker, {
      existingSession: true,
      currentConfig,
    });

    expect(updatedConfigs).toHaveLength(1);
    const newConfig = await buildAgentSessionConfig(
      { kind: 'worker', agent: worker },
      mockSpace,
      currentConfig
    );
    expect(newConfig).toEqual(updatedConfigs[0]);
  });

  test('deterministic worker fixture produces the expected shape', async () => {
    const worker = makeWorker('worker-shape', {
      name: 'Research Bot',
      customPrompt: 'Own the research loop.',
      tools: ['Read'],
      model: 'model-x',
      provider: 'provider-x',
      description: 'Runs research',
    });

    const config = await buildAgentSessionConfig({ kind: 'worker', agent: worker }, mockSpace);

    expect(config.model).toBe('model-x');
    expect(config.provider).toBe('provider-x');
    expect(config.sdkToolsPreset).toBeUndefined();
    expect(config.allowedTools).toBeUndefined();
    expect(config.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Own the research loop.',
    });
    expect(config.agent).toBe('research-bot');
    expect(Object.keys(config.agents ?? {})).toEqual(['research-bot']);
    expect(config.agents?.['research-bot']).toEqual({
      description: 'Runs research',
      disallowedTools: expect.any(Array),
      model: 'inherit',
      prompt: 'Own the research loop.',
    });
  });
});
