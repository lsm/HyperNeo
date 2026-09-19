import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServerConfig, Session, Space } from '@hyperneo/shared';
import type { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import {
  QueryOptionsBuilder,
  type QueryOptionsBuilderContext,
} from '../../../../src/lib/agent/query-options-builder.ts';
import { operationsCapabilityContribution } from '../../../../src/lib/operations/door-briefing.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { resolveSpaceMcpSessionPolicy } from '../../../../src/lib/space/runtime/space-mcp-session-policy.ts';
import {
  SpaceRuntimeService,
  type SpaceRuntimeServiceConfig,
} from '../../../../src/lib/space/runtime/space-runtime-service.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import type { SettingsManager } from '../../../../src/lib/settings-manager.ts';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import type { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import { AgentMemoryRepository } from '../../../../src/storage/repositories/agent-memory-repository.ts';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository.ts';
import type { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import type { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import {
  makeSessionKindLongHorizonAgent,
  makeSessionKindNodeExecution,
  makeSessionKindPolicyContext,
  makeSessionKindTask,
  makeSessionOfKind,
  SESSION_KIND_SPACE_ID,
  SESSION_KINDS,
  type SessionKind,
  sessionIdForKind,
} from '../../helpers/session-kinds.ts';

const SPACE: Space = {
  id: SESSION_KIND_SPACE_ID,
  slug: 'session-kinds',
  workspacePath: '/tmp/session-kinds-ws',
  name: 'Session Kinds Space',
  description: '',
  backgroundContext: '',
  instructions: '',
  sessionIds: [],
  status: 'active',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function serverNames(session: Session): string[] {
  return Object.keys(
    (session.config.mcpServers as Record<string, McpServerConfig> | undefined) ?? {}
  ).sort();
}

function makeRecordingAgentSession(session: Session): AgentSession {
  return {
    mergeRuntimeMcpServers: (additional: Record<string, McpServerConfig>) => {
      session.config.mcpServers = {
        ...((session.config.mcpServers as Record<string, McpServerConfig> | undefined) ?? {}),
        ...additional,
      };
    },
    setRuntimeMcpServers: () => {},
    setOperationRegistryProvider: () => {},
    ensureOperationRegistryProvider: () => {},
    setCallerScopeResolver: () => {},
    setRuntimeSystemPrompt: () => {},
    getOperationsCapabilityContribution: () =>
      operationsCapabilityContribution({ type: 'sdk', instance: {} } as never),
    setSpaceBriefing: () => {},
    updateConfig: async (updates: Partial<Session['config']>) => {
      session.config = { ...session.config, ...updates };
    },
    getSessionData: () => session,
  } as unknown as AgentSession;
}

describe('session kind MCP server attachment', () => {
  let db: BunDatabase;
  let dbDir: string;
  let dbPath: string;
  let provenanceSpy: ReturnType<typeof spyOn>;
  let services: SpaceRuntimeService[];

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    dbDir = mkdtempSync(join(tmpdir(), 'hyperneo-session-kinds-'));
    dbPath = join(dbDir, 'scoped.db');
    const scoped = new BunDatabase(dbPath);
    scoped.close();
    provenanceSpy = spyOn(DirectTaskExecutionRepository.prototype, 'hasSessionProvenance');
    provenanceSpy.mockImplementation(
      (sessionId: string) => sessionId === sessionIdForKind('direct_task_worker')
    );
    services = [];
  });

  afterEach(async () => {
    for (const service of services) await service.stop();
    provenanceSpy.mockRestore();
    db.close();
    rmSync(dbDir, { recursive: true, force: true });
  });

  function buildService(kind: SessionKind, agentSession: AgentSession): SpaceRuntimeService {
    const execution = makeSessionKindNodeExecution();
    const sessionManager = {
      getCachedSession: () => agentSession,
      getSessionAsync: async () => agentSession,
      getSession: () => agentSession,
      getOperationRegistry: () => createOperationRegistry([]),
      listSessions: () => [] as Session[],
    } as unknown as SessionManager;

    const config: SpaceRuntimeServiceConfig = {
      db,
      dbPath,
      memoryRepo: new AgentMemoryRepository(db),
      spaceManager: {
        getSpace: async () => SPACE,
        listSpaces: async () => [],
      } as unknown as SpaceManager,
      spaceWorkflowManager: { listWorkflows: () => [] } as unknown as SpaceWorkflowManager,
      workflowRunRepo: {} as SpaceWorkflowRunRepository,
      taskRepo: { getTask: () => makeSessionKindTask() } as unknown as SpaceTaskRepository,
      nodeExecutionRepo: {
        getByAgentSessionId: (sessionId: string) =>
          kind === 'workflow_worker' && sessionId === sessionIdForKind('workflow_worker')
            ? execution
            : null,
        getById: () => null,
      } as unknown as NodeExecutionRepository,
      longHorizonAgentRepo: {
        getById: (agentId: string) =>
          agentId === makeSessionKindLongHorizonAgent().id
            ? makeSessionKindLongHorizonAgent()
            : null,
        listBySpaceId: () => [],
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'],
      tickIntervalMs: 60_000,
      sessionManager,
    };

    const service = new SpaceRuntimeService(config);
    services.push(service);
    return service;
  }

  describe('resolveSpaceMcpSessionPolicy', () => {
    test('assigns every session kind an owner but demands no MCP server of any of them', () => {
      const resolved = SESSION_KINDS.map((kind) => {
        const policy = resolveSpaceMcpSessionPolicy(
          makeSessionOfKind(kind),
          makeSessionKindPolicyContext(kind)
        );
        return [kind, policy.role, policy.owner, [...policy.requiredServers]];
      });

      expect(resolved).toEqual([
        ['agent_card', 'long_term_agent', 'space-runtime', []],
        ['space_chat', 'ad_hoc_member', 'space-runtime', []],
        ['ad_hoc_member', 'ad_hoc_member', 'space-runtime', []],
        ['workflow_worker', 'workflow_worker', 'task-agent-manager', []],
        ['direct_task_worker', 'direct_task_worker', 'none', []],
        ['non_space', 'universal_read', 'none', []],
      ]);
    });
  });

  describe('SpaceRuntimeService.attachSpaceToolsToMemberSession', () => {
    test('attaches agent-memory and db-query to an ad-hoc Space member and to nobody else', async () => {
      const attached: Array<[SessionKind, string[]]> = [];
      for (const kind of SESSION_KINDS) {
        const session = makeSessionOfKind(kind);
        const service = buildService(kind, makeRecordingAgentSession(session));
        await service.attachSpaceToolsToMemberSession(session, { replayPendingMessages: false });
        attached.push([kind, serverNames(session)]);
      }

      expect(attached).toEqual([
        ['agent_card', []],
        ['space_chat', []],
        ['ad_hoc_member', ['agent-memory', 'db-query']],
        ['workflow_worker', []],
        ['direct_task_worker', []],
        ['non_space', []],
      ]);
    });

    test('gates agent-memory on memoryRepo and db-query on dbPath independently', async () => {
      const withoutMemory = makeSessionOfKind('ad_hoc_member');
      const serviceWithoutMemory = buildService(
        'ad_hoc_member',
        makeRecordingAgentSession(withoutMemory)
      );
      (serviceWithoutMemory as unknown as { config: SpaceRuntimeServiceConfig }).config.memoryRepo =
        undefined;
      await serviceWithoutMemory.attachSpaceToolsToMemberSession(withoutMemory, {
        replayPendingMessages: false,
      });

      const withoutDbPath = makeSessionOfKind('ad_hoc_member');
      const serviceWithoutDbPath = buildService(
        'ad_hoc_member',
        makeRecordingAgentSession(withoutDbPath)
      );
      (serviceWithoutDbPath as unknown as { config: SpaceRuntimeServiceConfig }).config.dbPath =
        undefined;
      await serviceWithoutDbPath.attachSpaceToolsToMemberSession(withoutDbPath, {
        replayPendingMessages: false,
      });

      expect(serverNames(withoutMemory)).toEqual(['db-query']);
      expect(serverNames(withoutDbPath)).toEqual(['agent-memory']);
    });
  });

  describe('SpaceRuntimeService.reattachMemberSpaceTools', () => {
    test('attaches agent-memory and db-query to an agent-card session and to an ad-hoc member, and nothing to the rest', async () => {
      const attached: Array<[SessionKind, string[]]> = [];
      for (const kind of SESSION_KINDS) {
        const session = makeSessionOfKind(kind, {
          config: { systemPrompt: 'already built' },
        } as Partial<Session>);
        const service = buildService(kind, makeRecordingAgentSession(session));
        await service.reattachMemberSpaceTools(session.id);
        attached.push([kind, serverNames(session)]);
      }

      expect(attached).toEqual([
        ['agent_card', ['agent-memory', 'db-query']],
        ['space_chat', []],
        ['ad_hoc_member', ['agent-memory', 'db-query']],
        ['workflow_worker', []],
        ['direct_task_worker', []],
        ['non_space', []],
      ]);
    });
  });

  describe('SpaceRuntimeService.setupSpaceAgentSession', () => {
    test('attaches agent-memory and db-query to the Space chat session, which the member path skips', async () => {
      const session = makeSessionOfKind('space_chat');
      const service = buildService('space_chat', makeRecordingAgentSession(session));

      await service.setupSpaceAgentSession(SPACE, { replayPendingMessages: false });

      expect(serverNames(session)).toEqual(['agent-memory', 'db-query']);
    });
  });

  describe('TaskAgentManager.buildAgentMemoryMcpServers', () => {
    test('gives a workflow worker agent-memory only, with no db-query branch even when dbPath is set', () => {
      const manager = Object.create(TaskAgentManager.prototype, {
        config: { value: { memoryRepo: new AgentMemoryRepository(db), dbPath } },
      }) as TaskAgentManager;

      const servers = manager.buildAgentMemoryMcpServers(
        SESSION_KIND_SPACE_ID,
        sessionIdForKind('workflow_worker')
      );

      expect(Object.keys(servers).sort()).toEqual(['agent-memory']);
      expect(manager.requiredWorkflowSubSessionMcpServers()).toEqual(['agent-memory']);
    });
  });

  describe('QueryOptionsBuilder.getEffectiveMcpServers', () => {
    function makeBuilderContext(
      session: Session,
      overrides: Partial<QueryOptionsBuilderContext> = {}
    ): QueryOptionsBuilderContext {
      return {
        session,
        settingsManager: {
          getGlobalSettings: () => ({ settingSources: ['user'] }),
          prepareSDKOptions: async () => ({}),
        } as unknown as SettingsManager,
        getOperationMcpServer: () =>
          ({ type: 'sdk', name: 'hyperneo-operations' }) as unknown as ReturnType<
            NonNullable<QueryOptionsBuilderContext['getOperationMcpServer']>
          >,
        ...overrides,
      };
    }

    test('adds hyperneo-operations on top of whatever each session kind was attached', () => {
      const attachedByKind: Record<SessionKind, string[]> = {
        agent_card: ['agent-memory', 'db-query'],
        space_chat: ['agent-memory', 'db-query'],
        ad_hoc_member: ['agent-memory', 'db-query'],
        workflow_worker: ['agent-memory'],
        direct_task_worker: [],
        non_space: [],
      };

      const effective = SESSION_KINDS.map((kind) => {
        const session = makeSessionOfKind(kind);
        session.config.mcpServers = Object.fromEntries(
          attachedByKind[kind].map((name) => [name, { type: 'sdk', name, instance: {} }])
        ) as Session['config']['mcpServers'];
        const builder = new QueryOptionsBuilder(makeBuilderContext(session));
        return [kind, Object.keys(builder.getEffectiveMcpServers() ?? {}).sort()];
      });

      expect(effective).toEqual([
        ['agent_card', ['agent-memory', 'db-query', 'hyperneo-operations']],
        ['space_chat', ['agent-memory', 'db-query', 'hyperneo-operations']],
        ['ad_hoc_member', ['agent-memory', 'db-query', 'hyperneo-operations']],
        ['workflow_worker', ['agent-memory', 'hyperneo-operations']],
        ['direct_task_worker', ['hyperneo-operations']],
        ['non_space', ['hyperneo-operations']],
      ]);
    });

    test('hands build() the same set and pins strictMcpConfig so .mcp.json is never auto-loaded', async () => {
      const session = makeSessionOfKind('ad_hoc_member');
      session.config.mcpServers = {
        'agent-memory': { type: 'sdk', name: 'agent-memory', instance: {} },
      } as Session['config']['mcpServers'];
      const builder = new QueryOptionsBuilder(makeBuilderContext(session));

      const options = await builder.build();

      expect(Object.keys(options.mcpServers ?? {}).sort()).toEqual([
        'agent-memory',
        'hyperneo-operations',
      ]);
      expect(options.strictMcpConfig).toBe(true);
    });

    test('omits the operations server entirely when the context supplies no operation server factory', () => {
      const session = makeSessionOfKind('non_space');
      const context = makeBuilderContext(session);
      delete context.getOperationMcpServer;

      expect(new QueryOptionsBuilder(context).getEffectiveMcpServers()).toBeUndefined();
    });

    test('applies a space-scoped registry override only to sessions that carry that spaceId', () => {
      const registryServer = {
        id: 'registry-server-1',
        name: 'search',
        sourceType: 'stdio' as const,
        command: 'npx',
        args: ['-y', 'search-mcp'],
        env: {},
        enabled: true,
      };
      const registryContext = (session: Session): QueryOptionsBuilderContext =>
        makeBuilderContext(session, {
          appMcpServerRepo: {
            get: () => registryServer,
            list: () => [registryServer],
          } as unknown as QueryOptionsBuilderContext['appMcpServerRepo'],
          mcpEnablementRepo: {
            listForScopes: () => [
              {
                scopeType: 'space' as const,
                scopeId: SESSION_KIND_SPACE_ID,
                serverId: registryServer.id,
                enabled: false,
              },
            ],
          } as unknown as QueryOptionsBuilderContext['mcpEnablementRepo'],
        });

      const member = new QueryOptionsBuilder(
        registryContext(makeSessionOfKind('ad_hoc_member'))
      ).getEffectiveMcpServers();
      const outsider = new QueryOptionsBuilder(
        registryContext(makeSessionOfKind('non_space'))
      ).getEffectiveMcpServers();

      expect(Object.keys(member ?? {}).sort()).toEqual(['hyperneo-operations']);
      expect(Object.keys(outsider ?? {}).sort()).toEqual(['hyperneo-operations', 'search']);
    });

    test('renames the operations server when a registry server already claims the name', () => {
      const collidingServer = {
        id: 'registry-server-2',
        name: 'hyperneo-operations',
        sourceType: 'stdio' as const,
        command: 'npx',
        args: ['-y', 'impostor'],
        env: {},
        enabled: true,
      };
      const session = makeSessionOfKind('ad_hoc_member');
      const builder = new QueryOptionsBuilder(
        makeBuilderContext(session, {
          appMcpServerRepo: {
            get: () => collidingServer,
            list: () => [collidingServer],
          } as unknown as QueryOptionsBuilderContext['appMcpServerRepo'],
          mcpEnablementRepo: {
            listForScopes: () => [],
          } as unknown as QueryOptionsBuilderContext['mcpEnablementRepo'],
        })
      );

      expect(Object.keys(builder.getEffectiveMcpServers() ?? {}).sort()).toEqual([
        'hyperneo-operations',
        'hyperneo-operations-2',
      ]);
    });
  });
});
