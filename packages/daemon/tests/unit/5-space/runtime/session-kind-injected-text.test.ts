import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session, Space, SpaceWorkflow } from '@hyperneo/shared';
import { AgentSession } from '../../../../src/lib/agent/agent-session.ts';
import {
  QueryOptionsBuilder,
  type QueryOptionsBuilderContext,
} from '../../../../src/lib/agent/query-options-builder.ts';
import { createCustomAgentInit } from '../../../../src/lib/agents/custom-agent.ts';
import { buildCustomAgentTaskMessage } from '../../../../src/lib/agents/task-message.ts';
import { operationsCapabilityContribution } from '../../../../src/lib/operations/door-briefing.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { buildAgentSessionConfig } from '../../../../src/lib/session-resolution/agent-session-config.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import type { SettingsManager } from '../../../../src/lib/settings-manager.ts';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager.ts';
import type { SpaceWorkflowManager } from '../../../../src/lib/space/managers/space-workflow-manager.ts';
import {
  SpaceRuntimeService,
  type SpaceRuntimeServiceConfig,
} from '../../../../src/lib/space/runtime/space-runtime-service.ts';
import { assembleSessionBriefing } from '../../../../src/lib/briefings/assemble-session-briefing.ts';
import type { ScopeContribution } from '../../../../src/lib/briefings/contribution.ts';
import { spaceScopeContribution } from '../../../../src/lib/space/runtime/space-scope-contribution.ts';
import { createSpaceScopeResolver } from '../../../../src/lib/space/runtime/space-scope-resolver.ts';
import { AgentMemoryRepository } from '../../../../src/storage/repositories/agent-memory-repository.ts';
import { DirectTaskExecutionRepository } from '../../../../src/storage/repositories/direct-task-execution-repository.ts';
import type { NodeExecutionRepository } from '../../../../src/storage/repositories/node-execution-repository.ts';
import type { SpaceTaskRepository } from '../../../../src/storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../../../src/storage/repositories/space-workflow-run-repository.ts';
import { createTables, runMigrations } from '../../../../src/storage/schema/index.ts';
import { createTestDb, createTestInternalEventBus } from '../../../helpers/database.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import {
  makeSessionKindLongHorizonAgent,
  makeSessionKindNodeExecution,
  makeSessionKindPolicyContext,
  makeSessionKindTask,
  makeSessionOfKind,
  SESSION_KIND_AGENT_ID,
  SESSION_KIND_SPACE_ID,
  SESSION_KINDS,
  type SessionKind,
  sessionIdForKind,
} from '../../helpers/session-kinds.ts';

const SPACE_NAME = 'Session Kinds Space';
const SPACE_INSTRUCTIONS = 'Ship the smallest slice that stands alone.';
const SPACE_BACKGROUND = 'The board is the record of truth.';
const CARD_AGENT_INSTRUCTIONS = 'Triage the board and keep every task honest.';
const WORKER_AGENT_INSTRUCTIONS = 'Implement the task and open exactly one PR.';
const WORKSPACE_PATH = '/tmp/session-kinds-ws';

const OPERATIONS_CONTRIBUTION = operationsCapabilityContribution({
  type: 'sdk',
  instance: {},
} as never);

const SPACE: Space = {
  id: SESSION_KIND_SPACE_ID,
  slug: 'session-kinds',
  workspacePath: WORKSPACE_PATH,
  name: SPACE_NAME,
  description: '',
  backgroundContext: SPACE_BACKGROUND,
  instructions: SPACE_INSTRUCTIONS,
  sessionIds: [],
  status: 'active',
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const WORKFLOW: SpaceWorkflow = {
  id: 'workflow-kinds-1',
  spaceId: SESSION_KIND_SPACE_ID,
  name: 'Coder owned',
  handle: 'coder-owned',
  description: '',
  instructions: 'Every handoff carries a PR url.',
  nodes: [
    { id: 'node-kinds-1', name: 'coder', agentName: 'coder' },
    { id: 'node-kinds-2', name: 'reviewer', agentName: 'reviewer' },
  ],
  channels: [{ from: 'coder', to: 'reviewer', label: 'hand off the PR' }],
  hooks: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
} as unknown as SpaceWorkflow;

const TEXT_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ['space-identity', `the Space "${SPACE_NAME}" (id: ${SESSION_KIND_SPACE_ID})`],
  ['card-agent-role', 'Your role in it is the Space agent "Card Agent".'],
  [
    'ad-hoc-role',
    'You are an ad-hoc member session: this Space has not assigned you an agent role.',
  ],
  [
    'workflow-worker-role',
    'Your role in it is a worker session running one node of a Space workflow for an assigned task.',
  ],
  [
    'direct-task-worker-role',
    'Your role in it is a worker session running one assigned Space task directly, outside any workflow.',
  ],
  ['operations-door-tool', 'mcp__hyperneo-operations__invoke'],
  ['operations-discovery', 'List the operations before concluding that a capability is missing'],
  ['space-standing-instructions', SPACE_INSTRUCTIONS],
  ['space-background-context', SPACE_BACKGROUND],
  ['card-agent-instructions', CARD_AGENT_INSTRUCTIONS],
  ['owner-review-contract', 'Goal Ownership & Outcome Review Contract'],
  ['scheduling-guardrail', 'Scheduling & Task Systems'],
  ['worker-agent-instructions', WORKER_AGENT_INSTRUCTIONS],
  ['task-heading', '## Your Task #1'],
  ['runtime-location', '- Worktree: /tmp/session-kinds-ws'],
  ['workflow-role', `- Workflow: ${WORKFLOW.name}`],
  ['workflow-standing-instructions', 'Every handoff carries a PR url.'],
];

function markersIn(text: string): string[] {
  return TEXT_MARKERS.filter(([, fragment]) => text.includes(fragment)).map(([name]) => name);
}

type BuiltSystemPrompt =
  | string
  | { type?: string; preset?: string; append?: string }
  | undefined
  | null;

function describeSystemPrompt(prompt: BuiltSystemPrompt): { shape: string; says: string[] } {
  if (prompt === undefined || prompt === null) return { shape: 'none', says: [] };
  if (typeof prompt === 'string') return { shape: 'plain-string', says: markersIn(prompt) };
  if (prompt.preset === 'claude_code' && prompt.append === undefined) {
    return { shape: 'claude-code-preset', says: [] };
  }
  return { shape: 'claude-code-preset+append', says: markersIn(prompt.append ?? '') };
}

function cardAgent() {
  return makeSessionKindLongHorizonAgent({
    instructions: CARD_AGENT_INSTRUCTIONS,
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
  });
}

function workerAgent() {
  return makeSessionKindLongHorizonAgent({
    id: 'agent-worker-kinds-1',
    displayName: 'Coder',
    handle: 'coder',
    instructions: WORKER_AGENT_INSTRUCTIONS,
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
  });
}

function makeRecordingAgentSession(session: Session): AgentSession {
  return {
    mergeRuntimeMcpServers: () => {},
    setRuntimeMcpServers: () => {},
    setOperationRegistryProvider: () => {},
    ensureOperationRegistryProvider: () => {},
    setCallerScopeResolver: () => {},
    setSpaceScopeResolver: () => {},
    setRuntimeSystemPrompt: () => {},
    updateConfig: async (updates: Partial<Session['config']>) => {
      session.config = { ...session.config, ...updates };
    },
    getSessionData: () => session,
  } as unknown as AgentSession;
}

function scopeFor(kind: SessionKind, session: Session): ScopeContribution | undefined {
  return createSpaceScopeResolver({
    ...makeSessionKindPolicyContext(kind),
    getSession: (id) => (id === session.id ? session : null),
    getSpace: (id) => (id === SPACE.id ? SPACE : null),
  })(session.id);
}

function briefingFor(kind: SessionKind, session: Session): string | undefined {
  const scope = scopeFor(kind, session);
  if (!scope) return undefined;
  return assembleSessionBriefing({ scope: [scope], capabilities: [OPERATIONS_CONTRIBUTION] }).text;
}

function seedCreationConfig(kind: SessionKind, session: Session): void {
  if (kind === 'workflow_worker') {
    const init = createCustomAgentInit({
      customAgent: workerAgent(),
      task: makeSessionKindTask(),
      workflowRun: null,
      workflow: WORKFLOW,
      space: SPACE,
      sessionId: session.id,
      workspacePath: WORKSPACE_PATH,
    });
    session.config = AgentSession.createSessionFromInit(init, 'claude-sonnet-4-6').config;
  }
  if (kind === 'direct_task_worker') {
    session.config = AgentSession.createSessionFromInit(
      {
        sessionId: session.id,
        title: 'Session kinds task',
        workspacePath: WORKSPACE_PATH,
        type: 'worker',
        context: { spaceId: SESSION_KIND_SPACE_ID, taskId: makeSessionKindTask().id },
      },
      'claude-sonnet-4-6'
    ).config;
  }
}

describe('session kind injected text', () => {
  let db: BunDatabase;
  let dbDir: string;
  let dbPath: string;
  let provenanceSpy: ReturnType<typeof spyOn>;
  let services: SpaceRuntimeService[];

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    runMigrations(db, () => {});
    createTables(db);
    dbDir = mkdtempSync(join(tmpdir(), 'hyperneo-session-text-'));
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
        getById: (agentId: string) => (agentId === SESSION_KIND_AGENT_ID ? cardAgent() : null),
        listBySpaceId: () => [],
      } as unknown as SpaceRuntimeServiceConfig['longHorizonAgentRepo'],
      tickIntervalMs: 60_000,
      sessionManager,
    };

    const service = new SpaceRuntimeService(config);
    services.push(service);
    return service;
  }

  async function provision(
    kind: SessionKind
  ): Promise<{ session: Session; briefing: string | undefined }> {
    const session = makeSessionOfKind(kind);
    seedCreationConfig(kind, session);
    const service = buildService(kind, makeRecordingAgentSession(session));
    await service.reattachMemberSpaceTools(session.id);
    return { session, briefing: briefingFor(kind, session) };
  }

  function makeBuilderContext(
    session: Session,
    briefing: string | undefined
  ): QueryOptionsBuilderContext {
    return {
      session,
      settingsManager: {
        getGlobalSettings: () => ({ settingSources: ['user'] }),
        prepareSDKOptions: async () => ({}),
      } as unknown as SettingsManager,
      getSpaceBriefing: () => briefing,
    };
  }

  describe('spaceScopeContribution', () => {
    test('assembles the Space scope and the operations door as two contributions for a Space agent', () => {
      const briefing = assembleSessionBriefing({
        scope: [
          spaceScopeContribution({
            spaceId: SPACE.id,
            spaceName: SPACE.name,
            role: 'long_term_agent',
            agentDisplayName: 'Card Agent',
            spaceInstructions: SPACE.instructions,
          }),
        ],
        capabilities: [OPERATIONS_CONTRIBUTION],
      }).text;

      expect(briefing).toBe(
        [
          '## Your Space',
          '',
          `You are working inside the Space "${SPACE_NAME}" (id: ${SESSION_KIND_SPACE_ID}) — a shared workspace with its own tasks, goals, agents, and workflows. Your role in it is the Space agent "Card Agent".`,
          '',
          '### Space Standing Instructions',
          '',
          SPACE_INSTRUCTIONS,
          '',
          '### Acting in the Space',
          '',
          'Space work does not go through your local tools. The `hyperneo-operations` MCP server exposes a single tool, `mcp__hyperneo-operations__invoke`, and every Space capability you have is reached through it:',
          '',
          '- `invoke(name="operations.list")` — lists the operations available to you here, one line each.',
          '- `invoke(name="operations.describe", input={"name":"<operation>"})` — returns that operation\'s input and result schemas.',
          '- `invoke(name="<operation>", input={...})` — runs it.',
          '',
          "List the operations before concluding that a capability is missing; a capability you do not have is simply absent from that list. The SDK's built-in `Task*` tools are a within-turn scratchpad and are invisible to the rest of the Space.",
        ].join('\n')
      );
    });

    test('tells an ad-hoc member it has no agent role, and drops the standing instructions when the Space has none', () => {
      const briefing = assembleSessionBriefing({
        scope: [
          spaceScopeContribution({
            spaceId: SPACE.id,
            spaceName: SPACE.name,
            role: 'ad_hoc_member',
            spaceInstructions: '',
          }),
        ],
        capabilities: [OPERATIONS_CONTRIBUTION],
      }).text;

      expect(briefing.startsWith('## Your Space\n\n')).toBe(true);
      expect(briefing).toContain(
        `You are working inside the Space "${SPACE_NAME}" (id: ${SESSION_KIND_SPACE_ID})`
      );
      expect(briefing).toContain(
        'You are an ad-hoc member session: this Space has not assigned you an agent role.'
      );
      expect(briefing).toContain('mcp__hyperneo-operations__invoke');
      expect(briefing).not.toContain('### Space Standing Instructions');
      expect(briefing).not.toContain('Card Agent');
    });

    test('puts the whole Space scope ahead of the operations door, which now trails as a capability', () => {
      const briefing = assembleSessionBriefing({
        scope: [
          spaceScopeContribution({
            spaceId: SPACE.id,
            spaceName: SPACE.name,
            role: 'long_term_agent',
            agentDisplayName: 'Card Agent',
            spaceInstructions: SPACE.instructions,
          }),
        ],
        capabilities: [OPERATIONS_CONTRIBUTION],
      }).text;

      expect(briefing.indexOf('## Your Space')).toBeLessThan(
        briefing.indexOf('### Space Standing Instructions')
      );
      expect(briefing.indexOf('### Space Standing Instructions')).toBeLessThan(
        briefing.indexOf('### Acting in the Space')
      );
      expect(briefing.endsWith(OPERATIONS_CONTRIBUTION.briefing.trim())).toBe(true);
    });

    test('carries the operations door as the authored briefing of the attached server', () => {
      const briefing = assembleSessionBriefing({
        scope: [
          spaceScopeContribution({
            spaceId: SPACE.id,
            spaceName: SPACE.name,
            role: 'ad_hoc_member',
            spaceInstructions: '',
          }),
        ],
        capabilities: [OPERATIONS_CONTRIBUTION],
      }).text;

      expect(OPERATIONS_CONTRIBUTION.server.name).toBe('hyperneo-operations');
      expect(briefing).toContain(OPERATIONS_CONTRIBUTION.briefing.trim());
    });
  });

  describe('Space scope reaching each session kind', () => {
    test('resolves a Space scope for every session kind that carries a Space, and for nobody else', async () => {
      const resolved: Array<{ kind: SessionKind; scope: string; says: string[] }> = [];
      for (const kind of SESSION_KINDS) {
        const { briefing } = await provision(kind);
        resolved.push({
          kind,
          scope: briefing === undefined ? 'none' : 'resolved',
          says: briefing === undefined ? [] : markersIn(briefing),
        });
      }

      expect(resolved).toEqual([
        {
          kind: 'agent_card',
          scope: 'resolved',
          says: [
            'space-identity',
            'card-agent-role',
            'operations-door-tool',
            'operations-discovery',
            'space-standing-instructions',
          ],
        },
        {
          kind: 'space_chat',
          scope: 'resolved',
          says: [
            'space-identity',
            'ad-hoc-role',
            'operations-door-tool',
            'operations-discovery',
            'space-standing-instructions',
          ],
        },
        {
          kind: 'ad_hoc_member',
          scope: 'resolved',
          says: [
            'space-identity',
            'ad-hoc-role',
            'operations-door-tool',
            'operations-discovery',
            'space-standing-instructions',
          ],
        },
        {
          kind: 'workflow_worker',
          scope: 'resolved',
          says: [
            'space-identity',
            'workflow-worker-role',
            'operations-door-tool',
            'operations-discovery',
            'space-standing-instructions',
          ],
        },
        {
          kind: 'direct_task_worker',
          scope: 'resolved',
          says: [
            'space-identity',
            'direct-task-worker-role',
            'operations-door-tool',
            'operations-discovery',
            'space-standing-instructions',
          ],
        },
        { kind: 'non_space', scope: 'none', says: [] },
      ]);
    });

    test('names the Space for a Space chat session, which the query builder still discards (#4795)', async () => {
      const session = makeSessionOfKind('space_chat');
      const service = buildService('space_chat', makeRecordingAgentSession(session));

      await service.setupSpaceAgentSession(SPACE, { replayPendingMessages: false });
      const briefing = briefingFor('space_chat', session);
      const options = await new QueryOptionsBuilder(makeBuilderContext(session, briefing)).build();

      expect(briefing).toContain(`the Space "${SPACE_NAME}" (id: ${SESSION_KIND_SPACE_ID})`);
      expect(options.systemPrompt).toBeUndefined();
    });

    test('tells a direct task worker which Space its session carries (#4807)', async () => {
      const { session, briefing } = await provision('direct_task_worker');

      expect(session.context?.spaceId).toBe(SESSION_KIND_SPACE_ID);
      expect(briefing).toContain(`the Space "${SPACE_NAME}" (id: ${SESSION_KIND_SPACE_ID})`);
      expect(briefing).toContain(
        'Your role in it is a worker session running one assigned Space task directly, outside any workflow.'
      );
      expect(briefing).toContain('mcp__hyperneo-operations__invoke');
    });

    test('writes the agent-card role prompt into the session config alongside the briefing', async () => {
      const { session } = await provision('agent_card');

      expect(describeSystemPrompt(session.config.systemPrompt as BuiltSystemPrompt)).toEqual({
        shape: 'claude-code-preset+append',
        says: ['card-agent-instructions', 'owner-review-contract', 'scheduling-guardrail'],
      });
    });
  });

  describe('AgentSession.getSpaceBriefing', () => {
    test('assembles the resolved scope with the operations door, and stays silent without one', async () => {
      const wrapped = await createTestDb();
      const session = makeSessionOfKind('direct_task_worker');
      const agentSession = new AgentSession(
        session,
        wrapped,
        {} as never,
        await createTestInternalEventBus(),
        async () => null
      );

      const beforeResolver = agentSession.getSpaceBriefing();
      agentSession.setSpaceScopeResolver((sessionId) =>
        sessionId === session.id ? scopeFor('direct_task_worker', session) : undefined
      );
      const afterResolver = agentSession.getSpaceBriefing();
      await agentSession.cleanup();

      expect(beforeResolver).toBeUndefined();
      expect(markersIn(afterResolver ?? '')).toEqual([
        'space-identity',
        'direct-task-worker-role',
        'operations-door-tool',
        'operations-discovery',
        'space-standing-instructions',
      ]);
    });
  });

  describe('QueryOptionsBuilder.build', () => {
    test('assembles the text each session kind hands the model', async () => {
      const assembled: Array<{ kind: SessionKind; shape: string; says: string[] }> = [];
      for (const kind of SESSION_KINDS) {
        const { session, briefing } = await provision(kind);
        const options = await new QueryOptionsBuilder(
          makeBuilderContext(session, briefing)
        ).build();
        assembled.push({
          kind,
          ...describeSystemPrompt(options.systemPrompt as BuiltSystemPrompt),
        });
      }

      expect(assembled).toEqual([
        {
          kind: 'agent_card',
          shape: 'claude-code-preset+append',
          says: [
            'space-identity',
            'card-agent-role',
            'operations-door-tool',
            'operations-discovery',
            'space-standing-instructions',
            'card-agent-instructions',
            'owner-review-contract',
            'scheduling-guardrail',
          ],
        },
        { kind: 'space_chat', shape: 'none', says: [] },
        {
          kind: 'ad_hoc_member',
          shape: 'claude-code-preset+append',
          says: [
            'space-identity',
            'ad-hoc-role',
            'operations-door-tool',
            'operations-discovery',
            'space-standing-instructions',
          ],
        },
        {
          kind: 'workflow_worker',
          shape: 'claude-code-preset+append',
          says: [
            'space-identity',
            'workflow-worker-role',
            'operations-door-tool',
            'operations-discovery',
            'space-standing-instructions',
            'worker-agent-instructions',
          ],
        },
        {
          kind: 'direct_task_worker',
          shape: 'claude-code-preset+append',
          says: [
            'space-identity',
            'direct-task-worker-role',
            'operations-door-tool',
            'operations-discovery',
            'space-standing-instructions',
          ],
        },
        { kind: 'non_space', shape: 'claude-code-preset', says: [] },
      ]);
    });

    test('keeps every host-authored prompt unrecorded so a resumed session re-reads it (#4824)', async () => {
      const recording: Array<{ kind: SessionKind; recorded: boolean | 'none' }> = [];
      for (const kind of SESSION_KINDS) {
        const { session, briefing } = await provision(kind);
        const options = await new QueryOptionsBuilder(
          makeBuilderContext(session, briefing)
        ).build();
        const prompt = options.systemPrompt as { snapshot?: boolean } | undefined;
        recording.push({
          kind,
          recorded: prompt === undefined ? 'none' : prompt.snapshot !== false,
        });
      }

      expect(recording).toEqual([
        { kind: 'agent_card', recorded: false },
        { kind: 'space_chat', recorded: 'none' },
        { kind: 'ad_hoc_member', recorded: false },
        { kind: 'workflow_worker', recorded: false },
        { kind: 'direct_task_worker', recorded: false },
        { kind: 'non_space', recorded: true },
      ]);
    });

    test('puts the agent role prompt ahead of the Space briefing for an agent-card session', async () => {
      const { session, briefing } = await provision('agent_card');

      const options = await new QueryOptionsBuilder(makeBuilderContext(session, briefing)).build();

      const append = (options.systemPrompt as { append?: string }).append ?? '';
      expect(append.indexOf(CARD_AGENT_INSTRUCTIONS)).toBeLessThan(append.indexOf('## Your Space'));
      expect(append.indexOf('Goal Ownership & Outcome Review Contract')).toBeLessThan(
        append.indexOf('mcp__hyperneo-operations__invoke')
      );
    });

    test('drops a Space briefing that is installed on a Space chat session, and keeps the same one on a worker session', async () => {
      const briefing = assembleSessionBriefing({
        scope: [
          spaceScopeContribution({
            spaceId: SPACE.id,
            spaceName: SPACE.name,
            role: 'ad_hoc_member',
            spaceInstructions: SPACE.instructions,
          }),
        ],
        capabilities: [OPERATIONS_CONTRIBUTION],
      }).text;

      const chat = await new QueryOptionsBuilder(
        makeBuilderContext(makeSessionOfKind('space_chat'), briefing)
      ).build();
      const member = await new QueryOptionsBuilder(
        makeBuilderContext(makeSessionOfKind('ad_hoc_member'), briefing)
      ).build();

      expect(chat.systemPrompt).toBeUndefined();
      expect((member.systemPrompt as { append?: string }).append).toContain(
        `You are working inside the Space "${SPACE_NAME}"`
      );
    });
  });

  describe('buildAgentSessionConfig', () => {
    test('joins the agent instructions to the owner-review and scheduling contracts and adds no Space identity', async () => {
      const config = await buildAgentSessionConfig({ agent: cardAgent() }, SPACE);

      const append = (config.systemPrompt as { append?: string }).append ?? '';
      expect(markersIn(append)).toEqual([
        'card-agent-instructions',
        'owner-review-contract',
        'scheduling-guardrail',
      ]);
      expect(append.startsWith(`${CARD_AGENT_INSTRUCTIONS}\n\n`)).toBe(true);
    });
  });

  describe('buildCustomAgentTaskMessage', () => {
    test('gives a direct task worker the task, the workspace and the Space prose, but never the Space identity or the operations door', () => {
      const message = buildCustomAgentTaskMessage({
        task: makeSessionKindTask({ description: 'Pin what the model receives.' }),
        space: SPACE,
        workspacePath: WORKSPACE_PATH,
      });

      expect(markersIn(message)).toEqual([
        'space-standing-instructions',
        'space-background-context',
        'task-heading',
        'runtime-location',
      ]);
      expect(message).toContain('**Title:** Session kinds task');
      expect(message).toContain('**Description:** Pin what the model receives.');
      expect(message).not.toContain('## Your Role in This Workflow');
    });

    test('adds the workflow role section for a workflow worker and still never names the operations door', () => {
      const message = buildCustomAgentTaskMessage({
        task: makeSessionKindTask({ description: 'Pin what the model receives.' }),
        space: SPACE,
        workflow: WORKFLOW,
        workflowRun: null,
        nodeId: 'node-kinds-1',
        agentSlotName: 'coder',
        workspacePath: WORKSPACE_PATH,
      });

      expect(markersIn(message)).toEqual([
        'space-standing-instructions',
        'space-background-context',
        'task-heading',
        'runtime-location',
        'workflow-role',
        'workflow-standing-instructions',
      ]);
      expect(message).toContain('## Your Role in This Workflow');
      expect(message).toContain('- Node: coder');
      expect(message).toContain('- Peers: reviewer');
    });
  });
});
