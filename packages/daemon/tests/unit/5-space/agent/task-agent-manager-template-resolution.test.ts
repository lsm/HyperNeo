import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { PRESET_CODER_PROMPT, REVIEWER_SYSTEM_CONTRACT } from '@hyperneo/prompts';
import type {
  NodeExecution,
  Space,
  SpaceAgentTemplate,
  SpaceLongHorizonAgent,
  SpaceTask,
  SpaceWorkflow,
  SpaceWorkflowRun,
  WorkflowNode,
  WorkflowNodeAgent,
  WorkflowTemplateSnapshot,
} from '@hyperneo/shared';
import type { AgentSession, AgentSessionInit } from '../../../../src/lib/agent/agent-session.ts';
import type { DaemonInternalEventMap } from '../../../../src/lib/internal-event-bus.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type {
  NodeAgentSpawnConfig,
  NodeAgentTemplateSource,
} from '../../../../src/lib/space/runtime/spawn-slot-resolution.ts';
import type { TaskAgentManagerConfig } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import {
  createAgentTemplateResolver,
  toRunTemplateSnapshot,
  withRunTemplateSnapshots,
} from '../../../../src/lib/space/workflows/run-template-snapshot.ts';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

const TASK_ID = 'task-3832';
const RUN_ID = 'run-3832';
const SPACE_ID = 'space-3832';
const NODE_ID = 'node-coder';
const SPAWNED_SESSION_ID = 'spawned-session-3832';

function makeExecution(agentName: string): NodeExecution {
  return {
    id: 'exec-3832',
    workflowRunId: RUN_ID,
    workflowNodeId: NODE_ID,
    agentName,
    agentId: null,
    agentSessionId: null,
    status: 'pending',
    result: null,
    data: null,
    createdAt: 1,
    startedAt: null,
    completedAt: null,
    updatedAt: 1,
    lastActivityAt: null,
  };
}

function makeTask(): SpaceTask {
  return {
    id: TASK_ID,
    spaceId: SPACE_ID,
    workflowRunId: RUN_ID,
    title: 'Pin template resolution',
    description: 'Characterize the template resolution and spawn payload',
    taskNumber: 3832,
    status: 'in_progress',
  } as unknown as SpaceTask;
}

function makeTemplateWorkflowNode(slot: Partial<WorkflowNodeAgent> = {}): WorkflowNode {
  const agentName = slot.name ?? 'coder';
  return {
    id: NODE_ID,
    name: agentName,
    agents: [
      {
        agentId: '',
        templateKey: 'worker.swe',
        name: agentName,
        ...slot,
      },
    ],
  } as unknown as WorkflowNode;
}

function makeWorkflow(node: WorkflowNode): SpaceWorkflow {
  return {
    id: 'wf-3832',
    spaceId: SPACE_ID,
    name: 'Coding',
    nodes: [node, { id: 'node-reviewer', name: 'reviewer', agents: [] }],
    channels: [],
    startNodeId: node.id,
    endNodeId: 'node-reviewer',
  } as unknown as SpaceWorkflow;
}

function makeStoredTemplate(overrides: Partial<SpaceAgentTemplate> = {}): SpaceAgentTemplate {
  return {
    key: 'custom.stored',
    handle: 'stored-agent',
    displayName: 'Stored Agent',
    description: 'A stored space agent template.',
    instructions: 'Stored template instructions',
    suggestedAutonomyLevel: 2,
    model: 'stored-model',
    provider: 'openrouter',
    modelPool: null,
    thinkingLevel: 'think8k',
    settingSources: ['project'],
    tools: ['Read', 'Grep'],
    labels: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeRegistryAgent(overrides: Partial<SpaceLongHorizonAgent> = {}): SpaceLongHorizonAgent {
  return {
    id: 'agent-registry-1',
    spaceId: SPACE_ID,
    handle: 'registry-agent',
    displayName: 'Registry Agent',
    templateKey: null,
    status: 'active',
    sessionId: null,
    instructions: 'Registry agent instructions',
    autonomyLevel: null,
    model: null,
    thinkingLevel: null,
    provider: null,
    settingSources: null,
    toolPermissions: {},
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

interface TemplateResolutionHarness {
  tam: TaskAgentManager;
  templateRepoCalls: string[];
  pinnedLookupCalls: string[];
  internals: {
    resolveNodeTemplateSource: (key: string) => NodeAgentTemplateSource | null;
    resolveSlotSpawnConfig: (
      spaceId: string,
      slot: WorkflowNodeAgent,
      workflowRun?: Pick<SpaceWorkflowRun, 'workflowId' | 'definitionVersion'> | null
    ) => NodeAgentSpawnConfig | null;
  };
}

function makeTemplateResolutionHarness(
  options: {
    storedTemplates?: SpaceAgentTemplate[];
    registryAgents?: SpaceLongHorizonAgent[];
    pinnedWorkflows?: Record<string, SpaceWorkflow | null>;
  } = {}
): TemplateResolutionHarness {
  const templateRepoCalls: string[] = [];
  const pinnedLookupCalls: string[] = [];
  const stored = new Map((options.storedTemplates ?? []).map((t) => [t.key, t]));
  const registryAgents = options.registryAgents ?? [];

  const tam = new TaskAgentManager({
    db: { getDatabase: () => new BunDatabase(':memory:'), getSession: () => null },
    sessionManager: { registerSession: () => {}, getSession: () => undefined },
    internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
    taskRepo: {},
    nodeExecutionRepo: {},
    spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
    spaceWorkflowManager: {
      getWorkflowForRun: (run: { definitionVersion: string | null }) => {
        pinnedLookupCalls.push(run.definitionVersion ?? '');
        return options.pinnedWorkflows?.[run.definitionVersion ?? ''] ?? null;
      },
    },
    longHorizonAgentRepo: {
      getById: (id: string) => registryAgents.find((agent) => agent.id === id) ?? null,
    },
    templateRepo: {
      getByKey: (_spaceId: string, key: string) => {
        templateRepoCalls.push(key);
        return stored.get(key) ?? null;
      },
    },
  } as unknown as TaskAgentManagerConfig);

  return {
    tam,
    templateRepoCalls,
    pinnedLookupCalls,
    internals: tam as unknown as TemplateResolutionHarness['internals'],
  };
}

describe('resolveNodeTemplateSource ordering (ATC-1 pin)', () => {
  test('resolves a code built-in worker template without consulting the template repo', () => {
    const h = makeTemplateResolutionHarness({
      storedTemplates: [makeStoredTemplate({ key: 'worker.swe' })],
    });

    const source = h.internals.resolveNodeTemplateSource('worker.swe');

    expect(source?.key).toBe('worker.swe');
    expect(source?.handle).toBe('swe');
    expect(source?.instructions).toBe(PRESET_CODER_PROMPT);
    expect(h.templateRepoCalls).toEqual([]);
  });

  test('resolves a code built-in family template without consulting the template repo', () => {
    const h = makeTemplateResolutionHarness({
      storedTemplates: [makeStoredTemplate({ key: 'coordinator.default' })],
    });

    const source = h.internals.resolveNodeTemplateSource('coordinator.default');

    expect(source?.key).toBe('coordinator.default');
    expect(source?.handle).toBe('space-manager');
    expect(h.templateRepoCalls).toEqual([]);
  });

  test('falls back to templateRepo.getByKey for a stored template and maps it to a node source', () => {
    const h = makeTemplateResolutionHarness({
      storedTemplates: [makeStoredTemplate()],
    });

    const source = h.internals.resolveNodeTemplateSource('custom.stored');

    expect(h.templateRepoCalls).toEqual(['custom.stored']);
    expect(source?.key).toBe('custom.stored');
    expect(source?.instructions).toBe('Stored template instructions');
    expect(source?.model).toBe('stored-model');
    expect(source?.provider).toBe('openrouter');
    expect(source?.thinkingLevel).toBe('think8k');
    expect(source?.toolPermissions).toEqual({ tools: ['Read', 'Grep'] });
    expect(source?.suggestedEventSubscriptions).toEqual([]);
    expect(source?.reminderDefaults).toEqual([]);
    expect(source?.ownershipPatterns).toEqual([]);
  });

  test('the code built-in wins when a stored template shadows a built-in key', () => {
    const h = makeTemplateResolutionHarness({
      storedTemplates: [makeStoredTemplate({ key: 'worker.swe' })],
    });

    const source = h.internals.resolveNodeTemplateSource('worker.swe');

    expect(source?.instructions).toBe(PRESET_CODER_PROMPT);
    expect(source?.instructions).not.toBe('Stored template instructions');
    expect(h.templateRepoCalls).toEqual([]);
  });

  test('returns null for an unknown key after one repo lookup', () => {
    const h = makeTemplateResolutionHarness();

    expect(h.internals.resolveNodeTemplateSource('missing.template')).toBeNull();
    expect(h.templateRepoCalls).toEqual(['missing.template']);
  });
});

describe('resolveSlotSpawnConfig branch selection (ATC-1 pin)', () => {
  test('templateKey branch: spawns an ephemeral template agent for a built-in worker key', () => {
    const h = makeTemplateResolutionHarness();

    const config = h.internals.resolveSlotSpawnConfig(SPACE_ID, {
      agentId: '',
      templateKey: 'worker.swe',
      name: 'coder',
    });

    expect(config?.source).toBe('template');
    expect(config?.templateKey).toBe('worker.swe');
    expect(config?.agent.id).toBe('template:worker.swe');
    expect(config?.agent.displayName).toBe('coder');
    expect(config?.agent.instructions).toBe(PRESET_CODER_PROMPT);
  });

  test('templateKey branch: trims surrounding whitespace before resolving', () => {
    const h = makeTemplateResolutionHarness();

    const config = h.internals.resolveSlotSpawnConfig(SPACE_ID, {
      agentId: '',
      templateKey: '  worker.swe  ',
      name: 'coder',
    });

    expect(config?.source).toBe('template');
    expect(config?.templateKey).toBe('worker.swe');
  });

  test('templateKey branch: slot model and thinking level override the template fields', () => {
    const h = makeTemplateResolutionHarness();

    const config = h.internals.resolveSlotSpawnConfig(SPACE_ID, {
      agentId: '',
      templateKey: 'worker.swe',
      name: 'coder',
      model: 'slot-model',
      thinkingLevel: 'think32k',
    });

    expect(config?.agent.model).toBe('slot-model');
    expect(config?.agent.thinkingLevel).toBe('think32k');
  });

  test('templateKey branch: a stored template key spawns from the repo copy', () => {
    const h = makeTemplateResolutionHarness({
      storedTemplates: [makeStoredTemplate()],
    });

    const config = h.internals.resolveSlotSpawnConfig(SPACE_ID, {
      agentId: '',
      templateKey: 'custom.stored',
      name: 'stored',
    });

    expect(config?.source).toBe('template');
    expect(config?.agent.id).toBe('template:custom.stored');
    expect(config?.agent.instructions).toBe('Stored template instructions');
    expect(config?.agent.model).toBe('stored-model');
    expect(config?.agent.toolPermissions).toEqual({ tools: ['Read', 'Grep'] });
  });

  test('an unresolvable templateKey with no agentId yields null', () => {
    const h = makeTemplateResolutionHarness();

    const config = h.internals.resolveSlotSpawnConfig(SPACE_ID, {
      agentId: '',
      templateKey: 'missing.template',
      name: 'coder',
    });

    expect(config).toBeNull();
  });

  test('a whitespace-only templateKey is not treated as a template branch entry', () => {
    const h = makeTemplateResolutionHarness();

    const config = h.internals.resolveSlotSpawnConfig(SPACE_ID, {
      agentId: '',
      templateKey: '   ',
      name: 'coder',
    });

    expect(config).toBeNull();
    expect(h.templateRepoCalls).toEqual([]);
  });

  test('agentId fallback branch (current behavior): resolves a runnable registry agent by id', () => {
    const h = makeTemplateResolutionHarness({
      registryAgents: [makeRegistryAgent()],
    });

    const config = h.internals.resolveSlotSpawnConfig(SPACE_ID, {
      agentId: 'agent-registry-1',
      name: 'coder',
    });

    expect(config?.source).toBe('agent');
    expect(config?.agent.id).toBe('agent-registry-1');
    expect(config?.agent.displayName).toBe('coder');
    expect(config?.templateKey).toBeNull();
  });

  test('agentId fallback branch (current behavior): null for an agent that is not in the registry', () => {
    const h = makeTemplateResolutionHarness({
      registryAgents: [makeRegistryAgent()],
    });

    expect(
      h.internals.resolveSlotSpawnConfig(SPACE_ID, {
        agentId: 'agent-elsewhere',
        name: 'coder',
      })
    ).toBeNull();
  });
});

const PINNED_VERSION = 'version-pinned-3839';
const DEFAULT_PINNED_VERSION = 'version-pinned-default';

function makeSnapshot(
  template: SpaceAgentTemplate,
  overrides: Partial<WorkflowTemplateSnapshot> = {}
): WorkflowTemplateSnapshot {
  return { ...toRunTemplateSnapshot(template), ...overrides };
}

function pinnedRun(): Pick<SpaceWorkflowRun, 'workflowId' | 'definitionVersion'> {
  return { workflowId: 'wf-3832', definitionVersion: PINNED_VERSION };
}

describe('resolveSlotSpawnConfig pinned snapshot consumption (ATC-8)', () => {
  test('a run-pinned snapshot wins over the live built-in template', () => {
    const h = makeTemplateResolutionHarness({
      pinnedWorkflows: {
        [PINNED_VERSION]: {
          ...makeWorkflow(makeTemplateWorkflowNode()),
          templateSnapshots: {
            'worker.swe': makeSnapshot(
              makeStoredTemplate({ key: 'worker.swe', instructions: 'Pinned worker instructions' })
            ),
          },
        },
      },
    });

    const config = h.internals.resolveSlotSpawnConfig(
      SPACE_ID,
      { agentId: '', templateKey: 'worker.swe', name: 'coder' },
      pinnedRun()
    );

    expect(config?.source).toBe('template');
    expect(config?.agent.id).toBe('template:worker.swe');
    expect(config?.agent.instructions).toBe('Pinned worker instructions');
    expect(h.templateRepoCalls).toEqual([]);
  });

  test('a run-pinned snapshot wins over an edited live stored template', () => {
    const h = makeTemplateResolutionHarness({
      storedTemplates: [makeStoredTemplate({ instructions: 'Edited after run start' })],
      pinnedWorkflows: {
        [PINNED_VERSION]: {
          ...makeWorkflow(makeTemplateWorkflowNode({ templateKey: 'custom.stored' })),
          templateSnapshots: {
            'custom.stored': makeSnapshot(
              makeStoredTemplate({ instructions: 'Pinned at run start' })
            ),
          },
        },
      },
    });

    const config = h.internals.resolveSlotSpawnConfig(
      SPACE_ID,
      { agentId: '', templateKey: 'custom.stored', name: 'stored' },
      pinnedRun()
    );

    expect(config?.agent.instructions).toBe('Pinned at run start');
    expect(config?.agent.model).toBe('stored-model');
    expect(config?.agent.toolPermissions).toEqual({ tools: ['Read', 'Grep'] });
    expect(h.templateRepoCalls).toEqual([]);
  });

  test('slot model and thinking overrides still apply on top of a pinned snapshot', () => {
    const h = makeTemplateResolutionHarness({
      pinnedWorkflows: {
        [PINNED_VERSION]: {
          ...makeWorkflow(makeTemplateWorkflowNode()),
          templateSnapshots: {
            'worker.swe': makeSnapshot(makeStoredTemplate({ key: 'worker.swe' })),
          },
        },
      },
    });

    const config = h.internals.resolveSlotSpawnConfig(
      SPACE_ID,
      {
        agentId: '',
        templateKey: 'worker.swe',
        name: 'coder',
        model: 'slot-model',
        thinkingLevel: 'think32k',
      },
      pinnedRun()
    );

    expect(config?.agent.model).toBe('slot-model');
    expect(config?.agent.thinkingLevel).toBe('think32k');
  });

  test('a pinned run predating snapshots refuses to resolve live', () => {
    const h = makeTemplateResolutionHarness({
      storedTemplates: [makeStoredTemplate({ instructions: 'Edited after run start' })],
      pinnedWorkflows: {
        [PINNED_VERSION]: makeWorkflow(makeTemplateWorkflowNode({ templateKey: 'custom.stored' })),
      },
    });

    const config = h.internals.resolveSlotSpawnConfig(
      SPACE_ID,
      { agentId: '', templateKey: 'custom.stored', name: 'stored' },
      pinnedRun()
    );

    expect(config).toBeNull();
    expect(h.templateRepoCalls).toEqual([]);
  });

  test('an unpinned run refuses to resolve live', () => {
    const h = makeTemplateResolutionHarness({
      storedTemplates: [makeStoredTemplate()],
    });

    const config = h.internals.resolveSlotSpawnConfig(
      SPACE_ID,
      { agentId: '', templateKey: 'custom.stored', name: 'stored' },
      { workflowId: 'wf-3832', definitionVersion: null }
    );

    expect(config).toBeNull();
    expect(h.templateRepoCalls).toEqual([]);
  });

  test('a snapshot record missing the requested key never falls back to live resolution', () => {
    const h = makeTemplateResolutionHarness({
      storedTemplates: [makeStoredTemplate()],
      pinnedWorkflows: {
        [PINNED_VERSION]: {
          ...makeWorkflow(makeTemplateWorkflowNode()),
          templateSnapshots: { 'worker.custom': makeSnapshot(makeStoredTemplate()) },
        },
      },
    });

    const config = h.internals.resolveSlotSpawnConfig(
      SPACE_ID,
      { agentId: '', templateKey: 'custom.stored', name: 'stored' },
      pinnedRun()
    );

    expect(config).toBeNull();
    expect(h.templateRepoCalls).toEqual([]);
  });

  test('an unresolvable pinned definition refuses to resolve live', () => {
    const h = makeTemplateResolutionHarness({
      storedTemplates: [makeStoredTemplate()],
      pinnedWorkflows: { [PINNED_VERSION]: null },
    });

    const config = h.internals.resolveSlotSpawnConfig(
      SPACE_ID,
      { agentId: '', templateKey: 'custom.stored', name: 'stored' },
      pinnedRun()
    );

    expect(config).toBeNull();
    expect(h.templateRepoCalls).toEqual([]);
  });

  test('prototype-named keys on a rehydrated snapshot record never leak Object.prototype', () => {
    const rehydrated = JSON.parse(
      JSON.stringify({
        ...makeWorkflow(makeTemplateWorkflowNode()),
        templateSnapshots: { 'worker.custom': makeSnapshot(makeStoredTemplate()) },
      })
    ) as SpaceWorkflow;
    const h = makeTemplateResolutionHarness({
      pinnedWorkflows: { [PINNED_VERSION]: rehydrated },
    });

    const config = h.internals.resolveSlotSpawnConfig(
      SPACE_ID,
      { agentId: '', templateKey: 'toString', name: 'coder' },
      pinnedRun()
    );

    expect(config).toBeNull();
    expect(h.templateRepoCalls).toEqual([]);
  });

  test('a dual-reference slot in a run refuses to fall through to its live agentId', () => {
    const h = makeTemplateResolutionHarness({
      storedTemplates: [makeStoredTemplate()],
      registryAgents: [makeRegistryAgent({ id: 'agent-live', displayName: 'Live Agent' })],
    });

    const config = h.internals.resolveSlotSpawnConfig(
      SPACE_ID,
      { agentId: 'agent-live', templateKey: 'custom.stored', name: 'stored' },
      { workflowId: 'wf-3832', definitionVersion: null }
    );

    expect(config).toBeNull();
    expect(h.templateRepoCalls).toEqual([]);
  });

  test('a direct spawn without a run resolves live (send-to-agent path)', () => {
    const h = makeTemplateResolutionHarness({
      storedTemplates: [makeStoredTemplate()],
    });

    const config = h.internals.resolveSlotSpawnConfig(SPACE_ID, {
      agentId: '',
      templateKey: 'custom.stored',
      name: 'stored',
    });

    expect(config?.agent.instructions).toBe('Stored template instructions');
    expect(h.templateRepoCalls).toEqual(['custom.stored']);
  });
});

interface CapturedMemberInfo {
  agentId: string;
  agentName: string;
  nodeId: string | undefined;
  deferFreshExecutionBind?: boolean;
  freshSessionOnly?: boolean;
}

interface SpawnPayloadHarness {
  spawn: () => Promise<string>;
  capturedInit: () => AgentSessionInit | undefined;
  capturedMemberInfo: () => CapturedMemberInfo | undefined;
  capturedKickoff: () => string | undefined;
}

function makeSpawnPayloadHarness(
  workflow: SpaceWorkflow,
  agentName: string,
  options: {
    definitionVersion?: string | null;
    pinnedWorkflow?: SpaceWorkflow | null;
  } = {}
): SpawnPayloadHarness {
  const defaultPinnedWorkflow =
    options.pinnedWorkflow !== undefined
      ? options.pinnedWorkflow
      : withRunTemplateSnapshots(workflow, createAgentTemplateResolver());
  const execution = makeExecution(agentName);
  const dbRow: NodeExecution = { ...execution };
  let capturedInit: AgentSessionInit | undefined;
  let capturedMemberInfo: CapturedMemberInfo | undefined;
  let capturedKickoff: string | undefined;

  const tam = new TaskAgentManager({
    db: { getDatabase: () => new BunDatabase(':memory:'), getSession: () => null },
    sessionManager: { registerSession: () => {}, getSession: () => undefined },
    internalEventBus: new InternalEventBus<DaemonInternalEventMap>(),
    taskRepo: {
      getTask: (id: string) => (id === TASK_ID ? makeTask() : undefined),
      reserveSpawnForTick: () => 'won' as const,
      releaseSpawnReservation: () => {},
    },
    nodeExecutionRepo: {
      getById: (id: string) => (id === execution.id ? dbRow : undefined),
      listByWorkflowRun: () => [dbRow],
      listByNode: () => [dbRow],
      update: (id: string, patch: Record<string, unknown>) => {
        if (id === execution.id) Object.assign(dbRow, patch);
        return { ...dbRow };
      },
      casExecutionStatus: (
        id: string,
        expected: readonly string[],
        next: string,
        payload?: { agentSessionId?: string | null }
      ) => {
        if (id !== execution.id || !expected.includes(dbRow.status)) return 'superseded' as const;
        dbRow.status = next as NodeExecution['status'];
        if (payload?.agentSessionId !== undefined) dbRow.agentSessionId = payload.agentSessionId;
        return 'won' as const;
      },
    },
    spaceManager: { getSpace: async () => ({ id: SPACE_ID, workspacePath: '/tmp/ws' }) },
    spaceWorkflowManager: {
      getWorkflowForRun: () => defaultPinnedWorkflow,
    },
    longHorizonAgentRepo: { getById: () => null },
  } as unknown as TaskAgentManagerConfig);

  const internal = tam as unknown as {
    createSubSession: (
      taskId: string,
      sessionId: string,
      init: AgentSessionInit,
      memberInfo: CapturedMemberInfo
    ) => Promise<string>;
    getSubSession: (id: string) => AgentSession | undefined;
    ensureNodeAgentAttached: () => Promise<void>;
    registerCompletionCallback: () => void;
    injectMessageIntoSession: (session: AgentSession, message: string) => Promise<string>;
    buildNodeAgentMcpServersForSession: () => Record<string, unknown>;
    withSessionInjectLock: <T>(sessionId: string, fn: () => Promise<T>) => Promise<T>;
  };
  internal.createSubSession = async (_taskId, _sessionId, init, memberInfo) => {
    capturedInit = init;
    capturedMemberInfo = memberInfo;
    return SPAWNED_SESSION_ID;
  };
  internal.getSubSession = (id: string) =>
    id === SPAWNED_SESSION_ID ? ({ session: { id } } as unknown as AgentSession) : undefined;
  internal.ensureNodeAgentAttached = async () => {};
  internal.registerCompletionCallback = () => {};
  internal.injectMessageIntoSession = async (_session, message) => {
    capturedKickoff = message;
    return 'msg-id';
  };
  internal.buildNodeAgentMcpServersForSession = () => ({});

  const task = makeTask();
  const space = { id: SPACE_ID, workspacePath: '/tmp/ws' } as unknown as Space;
  const workflowRun = {
    id: RUN_ID,
    workflowId: 'wf-3832',
    status: 'in_progress',
    definitionVersion:
      options.definitionVersion !== undefined ? options.definitionVersion : DEFAULT_PINNED_VERSION,
  } as unknown as SpaceWorkflowRun;

  return {
    spawn: () =>
      tam.spawnWorkflowNodeAgentForExecution(task, space, workflow, workflowRun, execution, {}),
    capturedInit: () => capturedInit,
    capturedMemberInfo: () => capturedMemberInfo,
    capturedKickoff: () => capturedKickoff,
  };
}

describe('worker-template spawn payload (ATC-1 pin, feeds slice 7 lock semantics)', () => {
  test('a worker.swe template slot resolves the preset coder prompt and config at spawn time', async () => {
    const h = makeSpawnPayloadHarness(makeWorkflow(makeTemplateWorkflowNode()), 'coder');

    await h.spawn();

    const init = h.capturedInit();
    expect(init).toBeDefined();
    expect(init?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: PRESET_CODER_PROMPT,
    });
    expect(init?.type).toBe('worker');
    expect(init?.title).toBe('Task #3832: Pin template resolution — Coder');
    expect(init?.model).toBe('claude-sonnet-4-6');
    expect(init?.provider).toBe('anthropic');
    expect(init?.thinkingLevel).toBeUndefined();
    expect(init?.context).toEqual({ spaceId: SPACE_ID, taskId: TASK_ID });
    expect(init?.workspacePath).toBe('/tmp/ws');
    expect(init?.mcpServers).toEqual({});
    expect(init?.settingSources).toBeUndefined();
    expect(init?.allowedTools).toBeUndefined();
    expect(init?.disallowedTools).toBeUndefined();
    expect(init?.skillOverrides).toBeUndefined();
    expect(init?.toolGuards).toBeUndefined();
    expect(init?.features).toEqual({
      rewind: false,
      worktree: false,
      coordinator: false,
      archive: false,
      sessionInfo: false,
    });
    expect(Object.keys(init?.agents ?? {})).toEqual(['general-purpose']);

    const provenance = init?.promptProvenance;
    expect(provenance?.source).toBe('space_agent_custom_prompt');
    expect(provenance?.hash).toBe(createHash('sha256').update(PRESET_CODER_PROMPT).digest('hex'));
    expect(provenance?.agentId).toBe('worker.swe');
    expect(provenance?.agentName).toBe('coder');
    expect(provenance?.workflowRunId).toBe(RUN_ID);
    expect(provenance?.workflowId).toBe('wf-3832');
    expect(provenance?.nodeId).toBe(NODE_ID);
    expect(provenance?.nodeName).toBe('coder');
  });

  test('the spawned session is registered under the synthetic template agent id', async () => {
    const h = makeSpawnPayloadHarness(makeWorkflow(makeTemplateWorkflowNode()), 'coder');

    await h.spawn();

    expect(h.capturedMemberInfo()).toEqual({
      agentId: 'template:worker.swe',
      agentName: 'coder',
      nodeId: NODE_ID,
      deferFreshExecutionBind: true,
      freshSessionOnly: true,
    });
  });

  test('a worker.swe kickoff message carries the task, runtime location, and role sections', async () => {
    const h = makeSpawnPayloadHarness(makeWorkflow(makeTemplateWorkflowNode()), 'coder');

    await h.spawn();

    const message = h.capturedKickoff();
    expect(message).toBeDefined();
    expect(message?.startsWith('## Your Task #3832\n\n**Title:** Pin template resolution\n')).toBe(
      true
    );
    expect(message).toContain(
      '**Description:** Characterize the template resolution and spawn payload'
    );
    expect(message).toContain('## Runtime Location\n\n- Worktree: /tmp/ws');
    expect(message).toContain(
      '## Your Role in This Workflow\n\n- Workflow: Coding\n- Node: coder\n- Peers: reviewer'
    );
    expect(message).toContain(
      '## Runtime Execution Contract\nNode: "coder" (node-coder)\nAgent: "coder"'
    );
  });

  test('a worker.reviewer template slot derives scoped tool permissions from the template tools', async () => {
    const h = makeSpawnPayloadHarness(
      makeWorkflow(makeTemplateWorkflowNode({ templateKey: 'worker.reviewer', name: 'reviewer' })),
      'reviewer'
    );

    await h.spawn();

    const init = h.capturedInit();
    expect(init?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: REVIEWER_SYSTEM_CONTRACT,
    });
    expect(init?.promptProvenance?.agentId).toBe('worker.reviewer');
    expect(init?.promptProvenance?.hash).toBe(
      createHash('sha256').update(REVIEWER_SYSTEM_CONTRACT).digest('hex')
    );
    expect(init?.allowedTools).toEqual([
      'Task',
      'TaskOutput',
      'TaskStop',
      'Bash(gh pr view:*)',
      'Bash(gh pr diff:*)',
      'Bash(gh pr checks:*)',
      'Bash(gh api graphql:*)',
      'Bash(gh api repos:*)',
      'Bash(jq:*)',
      'Bash(mktemp:*)',
      'Bash(echo:*)',
      'Bash(cat:*)',
      'Bash(test:*)',
      'Bash(head:*)',
      'Bash(tr:*)',
      'Bash(base64:*)',
      'Bash(exit:*)',
    ]);
    expect(init?.disallowedTools).toEqual(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  });

  test('a slot model override re-points the spawn model and inferred provider', async () => {
    const h = makeSpawnPayloadHarness(
      makeWorkflow(
        makeTemplateWorkflowNode({ model: 'moonshot-custom', thinkingLevel: 'think8k' })
      ),
      'coder'
    );

    await h.spawn();

    const init = h.capturedInit();
    expect(init?.model).toBe('moonshot-custom');
    expect(init?.provider).toBe('kimi');
    expect(init?.thinkingLevel).toBe('think8k');
  });
});

describe('worker-template spawn consumes the run-pinned snapshot (ATC-8)', () => {
  const pinnedWorkflow = (): SpaceWorkflow => ({
    ...makeWorkflow(makeTemplateWorkflowNode()),
    templateSnapshots: {
      'worker.swe': toRunTemplateSnapshot(
        makeStoredTemplate({ key: 'worker.swe', instructions: 'Pinned preset coder prompt' })
      ),
    },
  });

  test('the spawn prompt and provenance hash come from the pinned snapshot, not the live built-in', async () => {
    const h = makeSpawnPayloadHarness(makeWorkflow(makeTemplateWorkflowNode()), 'coder', {
      definitionVersion: 'version-pinned-3839',
      pinnedWorkflow: pinnedWorkflow(),
    });

    await h.spawn();

    const init = h.capturedInit();
    expect(init?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: 'Pinned preset coder prompt',
    });
    expect(init?.promptProvenance?.source).toBe('space_agent_custom_prompt');
    expect(init?.promptProvenance?.hash).toBe(
      createHash('sha256').update('Pinned preset coder prompt').digest('hex')
    );
    expect(init?.promptProvenance?.agentId).toBe('worker.swe');
  });

  test('a run predating snapshots refuses to spawn rather than resolving live', async () => {
    const h = makeSpawnPayloadHarness(makeWorkflow(makeTemplateWorkflowNode()), 'coder', {
      definitionVersion: 'version-pinned-3839',
      pinnedWorkflow: makeWorkflow(makeTemplateWorkflowNode()),
    });

    await expect(h.spawn()).rejects.toThrow('no pinned template snapshot to resolve it from');
    expect(h.capturedInit()).toBeUndefined();
  });

  test('a snapshot-less spawn failure names the run, key, and the only valid remediation', async () => {
    const h = makeSpawnPayloadHarness(makeWorkflow(makeTemplateWorkflowNode()), 'coder', {
      definitionVersion: 'version-pinned-3839',
      pinnedWorkflow: makeWorkflow(makeTemplateWorkflowNode()),
    });

    await expect(h.spawn()).rejects.toThrow(
      expect.objectContaining({
        name: 'MissingWorkflowAgentError',
        permanent: true,
      })
    );
    await expect(h.spawn()).rejects.toThrow('worker.swe');
    await expect(h.spawn()).rejects.toThrow('start a new run');
  });
});
