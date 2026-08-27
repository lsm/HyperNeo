import type {
  NodeExecution,
  Space,
  SpaceWorkerAgent,
  SpaceGoal,
  SpaceGoalEvent,
  SpaceLongHorizonAgent,
  SpaceTask,
  SpaceTaskActivityMember,
  SpaceWorkflow,
  SpaceWorkflowRun,
} from '@hyperneo/shared';
import { signal } from '@preact/signals';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const currentSpaceIdSignal = signal<string | null>(null);
const currentSpaceCanonicalIdSignal = signal<string | null>(null);

let mockEventHandlers: Map<string, (event: unknown) => void>;
let mockEventHandlerSets: Map<string, Set<(event: unknown) => void>>;
let mockHub: ReturnType<typeof makeMockHub>;
let taskDetailResult: SpaceTask | null = null;

function fireMockEvent(eventName: string, data: unknown): void {
  mockEventHandlerSets.get(eventName)?.forEach((h) => {
    h(data);
  });
}

function makeSpace(id = 'space-1'): Space {
  return {
    id,
    slug: 'test-space',
    name: 'Test Space',
    workspacePath: '/workspace',
    description: '',
    backgroundContext: '',
    instructions: '',
    sessionIds: [],
    status: 'active',
    paused: false,
    stopped: false,
    maxConcurrentTasks: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

let _taskCounter = 0;
function makeTask(id: string, status = 'open', workflowRunId?: string): SpaceTask {
  return {
    id,
    spaceId: 'space-1',
    taskNumber: ++_taskCounter,
    title: `Task ${id}`,
    description: '',
    status: status as SpaceTask['status'],
    priority: 'normal',
    labels: [],
    dependsOn: [],
    result: null,
    startedAt: null,
    completedAt: null,
    archivedAt: null,
    blockReason: null,
    approvalSource: null,
    approvalReason: null,
    approvedAt: null,
    pendingCheckpointType: null,
    reportedStatus: null,
    reportedSummary: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    terminalGeneration: 0,
    ...(workflowRunId ? { workflowRunId } : {}),
  };
}

function makeGoal(overrides: Partial<SpaceGoal> = {}): SpaceGoal {
  return {
    id: 'goal-1',
    spaceId: 'space-1',
    title: 'Goal 1',
    description: '',
    status: 'active',
    type: 'one_shot',
    priority: 'normal',
    labels: [],
    metrics: {},
    summary: '',
    progress: 0,
    nextSteps: [],
    preferredWorkflowId: null,
    taskScheduleId: null,
    autoTriggerNext: false,
    pendingNextRun: false,
    activeTaskId: null,
    lastTaskId: null,
    lastCheckInAt: null,
    nextCheckInAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completedAt: null,
    revision: 1,
    ...overrides,
  };
}

function makeGoalEvent(overrides: Partial<SpaceGoalEvent> = {}): SpaceGoalEvent {
  return {
    id: 'goal-event-1',
    spaceId: 'space-1',
    goalId: 'goal-1',
    eventType: 'created',
    source: 'rpc',
    sourceTaskId: null,
    sourceSessionId: null,
    previousState: null,
    newState: null,
    diff: null,
    note: null,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeRun(id: string, status = 'pending'): SpaceWorkflowRun {
  return {
    id,
    spaceId: 'space-1',
    workflowId: 'wf-1',
    definitionVersion: null,
    title: `Run ${id}`,
    status: status as SpaceWorkflowRun['status'],
    startedAt: null,
    completedAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeAgent(id: string): SpaceWorkerAgent {
  return {
    id,
    spaceId: 'space-1',
    name: `Agent ${id}`,
    handle: id,
    customPrompt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeLongHorizonAgent(id: string): SpaceLongHorizonAgent {
  return {
    id,
    spaceId: 'space-1',
    handle: id,
    displayName: `Long Horizon Agent ${id}`,
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
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeWorkflow(id: string): SpaceWorkflow {
  return {
    id,
    spaceId: 'space-1',
    name: `Workflow ${id}`,
    nodes: [],
    startNodeId: '',
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completionAutonomyLevel: 3,
  };
}

function makeWorkflowSummary(id: string): import('@hyperneo/shared').SpaceWorkflowSummary {
  return {
    id,
    spaceId: 'space-1',
    name: `Workflow ${id}`,
    nodeCount: 0,
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    completionAutonomyLevel: 3,
  };
}

function makeTaskActivityRows(taskId = 't1'): SpaceTaskActivityMember[] {
  return [
    {
      id: `session-${taskId}`,
      sessionId: `session-${taskId}`,
      kind: 'task_agent',
      label: 'Task Agent',
      role: 'task-agent',
      state: 'active',
      processingStatus: 'processing',
      processingPhase: 'thinking',
      messageCount: 2,
      taskId,
      taskTitle: `Task ${taskId}`,
      taskStatus: 'in_progress',
      updatedAt: Date.now(),
      lastMessageAt: Date.now(),
    },
  ];
}

function makeMockHub() {
  return {
    joinChannel: vi.fn(),
    leaveChannel: vi.fn(),
    onConnection: vi.fn(() => () => {}),
    onEvent: vi.fn((eventName: string, handler: (e: unknown) => void) => {
      mockEventHandlers.set(eventName, handler);
      if (!mockEventHandlerSets.has(eventName)) {
        mockEventHandlerSets.set(eventName, new Set());
      }
      mockEventHandlerSets.get(eventName)?.add(handler);
      return () => {
        mockEventHandlers.delete(eventName);
        mockEventHandlerSets.get(eventName)?.delete(handler);
      };
    }),
    request: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'space.overview') {
        const requested = (params?.id ?? params?.slug ?? 'space-1') as string;
        const spaceId = requested === 'test-space' ? 'space-1' : requested;
        return {
          space: makeSpace(spaceId),
          tasks: [],
          workflowRuns: [],
          sessions: [],
        };
      }
      if (method === 'spaceAgent.list') return { agents: [] };
      if (method === 'spaceAgent.listBuiltInTemplates') return { templates: [] };
      if (method === 'spaceWorkflow.list') return { workflows: [] };
      if (method === 'space.pause') return { ...makeSpace(), paused: true };
      if (method === 'space.resume') return { ...makeSpace(), paused: false };
      if (method === 'space.stop') return { ...makeSpace(), stopped: true };
      if (method === 'space.start') return { ...makeSpace(), stopped: false, paused: false };
      if (method === 'space.update') return makeSpace();
      if (method === 'space.workspace.list') {
        return [
          {
            id: 'ws-1',
            spaceId: 'space-1',
            path: '/workspace',
            label: 'Main',
            isPrimary: true,
            createdAt: 0,
            updatedAt: 0,
          },
        ];
      }
      if (method === 'spaceTask.create') return makeTask('new-task');
      if (method === 'spaceTask.get')
        return (
          taskDetailResult ?? { ...makeTask(params?.taskId as string), description: 'full text' }
        );
      if (method === 'spaceTask.update') return makeTask('t1', 'in_progress');
      if (method === 'spaceTask.recoverWorkflow') return makeTask('t1', 'in_progress');
      if (method === 'spaceAgent.create') return { agent: makeAgent('new-agent') };
      if (method === 'spaceAgent.getPromotionDraft') {
        return {
          draft: {
            sourceSessionId: params?.sessionId,
            sourceSessionTitle: 'Session title',
            name: 'Promoted Agent',
            customPrompt: 'Generated profile',
            profile: {},
          },
        };
      }
      if (method === 'spaceAgent.promoteSession') return { agent: makeAgent('promoted-agent') };
      if (method === 'spaceAgent.update') return { agent: makeAgent('a1') };
      if (method === 'spaceAgent.syncFromTemplate')
        return { agent: makeAgent(params?.agentId as string) };
      if (method === 'spaceAgent.previewTemplateSync')
        return {
          preview: {
            agentId: params?.agentId as string,
            agentName: 'Agent',
            templateName: 'Coder',
            storedHash: 'stale',
            liveHash: 'live',
            rowHash: 'row',
            updateAvailable: true,
            customized: true,
            diff: { customPrompt: { before: 'old prompt', after: 'new prompt' } },
          },
        };
      if (method === 'spaceLongHorizonAgent.list') return { agents: [] };
      if (method === 'spaceLongHorizonAgent.create') {
        return {
          agent: makeLongHorizonAgent((params?.id as string | undefined) ?? 'new-lh-agent'),
        };
      }
      if (method === 'spaceLongHorizonAgent.listBuiltInTemplates') return { templates: [] };
      if (method === 'spaceLongHorizonAgent.listSubscriptions') return { subscriptions: [] };
      if (method === 'spaceLongHorizonAgent.createSubscription') {
        return {
          subscription: {
            id: 'sub-1',
            spaceId: params?.spaceId,
            agentId: params?.agentId,
            source: params?.source,
            topic: params?.topic,
            filter: params?.filter ?? {},
            status: params?.status ?? 'active',
            createdAt: 1,
            updatedAt: 1,
          },
        };
      }
      if (method === 'spaceLongHorizonAgent.updateSubscription') {
        return {
          subscription: {
            id: params?.subscriptionId,
            spaceId: params?.spaceId,
            agentId: 'lh-1',
            source: 'github',
            topic: 'github/*/*/pull_request/*',
            filter: {},
            status: params?.status ?? 'active',
            createdAt: 1,
            updatedAt: 2,
          },
        };
      }
      if (method === 'spaceWorkflow.create') return { workflow: makeWorkflow('new-wf') };
      if (method === 'spaceWorkflow.update') return { workflow: makeWorkflow('wf1') };
      if (method === 'spaceWorkflow.previewTemplateSync')
        return {
          preview: {
            workflowId: params?.id as string,
            workflowName: 'Workflow',
            templateName: 'Coding Workflow',
            storedHash: 'stale',
            liveHash: 'live',
            rowHash: 'row',
            updateAvailable: true,
            customized: true,
            diff: { description: { before: 'old desc', after: 'new desc' } },
          },
        };
      if (method === 'nodeExecution.list') return { executions: [] };
      if (method === 'spaceGoal.list') return { goals: [] };
      if (method === 'spaceGoal.get') return { goal: makeGoal({ id: params?.goalId as string }) };
      if (method === 'spaceGoal.create') return { goal: makeGoal({ id: 'new-goal' }) };
      if (method === 'spaceGoal.update') {
        return { goal: makeGoal({ id: params?.goalId as string, ...(params ?? {}) }) };
      }
      if (method === 'spaceGoal.pause') {
        return { goal: makeGoal({ id: params?.goalId as string, status: 'paused' }) };
      }
      if (method === 'spaceGoal.resume') {
        return { goal: makeGoal({ id: params?.goalId as string, status: 'active' }) };
      }
      if (method === 'spaceGoal.createImmediateTask') {
        return {
          goal: makeGoal({ id: params?.goalId as string, activeTaskId: 'goal-task' }),
          task: makeTask('goal-task'),
          queued: false,
        };
      }
      if (method === 'spaceGoal.listEvents') return { events: [makeGoalEvent()] };
      if (method === 'space.listWithTasks')
        return [
          { ...makeSpace('s1'), tasks: [] },
          { ...makeSpace('s2'), tasks: [] },
        ];
      return {};
    }),
  };
}

vi.mock('../connection-manager.ts', () => ({
  connectionManager: {
    getHub: vi.fn(async () => mockHub),
    getHubIfConnected: vi.fn(() => mockHub),
  },
}));

vi.mock('../signals.ts', () => ({
  currentSpaceCanonicalIdSignal,
  currentSpaceIdSignal,
}));

let spaceStore: typeof import('../space-store').spaceStore;

async function getStore() {
  const mod = await import('../space-store.ts');
  return mod.spaceStore;
}

async function resetStore() {
  mockEventHandlers = new Map();
  mockEventHandlerSets = new Map();
  mockHub = makeMockHub();
  spaceStore = await getStore();
  if (spaceStore.spaceId.value !== null) {
    await spaceStore.clearSpace();
  }
  currentSpaceIdSignal.value = null;
  currentSpaceCanonicalIdSignal.value = null;
  mockEventHandlers.clear();
}

describe('SpaceStore — space selection', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('starts with no space selected', () => {
    expect(spaceStore.spaceId.value).toBeNull();
    expect(spaceStore.space.value).toBeNull();
    expect(spaceStore.loading.value).toBe(false);
  });

  it('sets spaceId after selectSpace()', async () => {
    await spaceStore.selectSpace('space-1');
    expect(spaceStore.spaceId.value).toBe('space-1');
  });

  it('stores canonical id separately after slug selection resolves', async () => {
    currentSpaceIdSignal.value = 'test-space';

    await spaceStore.selectSpace('test-space');

    expect(spaceStore.spaceId.value).toBe('space-1');
    expect(currentSpaceIdSignal.value).toBe('test-space');
    expect(currentSpaceCanonicalIdSignal.value).toBe('space-1');
  });

  it('fetches initial state on selectSpace()', async () => {
    await spaceStore.selectSpace('space-1');
    expect(mockHub.request).toHaveBeenCalledWith('space.overview', {
      slug: 'space-1',
      summary: true,
    });
    expect(spaceStore.space.value?.id).toBe('space-1');
  });

  it('does not eagerly fetch agents/workflows on selectSpace() — they are lazy-loaded', async () => {
    await spaceStore.selectSpace('space-1');
    const calledMethods = mockHub.request.mock.calls.map((c: unknown[]) => c[0]);
    expect(calledMethods).not.toContain('spaceAgent.list');
    expect(calledMethods).not.toContain('spaceAgent.listBuiltInTemplates');
    expect(calledMethods).not.toContain('spaceWorkflow.list');
    expect(calledMethods).not.toContain('spaceWorkflow.listBuiltInTemplates');
    expect(calledMethods).not.toContain('nodeExecution.list');
  });

  it('fetches agents and workflows via ensureConfigData()', async () => {
    await spaceStore.selectSpace('space-1');
    mockHub.request.mockClear();

    await spaceStore.ensureConfigData();
    expect(mockHub.request).toHaveBeenCalledWith('spaceAgent.list', { spaceId: 'space-1' });
    expect(mockHub.request).toHaveBeenCalledWith('spaceAgent.listBuiltInTemplates', {
      spaceId: 'space-1',
    });
    expect(mockHub.request).toHaveBeenCalledWith('spaceWorkflow.list', { spaceId: 'space-1' });
    expect(mockHub.request).toHaveBeenCalledWith('spaceWorkflow.listBuiltInTemplates', {
      spaceId: 'space-1',
    });
    expect(spaceStore.configDataLoaded.value).toBe(true);
  });

  it('ensureConfigData() is idempotent — second call is a no-op', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureConfigData();
    mockHub.request.mockClear();

    await spaceStore.ensureConfigData();
    expect(mockHub.request).not.toHaveBeenCalled();
  });

  it('discards stale agent list results after a space switch', async () => {
    await spaceStore.selectSpace('space-1');
    let resolveList: (value: { agents: SpaceWorkerAgent[] }) => void = () => {};
    mockHub.request.mockImplementation((method: string, params?: Record<string, unknown>) => {
      if (method === 'spaceAgent.list' && params?.spaceId === 'space-1') {
        return new Promise<{ agents: SpaceWorkerAgent[] }>((resolve) => {
          resolveList = resolve;
        });
      }
      if (method === 'spaceAgent.list') return Promise.resolve({ agents: [] });
      if (method === 'spaceAgent.listBuiltInTemplates') return Promise.resolve({ templates: [] });
      if (method === 'spaceWorkflow.list') return Promise.resolve({ workflows: [] });
      if (method === 'spaceWorkflow.listBuiltInTemplates')
        return Promise.resolve({ workflows: [] });
      if (method === 'spaceLongHorizonAgent.list') return Promise.resolve({ agents: [] });
      if (method === 'spaceLongHorizonAgent.listBuiltInTemplates') {
        return Promise.resolve({ templates: [] });
      }
      return Promise.resolve({});
    });

    const request = spaceStore.ensureConfigData();
    await spaceStore.selectSpace('space-2');
    resolveList({ agents: [makeAgent('stale-agent')] });
    await request;

    expect(spaceStore.agents.value.some((agent) => agent.id === 'stale-agent')).toBe(false);
  });

  it('clears state on clearSpace()', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.tasks.value = [makeTask('t1')];

    await spaceStore.clearSpace();

    expect(spaceStore.spaceId.value).toBeNull();
    expect(spaceStore.space.value).toBeNull();
    expect(spaceStore.tasks.value).toEqual([]);
    expect(spaceStore.workflowRuns.value).toEqual([]);
    expect(spaceStore.agents.value).toEqual([]);
    expect(spaceStore.workflows.value).toEqual([]);
  });

  it('is a no-op when selecting the same space', async () => {
    await spaceStore.selectSpace('space-1');
    const callCount = mockHub.request.mock.calls.length;

    await spaceStore.selectSpace('space-1');

    expect(mockHub.request.mock.calls.length).toBe(callCount);
  });
});

describe('SpaceStore — ensureWorkflowDetails', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  function mockWorkflowSummaries(ids: string[]) {
    mockHub.request.mockImplementation(
      async (method: string, params?: Record<string, unknown>): Promise<any> => {
        if (method === 'space.overview') {
          const spaceId = (params?.spaceId as string) ?? 'space-1';
          return { space: makeSpace(spaceId), tasks: [], workflowRuns: [], sessions: [] };
        }
        if (method === 'spaceWorkflow.list') {
          return { workflows: ids.map((id) => makeWorkflowSummary(id)) };
        }
        if (method === 'spaceWorkflow.get') {
          return { workflow: makeWorkflow((params?.id as string) ?? 'wf1') };
        }
        if (method === 'spaceAgent.list') return { agents: [] };
        if (method === 'spaceAgent.listBuiltInTemplates') return { templates: [] };
        if (method === 'spaceWorkflow.listBuiltInTemplates') return { workflows: [] };
        if (method === 'spaceLongHorizonAgent.list') return { agents: [] };
        if (method === 'spaceLongHorizonAgent.listBuiltInTemplates') return { templates: [] };
        return {};
      }
    );
  }

  it('bulk-fetches workflow details via spaceWorkflow.get per workflow', async () => {
    mockWorkflowSummaries(['wf1', 'wf2']);
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureConfigData();
    mockHub.request.mockClear();

    await spaceStore.ensureWorkflowDetails();

    const calls = mockHub.request.mock.calls.filter(
      (c) => (c[0] as string) === 'spaceWorkflow.get'
    );
    expect(calls).toHaveLength(2);
    expect(spaceStore.workflowDetails.value.map((w) => w.id).sort()).toEqual(['wf1', 'wf2']);
    expect(spaceStore.workflowDetailsLoaded.value).toBe(true);
  });

  it('is idempotent — second call is a no-op', async () => {
    mockWorkflowSummaries(['wf1']);
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureConfigData();
    await spaceStore.ensureWorkflowDetails();
    mockHub.request.mockClear();

    await spaceStore.ensureWorkflowDetails();
    const gets = mockHub.request.mock.calls.filter((c) => (c[0] as string) === 'spaceWorkflow.get');
    expect(gets).toHaveLength(0);
  });

  it('dedupes concurrent callers via the in-flight promise', async () => {
    mockWorkflowSummaries(['wf1', 'wf2', 'wf3']);
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureConfigData();
    mockHub.request.mockClear();

    await Promise.all([
      spaceStore.ensureWorkflowDetails(),
      spaceStore.ensureWorkflowDetails(),
      spaceStore.ensureWorkflowDetails(),
    ]);

    const gets = mockHub.request.mock.calls.filter((c) => (c[0] as string) === 'spaceWorkflow.get');
    expect(gets).toHaveLength(3);
  });

  it('resets workflowDetailsLoaded on space switch', async () => {
    mockWorkflowSummaries(['wf1']);
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureConfigData();
    await spaceStore.ensureWorkflowDetails();
    expect(spaceStore.workflowDetailsLoaded.value).toBe(true);

    await spaceStore.selectSpace('space-2');

    expect(spaceStore.workflowDetailsLoaded.value).toBe(false);
    expect(spaceStore.workflowDetails.value).toEqual([]);
  });

  it('discards the batch when the space switches mid-fetch', async () => {
    mockWorkflowSummaries(['wf1', 'wf2']);
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureConfigData();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockHub.request.mockImplementation(
      async (method: string, params?: Record<string, unknown>): Promise<any> => {
        if (method === 'spaceWorkflow.get') await gate;
        if (method === 'spaceWorkflow.get') {
          return { workflow: makeWorkflow((params?.id as string) ?? 'wf1') };
        }
        return {};
      }
    );

    const pending = spaceStore.ensureWorkflowDetails();
    spaceStore.spaceId.value = 'space-2';
    release();
    await pending;

    expect(spaceStore.workflowDetailsLoaded.value).toBe(false);
    expect(spaceStore.workflowDetails.value).toEqual([]);
  });

  it('drops entries for workflows deleted during fan-out', async () => {
    mockWorkflowSummaries(['wf1', 'wf2']);
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureConfigData();

    let triggeredDeletion = false;
    const realRequest = mockHub.request.getMockImplementation();
    mockHub.request.mockImplementation(
      async (method: string, params?: Record<string, unknown>): Promise<any> => {
        const result = realRequest
          ? await realRequest(method, params)
          : ({} as Record<string, unknown>);
        if (!triggeredDeletion && method === 'spaceWorkflow.get') {
          triggeredDeletion = true;
          spaceStore.workflows.value = spaceStore.workflows.value.filter((w) => w.id !== 'wf2');
        }
        return result;
      }
    );

    await spaceStore.ensureWorkflowDetails();

    expect(spaceStore.workflowDetails.value.map((w) => w.id)).toEqual(['wf1']);
  });

  it('does not mark loaded when a workflow detail RPC fails', async () => {
    mockWorkflowSummaries(['wf1', 'wf2']);
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureConfigData();

    const base = mockHub.request.getMockImplementation();
    mockHub.request.mockImplementation(
      async (method: string, params?: Record<string, unknown>): Promise<any> => {
        if (method === 'spaceWorkflow.get' && (params?.id as string) === 'wf2') {
          throw new Error('transient RPC failure');
        }
        return base ? base(method, params) : {};
      }
    );

    await spaceStore.ensureWorkflowDetails();

    expect(spaceStore.workflowDetailsLoaded.value).toBe(false);
    expect(spaceStore.workflowDetails.value.map((w) => w.id)).toEqual(['wf1']);
  });

  it('marks loaded when the only missing workflow was deleted during fan-out', async () => {
    mockWorkflowSummaries(['wf1', 'wf2']);
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureConfigData();

    const base = mockHub.request.getMockImplementation();
    mockHub.request.mockImplementation(
      async (method: string, params?: Record<string, unknown>): Promise<any> => {
        if (method === 'spaceWorkflow.get' && (params?.id as string) === 'wf2') {
          spaceStore.workflows.value = spaceStore.workflows.value.filter((w) => w.id !== 'wf2');
          return null;
        }
        return base ? base(method, params) : {};
      }
    );

    await spaceStore.ensureWorkflowDetails();

    expect(spaceStore.workflowDetails.value.map((w) => w.id)).toEqual(['wf1']);
    expect(spaceStore.workflowDetailsLoaded.value).toBe(true);
  });

  it('marks loaded when a failed retry already has prior workflow details', async () => {
    mockWorkflowSummaries(['wf1']);
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureConfigData();
    spaceStore.workflowDetails.value = [makeWorkflow('wf1')];

    mockHub.request.mockImplementation(async (method: string): Promise<any> => {
      if (method === 'spaceWorkflow.get') return null;
      return {};
    });

    await spaceStore.ensureWorkflowDetails();

    expect(spaceStore.workflowDetails.value.map((w) => w.id)).toEqual(['wf1']);
    expect(spaceStore.workflowDetailsLoaded.value).toBe(true);
  });

  it('marks loaded after retry exhaustion so the Agents tab does not spin forever', async () => {
    vi.useFakeTimers();
    try {
      mockWorkflowSummaries(['wf1']);
      await spaceStore.selectSpace('space-1');
      await spaceStore.ensureConfigData();
      mockHub.request.mockImplementation(async (method: string): Promise<any> => {
        if (method === 'spaceWorkflow.get') return null;
        return {};
      });

      await spaceStore.ensureWorkflowDetails();
      for (let i = 0; i < 5; i += 1) {
        await vi.runOnlyPendingTimersAsync();
      }

      expect(spaceStore.workflowDetailsLoaded.value).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not run queued workflow-detail retries after load generation changes', async () => {
    vi.useFakeTimers();
    try {
      mockWorkflowSummaries(['wf1']);
      await spaceStore.selectSpace('space-1');
      await spaceStore.ensureConfigData();
      mockHub.request.mockImplementation(async (method: string): Promise<any> => {
        if (method === 'spaceWorkflow.get') return null;
        return {};
      });

      await spaceStore.ensureWorkflowDetails();
      const getCount = mockHub.request.mock.calls.filter(
        (c) => (c[0] as string) === 'spaceWorkflow.get'
      ).length;
      (
        spaceStore as unknown as { workflowDetailsLoadGeneration: number }
      ).workflowDetailsLoadGeneration += 1;
      await vi.runOnlyPendingTimersAsync();

      const nextGetCount = mockHub.request.mock.calls.filter(
        (c) => (c[0] as string) === 'spaceWorkflow.get'
      ).length;
      expect(nextGetCount).toBe(getCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries workflow summary fetch when it fails during ensureConfigData', async () => {
    vi.useFakeTimers();
    try {
      await spaceStore.selectSpace('space-1');
      let summaryAttempts = 0;
      mockHub.request.mockImplementation(async (method: string): Promise<any> => {
        if (method === 'space.overview') {
          return { space: makeSpace('space-1'), tasks: [], workflowRuns: [], sessions: [] };
        }
        if (method === 'spaceWorkflow.list') {
          summaryAttempts += 1;
          if (summaryAttempts < 3) throw new Error('summary fetch failed');
          return { workflows: [makeWorkflowSummary('wf1')] };
        }
        if (method === 'spaceWorkflow.get') return { workflow: makeWorkflow('wf1') };
        if (method === 'spaceAgent.list') return { agents: [] };
        if (method === 'spaceAgent.listBuiltInTemplates') return { templates: [] };
        if (method === 'spaceWorkflow.listBuiltInTemplates') return { workflows: [] };
        if (method === 'spaceLongHorizonAgent.list') return { agents: [] };
        if (method === 'spaceLongHorizonAgent.listBuiltInTemplates') return { templates: [] };
        return {};
      });

      await spaceStore.ensureConfigData();
      await spaceStore.ensureWorkflowDetails();
      expect(spaceStore.workflowDetailsLoaded.value).toBe(false);

      for (let i = 0; i < 10 && !spaceStore.workflowDetailsLoaded.value; i += 1) {
        await vi.runOnlyPendingTimersAsync();
      }

      expect(summaryAttempts).toBeGreaterThanOrEqual(3);
      expect(spaceStore.workflowDetailsLoaded.value).toBe(true);
      expect(spaceStore.workflowDetails.value.map((w) => w.id)).toEqual(['wf1']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks workflow details loaded after summary retry exhaustion', async () => {
    vi.useFakeTimers();
    try {
      await spaceStore.selectSpace('space-1');
      mockHub.request.mockImplementation(async (method: string): Promise<any> => {
        if (method === 'space.overview') {
          return { space: makeSpace('space-1'), tasks: [], workflowRuns: [], sessions: [] };
        }
        if (method === 'spaceWorkflow.list') throw new Error('summary fetch failed');
        if (method === 'spaceAgent.list') return { agents: [] };
        if (method === 'spaceAgent.listBuiltInTemplates') return { templates: [] };
        if (method === 'spaceWorkflow.listBuiltInTemplates') return { workflows: [] };
        if (method === 'spaceLongHorizonAgent.list') return { agents: [] };
        if (method === 'spaceLongHorizonAgent.listBuiltInTemplates') return { templates: [] };
        return {};
      });

      await spaceStore.ensureConfigData();
      await spaceStore.ensureWorkflowDetails();
      for (let i = 0; i < 10; i += 1) {
        await vi.runOnlyPendingTimersAsync();
      }

      expect(spaceStore.workflowDetailsLoaded.value).toBe(true);
      expect(spaceStore.workflowDetails.value).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not let a stale retry timer clear the current retry-pending flag', async () => {
    vi.useFakeTimers();
    try {
      mockWorkflowSummaries(['wf1']);
      await spaceStore.selectSpace('space-1');
      await spaceStore.ensureConfigData();
      mockHub.request.mockImplementation(async (method: string): Promise<any> => {
        if (method === 'spaceWorkflow.get') return null;
        return {};
      });

      await spaceStore.ensureWorkflowDetails();
      expect(
        (spaceStore as unknown as { workflowDetailsRetryPending: boolean })
          .workflowDetailsRetryPending
      ).toBe(true);

      (
        spaceStore as unknown as { workflowDetailsLoadGeneration: number }
      ).workflowDetailsLoadGeneration += 1;
      (
        spaceStore as unknown as { workflowDetailsRetryPending: boolean }
      ).workflowDetailsRetryPending = true;

      await vi.runOnlyPendingTimersAsync();

      expect(
        (spaceStore as unknown as { workflowDetailsRetryPending: boolean })
          .workflowDetailsRetryPending
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restarts pending workflow-detail retry on reconnect', async () => {
    mockWorkflowSummaries(['wf1']);
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureConfigData();
    mockHub.request.mockImplementation(async (method: string): Promise<any> => {
      if (method === 'spaceWorkflow.get') return null;
      return {};
    });
    await spaceStore.ensureWorkflowDetails();
    expect(spaceStore.workflowDetailsLoaded.value).toBe(false);

    mockWorkflowSummaries(['wf1']);
    await spaceStore.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spaceStore.workflowDetailsLoaded.value).toBe(true);
    expect(spaceStore.workflowDetails.value.map((w) => w.id)).toEqual(['wf1']);
  });

  it('preserves workflows created concurrently during fan-out', async () => {
    mockWorkflowSummaries(['wf1']);
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureConfigData();

    const base = mockHub.request.getMockImplementation();
    let injected = false;
    mockHub.request.mockImplementation(
      async (method: string, params?: Record<string, unknown>): Promise<any> => {
        const result = base ? await base(method, params) : {};
        if (!injected && method === 'spaceWorkflow.get') {
          injected = true;
          const newSummary = makeWorkflowSummary('wf-new');
          const newDetail = makeWorkflow('wf-new');
          spaceStore.workflows.value = [...spaceStore.workflows.value, newSummary];
          spaceStore.workflowDetails.value = [...spaceStore.workflowDetails.value, newDetail];
        }
        return result;
      }
    );

    await spaceStore.ensureWorkflowDetails();

    const ids = spaceStore.workflowDetails.value.map((w) => w.id).sort();
    expect(ids).toEqual(['wf-new', 'wf1']);
    expect(spaceStore.workflowDetailsLoaded.value).toBe(true);
  });

  it('prefers event-updated workflow details over stale fetch responses', async () => {
    mockWorkflowSummaries(['wf1']);
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureConfigData();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockHub.request.mockImplementation(
      async (method: string, params?: Record<string, unknown>): Promise<any> => {
        if (method === 'spaceWorkflow.get') {
          await gate;
          return { workflow: makeWorkflow((params?.id as string) ?? 'wf1') };
        }
        return {};
      }
    );

    const pending = spaceStore.ensureWorkflowDetails();
    const updatedWorkflow = { ...makeWorkflow('wf1'), name: 'Updated by event' };
    fireMockEvent('spaceWorkflow.updated', {
      sessionId: 'session-1',
      spaceId: 'space-1',
      workflow: updatedWorkflow,
    });
    release();
    await pending;

    expect(spaceStore.workflowDetails.value).toHaveLength(1);
    expect(spaceStore.workflowDetails.value[0]?.name).toBe('Updated by event');
  });

  it('drops stale workflow detail batches when load generation changes mid-fetch', async () => {
    mockWorkflowSummaries(['wf1']);
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureConfigData();

    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mockHub.request.mockImplementation(
      async (method: string, params?: Record<string, unknown>): Promise<any> => {
        if (method === 'spaceWorkflow.get') {
          await gate;
          return { workflow: makeWorkflow((params?.id as string) ?? 'wf1') };
        }
        return {};
      }
    );

    const pending = spaceStore.ensureWorkflowDetails();
    (
      spaceStore as unknown as { workflowDetailsLoadGeneration: number }
    ).workflowDetailsLoadGeneration += 1;
    release();
    await pending;

    expect(spaceStore.workflowDetails.value).toEqual([]);
    expect(spaceStore.workflowDetailsLoaded.value).toBe(false);
  });
});

describe('SpaceStore — promise-chain lock', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('handles rapid space switches atomically', async () => {
    const p1 = spaceStore.selectSpace('space-1');
    const p2 = spaceStore.selectSpace('space-2');

    await Promise.all([p1, p2]);

    expect(spaceStore.spaceId.value).toBe('space-2');
  });

  it('clears old space state when switching', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.tasks.value = [makeTask('t1')];

    await spaceStore.selectSpace('space-2');

    expect(spaceStore.tasks.value).toEqual([]);
    expect(spaceStore.spaceId.value).toBe('space-2');
  });

  it('future selectSpace calls still work after a doSelect error', async () => {
    mockHub.request.mockRejectedValueOnce(new Error('network error'));

    await spaceStore.selectSpace('space-1');
    expect(spaceStore.error.value).toBeTruthy();

    mockHub.request.mockImplementation(async (method: string) => {
      if (method === 'space.overview')
        return { space: makeSpace('space-2'), tasks: [], workflowRuns: [], sessions: [] };
      if (method === 'spaceAgent.list') return { agents: [] };
      if (method === 'spaceAgent.listBuiltInTemplates') return { templates: [] };
      if (method === 'spaceWorkflow.list') return { workflows: [] };
      return {};
    });

    await spaceStore.selectSpace('space-2');
    expect(spaceStore.spaceId.value).toBe('space-2');
  });
});

describe('SpaceStore — channel join/leave', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('joins space:${spaceId} channel on selectSpace()', async () => {
    await spaceStore.selectSpace('space-1');
    expect(mockHub.joinChannel).toHaveBeenCalledWith('space:space-1');
  });

  it('leaves space:${spaceId} channel on clearSpace()', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.clearSpace();
    expect(mockHub.leaveChannel).toHaveBeenCalledWith('space:space-1');
  });

  it('leaves old channel and joins new channel on space switch', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.selectSpace('space-2');

    expect(mockHub.leaveChannel).toHaveBeenCalledWith('space:space-1');
    expect(mockHub.joinChannel).toHaveBeenCalledWith('space:space-2');
  });
});

describe('SpaceStore — event subscriptions auto-cleanup', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('registers event handlers on selectSpace()', async () => {
    await spaceStore.selectSpace('space-1');

    expect(mockEventHandlers.has('space.updated')).toBe(true);
    expect(mockEventHandlers.has('space.archived')).toBe(true);
    expect(mockEventHandlers.has('space.deleted')).toBe(true);
    expect(mockEventHandlers.has('space.task.created')).toBe(true);
    expect(mockEventHandlers.has('space.task.updated')).toBe(true);
    expect(mockEventHandlers.has('space.workflowRun.created')).toBe(true);
    expect(mockEventHandlers.has('space.workflowRun.updated')).toBe(true);
    expect(mockEventHandlers.has('spaceAgent.created')).toBe(true);
    expect(mockEventHandlers.has('spaceAgent.updated')).toBe(true);
    expect(mockEventHandlers.has('spaceAgent.deleted')).toBe(true);
    expect(mockEventHandlers.has('spaceLongHorizonAgent.created')).toBe(true);
    expect(mockEventHandlers.has('spaceLongHorizonAgent.updated')).toBe(true);
    expect(mockEventHandlers.has('spaceLongHorizonAgent.deleted')).toBe(true);
    expect(mockEventHandlers.has('spaceWorkflow.created')).toBe(true);
    expect(mockEventHandlers.has('spaceWorkflow.updated')).toBe(true);
    expect(mockEventHandlers.has('spaceWorkflow.deleted')).toBe(true);
  });

  it('removes event handlers on clearSpace()', async () => {
    await spaceStore.selectSpace('space-1');
    expect(mockEventHandlers.size).toBeGreaterThan(0);

    await spaceStore.clearSpace();
    expect(mockEventHandlers.size).toBe(0);
  });

  it('removes old handlers when switching spaces', async () => {
    await spaceStore.selectSpace('space-1');
    const firstSpaceHandlerCount = mockEventHandlers.size;
    expect(firstSpaceHandlerCount).toBeGreaterThan(0);

    await spaceStore.selectSpace('space-2');
    expect(mockEventHandlers.size).toBeGreaterThan(0);
  });
});

describe('SpaceStore — space.updated event', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('merges partial space update into space signal', async () => {
    await spaceStore.selectSpace('space-1');
    expect(spaceStore.space.value?.name).toBe('Test Space');

    const handler = mockEventHandlers.get('space.updated');
    expect(handler).toBeDefined();

    handler?.({ sessionId: 'global', spaceId: 'space-1', space: { name: 'Renamed Space' } });

    expect(spaceStore.space.value?.name).toBe('Renamed Space');
    expect(spaceStore.space.value?.workspacePath).toBe('/workspace');
  });

  it('ignores space.updated event with no space payload', async () => {
    await spaceStore.selectSpace('space-1');
    const originalName = spaceStore.space.value?.name;

    const handler = mockEventHandlers.get('space.updated');
    handler?.({ sessionId: 'global', spaceId: 'space-1' });

    expect(spaceStore.space.value?.name).toBe(originalName);
  });

  it('ignores space.updated event for a different space', async () => {
    await spaceStore.selectSpace('space-1');
    const originalName = spaceStore.space.value?.name;

    const handler = mockEventHandlers.get('space.updated');
    handler?.({ sessionId: 'global', spaceId: 'space-99', space: { name: 'Other' } });

    expect(spaceStore.space.value?.name).toBe(originalName);
  });
});

describe('SpaceStore — space.archived event', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('clears selection when space is archived externally', async () => {
    await spaceStore.selectSpace('space-1');
    expect(spaceStore.spaceId.value).toBe('space-1');

    const handler = mockEventHandlers.get('space.archived');
    handler?.({ sessionId: 'global', spaceId: 'space-1', space: makeSpace() });

    await new Promise((r) => setTimeout(r, 0));

    expect(spaceStore.spaceId.value).toBeNull();
  });

  it('ignores space.archived event for a different space', async () => {
    await spaceStore.selectSpace('space-1');

    const handler = mockEventHandlers.get('space.archived');
    handler?.({ sessionId: 'global', spaceId: 'space-99', space: makeSpace('space-99') });

    await new Promise((r) => setTimeout(r, 0));

    expect(spaceStore.spaceId.value).toBe('space-1');
  });
});

describe('SpaceStore — space.deleted event', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('clears selection when space is deleted externally', async () => {
    await spaceStore.selectSpace('space-1');
    expect(spaceStore.spaceId.value).toBe('space-1');

    const handler = mockEventHandlers.get('space.deleted');
    handler?.({ sessionId: 'global', spaceId: 'space-1' });

    await new Promise((r) => setTimeout(r, 0));

    expect(spaceStore.spaceId.value).toBeNull();
  });

  it('ignores space.deleted event for a different space', async () => {
    await spaceStore.selectSpace('space-1');

    const handler = mockEventHandlers.get('space.deleted');
    handler?.({ sessionId: 'global', spaceId: 'space-99' });

    await new Promise((r) => setTimeout(r, 0));

    expect(spaceStore.spaceId.value).toBe('space-1');
  });
});

describe('SpaceStore — space.task.created event', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('appends a new task', async () => {
    await spaceStore.selectSpace('space-1');

    const handler = mockEventHandlers.get('space.task.created');
    expect(handler).toBeDefined();

    const task = makeTask('new-t');
    handler?.({ sessionId: 'global', spaceId: 'space-1', taskId: 'new-t', task });

    expect(spaceStore.tasks.value).toContainEqual(task);
  });

  it('does not append duplicate tasks', async () => {
    await spaceStore.selectSpace('space-1');
    const task = makeTask('dup');
    spaceStore.tasks.value = [task];

    const handler = mockEventHandlers.get('space.task.created');
    handler?.({ sessionId: 'global', spaceId: 'space-1', taskId: 'dup', task });

    expect(spaceStore.tasks.value.length).toBe(1);
  });

  it('ignores events for a different space', async () => {
    await spaceStore.selectSpace('space-1');
    const task = makeTask('other');

    const handler = mockEventHandlers.get('space.task.created');
    handler?.({ sessionId: 'global', spaceId: 'space-99', taskId: 'other', task });

    expect(spaceStore.tasks.value).not.toContainEqual(task);
  });
});

describe('SpaceStore — space.task.updated event', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('replaces an existing task', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.tasks.value = [makeTask('t1', 'pending')];

    const updated = makeTask('t1', 'in_progress');
    const handler = mockEventHandlers.get('space.task.updated');
    handler?.({ sessionId: 'global', spaceId: 'space-1', taskId: 't1', task: updated });

    expect(spaceStore.tasks.value[0].status).toBe('in_progress');
  });

  it('appends task if not yet in list', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.tasks.value = [];

    const task = makeTask('t2', 'in_progress');
    const handler = mockEventHandlers.get('space.task.updated');
    handler?.({ sessionId: 'global', spaceId: 'space-1', taskId: 't2', task });

    expect(spaceStore.tasks.value).toContainEqual(task);
  });

  it('ignores events for a different space', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.tasks.value = [makeTask('t1', 'pending')];

    const updated = makeTask('t1', 'in_progress');
    const handler = mockEventHandlers.get('space.task.updated');
    handler?.({ sessionId: 'global', spaceId: 'space-99', taskId: 't1', task: updated });

    expect(spaceStore.tasks.value[0].status).toBe('pending');
  });
});

describe('SpaceStore — space.workflowRun.created event', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('appends a new workflow run', async () => {
    await spaceStore.selectSpace('space-1');

    const run = makeRun('run-1');
    const handler = mockEventHandlers.get('space.workflowRun.created');
    handler?.({ sessionId: 'global', spaceId: 'space-1', runId: 'run-1', run });

    expect(spaceStore.workflowRuns.value).toContainEqual(run);
  });

  it('does not append duplicate runs', async () => {
    await spaceStore.selectSpace('space-1');
    const run = makeRun('run-dup');
    spaceStore.workflowRuns.value = [run];

    const handler = mockEventHandlers.get('space.workflowRun.created');
    handler?.({ sessionId: 'global', spaceId: 'space-1', runId: 'run-dup', run });

    expect(spaceStore.workflowRuns.value.length).toBe(1);
  });

  it('ignores events for a different space', async () => {
    await spaceStore.selectSpace('space-1');
    const run = makeRun('run-other');

    const handler = mockEventHandlers.get('space.workflowRun.created');
    handler?.({ sessionId: 'global', spaceId: 'space-99', runId: 'run-other', run });

    expect(spaceStore.workflowRuns.value.length).toBe(0);
  });
});

describe('SpaceStore — space.workflowRun.updated event', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('merges partial update into existing run', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.workflowRuns.value = [makeRun('run-1', 'pending')];

    const handler = mockEventHandlers.get('space.workflowRun.updated');
    handler?.({
      sessionId: 'global',
      spaceId: 'space-1',
      runId: 'run-1',
      run: { status: 'in_progress' },
    });

    expect(spaceStore.workflowRuns.value[0].status).toBe('in_progress');
  });

  it('ignores update with no run payload', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.workflowRuns.value = [makeRun('run-1', 'pending')];

    const handler = mockEventHandlers.get('space.workflowRun.updated');
    handler?.({ sessionId: 'global', spaceId: 'space-1', runId: 'run-1' });

    expect(spaceStore.workflowRuns.value[0].status).toBe('pending');
  });
});

describe('SpaceStore — spaceAgent events', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('appends new agent on created event', async () => {
    await spaceStore.selectSpace('space-1');
    const agent = makeAgent('a1');

    const handler = mockEventHandlers.get('spaceAgent.created');
    handler?.({ sessionId: 'global', spaceId: 'space-1', agent });

    expect(spaceStore.agents.value).toContainEqual(agent);
  });

  it('replaces agent on updated event', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.agents.value = [{ ...makeAgent('a1'), name: 'Old Name' }];

    const updated = { ...makeAgent('a1'), name: 'New Name' };
    const handler = mockEventHandlers.get('spaceAgent.updated');
    handler?.({ sessionId: 'global', spaceId: 'space-1', agent: updated });

    expect(spaceStore.agents.value[0].name).toBe('New Name');
  });

  it('removes agent on deleted event', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.agents.value = [makeAgent('a1'), makeAgent('a2')];

    const handler = mockEventHandlers.get('spaceAgent.deleted');
    handler?.({ sessionId: 'global', spaceId: 'space-1', agentId: 'a1' });

    expect(spaceStore.agents.value.map((a) => a.id)).toEqual(['a2']);
  });

  it('ignores events for a different space', async () => {
    await spaceStore.selectSpace('space-1');
    const handler = mockEventHandlers.get('spaceAgent.created');
    handler?.({ sessionId: 'global', spaceId: 'space-99', agent: makeAgent('a1') });

    expect(spaceStore.agents.value.length).toBe(0);
  });
});

describe('SpaceStore — spaceLongHorizonAgent events', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('appends new long-horizon agent on created event', async () => {
    await spaceStore.selectSpace('space-1');
    const agent = makeLongHorizonAgent('lh1');

    const handler = mockEventHandlers.get('spaceLongHorizonAgent.created');
    handler?.({ sessionId: 'global', spaceId: 'space-1', agent });

    expect(spaceStore.longHorizonAgents.value).toContainEqual(agent);
  });

  it('does not append duplicate long-horizon agents on created event', async () => {
    await spaceStore.selectSpace('space-1');
    const agent = makeLongHorizonAgent('lh1');
    spaceStore.longHorizonAgents.value = [agent];

    const handler = mockEventHandlers.get('spaceLongHorizonAgent.created');
    handler?.({ sessionId: 'global', spaceId: 'space-1', agent });

    expect(spaceStore.longHorizonAgents.value).toHaveLength(1);
  });

  it('replaces long-horizon agent on updated event', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.longHorizonAgents.value = [
      { ...makeLongHorizonAgent('lh1'), displayName: 'Old Name' },
    ];

    const updated = { ...makeLongHorizonAgent('lh1'), displayName: 'New Name' };
    const handler = mockEventHandlers.get('spaceLongHorizonAgent.updated');
    handler?.({ sessionId: 'global', spaceId: 'space-1', agent: updated });

    expect(spaceStore.longHorizonAgents.value[0].displayName).toBe('New Name');
  });

  it('appends long-horizon agent on updated event when not loaded yet', async () => {
    await spaceStore.selectSpace('space-1');
    const agent = makeLongHorizonAgent('lh1');

    const handler = mockEventHandlers.get('spaceLongHorizonAgent.updated');
    handler?.({ sessionId: 'global', spaceId: 'space-1', agent });

    expect(spaceStore.longHorizonAgents.value).toContainEqual(agent);
  });

  it('removes long-horizon agent on deleted event', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.longHorizonAgents.value = [makeLongHorizonAgent('lh1'), makeLongHorizonAgent('lh2')];

    const handler = mockEventHandlers.get('spaceLongHorizonAgent.deleted');
    handler?.({ sessionId: 'global', spaceId: 'space-1', agentId: 'lh1' });

    expect(spaceStore.longHorizonAgents.value.map((a) => a.id)).toEqual(['lh2']);
  });

  it('ignores long-horizon agent events for a different space', async () => {
    await spaceStore.selectSpace('space-1');
    const handler = mockEventHandlers.get('spaceLongHorizonAgent.created');
    handler?.({ sessionId: 'global', spaceId: 'space-99', agent: makeLongHorizonAgent('lh1') });

    expect(spaceStore.longHorizonAgents.value.length).toBe(0);
  });
});

describe('SpaceStore — spaceWorkflow events', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('appends new workflow on created event', async () => {
    await spaceStore.selectSpace('space-1');
    const wf = makeWorkflow('wf1');

    const handler = mockEventHandlers.get('spaceWorkflow.created');
    handler?.({ sessionId: 'global', spaceId: 'space-1', workflow: wf });

    expect(spaceStore.workflows.value).toContainEqual(
      expect.objectContaining({ id: 'wf1', name: 'Workflow wf1' })
    );
  });

  it('replaces workflow on updated event', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.workflows.value = [makeWorkflowSummary('wf1')];
    spaceStore.workflows.value[0].name = 'Old';

    const updated = makeWorkflow('wf1');
    updated.name = 'New';
    const handler = mockEventHandlers.get('spaceWorkflow.updated');
    handler?.({ sessionId: 'global', spaceId: 'space-1', workflow: updated });

    expect(spaceStore.workflows.value[0].name).toBe('New');
  });

  it('removes workflow on deleted event', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.workflows.value = [makeWorkflowSummary('wf1'), makeWorkflowSummary('wf2')];

    const handler = mockEventHandlers.get('spaceWorkflow.deleted');
    handler?.({ sessionId: 'global', spaceId: 'space-1', workflowId: 'wf1' });

    expect(spaceStore.workflows.value.map((w) => w.id)).toEqual(['wf2']);
  });

  it('ignores events for a different space', async () => {
    await spaceStore.selectSpace('space-1');
    const handler = mockEventHandlers.get('spaceWorkflow.deleted');
    spaceStore.workflows.value = [makeWorkflowSummary('wf1')];

    handler?.({ sessionId: 'global', spaceId: 'space-99', workflowId: 'wf1' });

    expect(spaceStore.workflows.value.length).toBe(1);
  });
});

describe('SpaceStore — computed signals', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('activeTasks filters in_progress tasks', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.tasks.value = [
      makeTask('t1', 'pending'),
      makeTask('t2', 'in_progress'),
      makeTask('t3', 'in_progress'),
      makeTask('t4', 'completed'),
    ];

    expect(spaceStore.activeTasks.value.map((t) => t.id)).toEqual(['t2', 't3']);
  });

  it('activeRuns filters pending and in_progress runs', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.workflowRuns.value = [
      makeRun('r1', 'pending'),
      makeRun('r2', 'in_progress'),
      makeRun('r3', 'completed'),
      makeRun('r4', 'cancelled'),
    ];

    const activeIds = spaceStore.activeRuns.value.map((r) => r.id);
    expect(activeIds).toEqual(['r1', 'r2']);
  });

  it('tasksByRun groups tasks by workflowRunId', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.tasks.value = [
      makeTask('t1', 'pending', 'run-1'),
      makeTask('t2', 'pending', 'run-1'),
      makeTask('t3', 'pending', 'run-2'),
      makeTask('t4', 'pending'),
    ];

    const byRun = spaceStore.tasksByRun.value;
    expect(byRun.get('run-1')?.map((t) => t.id)).toEqual(['t1', 't2']);
    expect(byRun.get('run-2')?.map((t) => t.id)).toEqual(['t3']);
    expect(byRun.has('undefined')).toBe(false);
  });

  it('standaloneTasks returns tasks without a workflowRunId', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.tasks.value = [
      makeTask('t1', 'pending', 'run-1'),
      makeTask('t2', 'pending'),
      makeTask('t3', 'pending'),
    ];

    expect(spaceStore.standaloneTasks.value.map((t) => t.id)).toEqual(['t2', 't3']);
  });

  it('computed signals update reactively', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.tasks.value = [makeTask('t1', 'pending')];
    expect(spaceStore.activeTasks.value.length).toBe(0);

    spaceStore.tasks.value = [makeTask('t1', 'in_progress')];
    expect(spaceStore.activeTasks.value.length).toBe(1);
  });
});

describe('SpaceStore — task visibility after real-time events', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('task.created event makes the task immediately visible in tasks signal', async () => {
    await spaceStore.selectSpace('space-1');
    expect(spaceStore.tasks.value).toEqual([]);

    const task = makeTask('t-new', 'open');
    const handler = mockEventHandlers.get('space.task.created');
    handler?.({ sessionId: 'global', spaceId: 'space-1', taskId: 't-new', task });

    expect(spaceStore.tasks.value).toHaveLength(1);
    expect(spaceStore.tasks.value[0].id).toBe('t-new');
  });

  it('task.created event updates computed activeTasks when task is in_progress', async () => {
    await spaceStore.selectSpace('space-1');

    const task = makeTask('t-active', 'in_progress');
    const handler = mockEventHandlers.get('space.task.created');
    handler?.({ sessionId: 'global', spaceId: 'space-1', taskId: 't-active', task });

    expect(spaceStore.activeTasks.value).toHaveLength(1);
    expect(spaceStore.activeTasks.value[0].id).toBe('t-active');
  });

  it('task.updated event updates computed activeTasks reactively', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.tasks.value = [makeTask('t1', 'open')];
    expect(spaceStore.activeTasks.value).toHaveLength(0);

    const updated = makeTask('t1', 'in_progress');
    const handler = mockEventHandlers.get('space.task.updated');
    handler?.({ sessionId: 'global', spaceId: 'space-1', taskId: 't1', task: updated });

    expect(spaceStore.activeTasks.value).toHaveLength(1);
    expect(spaceStore.activeTasks.value[0].status).toBe('in_progress');
  });

  it('task.created with workflowRunId updates tasksByRun computed', async () => {
    await spaceStore.selectSpace('space-1');

    const task = makeTask('t-wf', 'open', 'run-1');
    const handler = mockEventHandlers.get('space.task.created');
    handler?.({ sessionId: 'global', spaceId: 'space-1', taskId: 't-wf', task });

    expect(spaceStore.tasksByRun.value.get('run-1')).toHaveLength(1);
    expect(spaceStore.standaloneTasks.value).toHaveLength(0);
  });

  it('task.created without workflowRunId updates standaloneTasks computed', async () => {
    await spaceStore.selectSpace('space-1');

    const task = makeTask('t-solo', 'open');
    const handler = mockEventHandlers.get('space.task.created');
    handler?.({ sessionId: 'global', spaceId: 'space-1', taskId: 't-solo', task });

    expect(spaceStore.standaloneTasks.value).toHaveLength(1);
    expect(spaceStore.standaloneTasks.value[0].id).toBe('t-solo');
  });

  it('multiple rapid task.created events accumulate correctly', async () => {
    await spaceStore.selectSpace('space-1');
    const handler = mockEventHandlers.get('space.task.created');

    handler?.({
      sessionId: 'global',
      spaceId: 'space-1',
      taskId: 't1',
      task: makeTask('t1', 'open'),
    });
    handler?.({
      sessionId: 'global',
      spaceId: 'space-1',
      taskId: 't2',
      task: makeTask('t2', 'in_progress'),
    });
    handler?.({
      sessionId: 'global',
      spaceId: 'space-1',
      taskId: 't3',
      task: makeTask('t3', 'blocked'),
    });

    expect(spaceStore.tasks.value).toHaveLength(3);
    expect(spaceStore.activeTasks.value).toHaveLength(1);
  });

  it('task status transition from in_progress to done removes from activeTasks', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.tasks.value = [makeTask('t1', 'in_progress')];
    expect(spaceStore.activeTasks.value).toHaveLength(1);

    const updated = makeTask('t1', 'done');
    const handler = mockEventHandlers.get('space.task.updated');
    handler?.({ sessionId: 'global', spaceId: 'space-1', taskId: 't1', task: updated });

    expect(spaceStore.activeTasks.value).toHaveLength(0);
    expect(spaceStore.tasks.value[0].status).toBe('done');
  });
});

describe('SpaceStore — CRUD methods', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('updateSpace calls space.update RPC and applies direct response', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.updateSpace({ name: 'New Name' });

    expect(mockHub.request).toHaveBeenCalledWith('space.update', {
      id: 'space-1',
      name: 'New Name',
    });
    expect(spaceStore.space.value?.id).toBe('space-1');
  });

  it('archiveSpace calls space.archive RPC and clears selection', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.archiveSpace();

    expect(mockHub.request).toHaveBeenCalledWith('space.archive', { id: 'space-1' });
    expect(spaceStore.spaceId.value).toBeNull();
  });

  it('deleteSpace calls space.delete RPC and clears selection', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.deleteSpace();

    expect(mockHub.request).toHaveBeenCalledWith('space.delete', { id: 'space-1' });
    expect(spaceStore.spaceId.value).toBeNull();
  });

  it('createTask calls spaceTask.create RPC and returns SpaceTask', async () => {
    await spaceStore.selectSpace('space-1');
    const task = await spaceStore.createTask({ title: 'New Task', description: 'desc' });

    expect(mockHub.request).toHaveBeenCalledWith('spaceTask.create', {
      spaceId: 'space-1',
      title: 'New Task',
      description: 'desc',
    });
    expect(task.id).toBe('new-task');
  });

  it('listWorkspaces calls space.workspace.list RPC and returns workspaces', async () => {
    await spaceStore.selectSpace('space-1');
    const workspaces = await spaceStore.listWorkspaces();

    expect(mockHub.request).toHaveBeenCalledWith('space.workspace.list', { spaceId: 'space-1' });
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].path).toBe('/workspace');
    expect(workspaces[0].isPrimary).toBe(true);
  });

  it('updateTask calls spaceTask.update RPC with taskId (not id)', async () => {
    await spaceStore.selectSpace('space-1');
    const task = await spaceStore.updateTask('t1', { status: 'in_progress' });

    expect(mockHub.request).toHaveBeenCalledWith('spaceTask.update', {
      taskId: 't1',
      spaceId: 'space-1',
      status: 'in_progress',
    });
    expect(task.status).toBe('in_progress');
  });

  it('recoverWorkflowTask calls spaceTask.recoverWorkflow RPC', async () => {
    await spaceStore.selectSpace('space-1');
    const task = await spaceStore.recoverWorkflowTask('t1', 'in_progress');

    expect(mockHub.request).toHaveBeenCalledWith('spaceTask.recoverWorkflow', {
      taskId: 't1',
      spaceId: 'space-1',
      status: 'in_progress',
    });
    expect(task.status).toBe('in_progress');
  });

  it('listGoals calls spaceGoal.list RPC and updates goal state', async () => {
    await spaceStore.selectSpace('space-1');
    const goal = makeGoal({ id: 'goal-a', title: 'Alpha' });
    mockHub.request.mockResolvedValueOnce({ goals: [goal] } as Awaited<
      ReturnType<typeof mockHub.request>
    >);

    const goals = await spaceStore.listGoals({ includeArchived: true });

    expect(mockHub.request).toHaveBeenLastCalledWith('spaceGoal.list', {
      spaceId: 'space-1',
      includeArchived: true,
    });
    expect(goals).toEqual([goal]);
    expect(spaceStore.goals.value).toEqual([goal]);
  });

  it('listGoals ignores stale responses from older filter requests', async () => {
    await spaceStore.selectSpace('space-1');
    const activeGoal = makeGoal({ id: 'active-goal', status: 'active' });
    const archivedGoal = makeGoal({ id: 'archived-goal', status: 'archived' });
    let resolveFirst: (value: { goals: SpaceGoal[] }) => void = () => {};
    mockHub.request.mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof mockHub.request>>>((resolve) => {
          resolveFirst = (value) => resolve(value as Awaited<ReturnType<typeof mockHub.request>>);
        })
    );
    mockHub.request.mockResolvedValueOnce({ goals: [activeGoal, archivedGoal] } as Awaited<
      ReturnType<typeof mockHub.request>
    >);

    const first = spaceStore.listGoals({ includeArchived: false });
    const second = await spaceStore.listGoals({ includeArchived: true });
    resolveFirst({ goals: [activeGoal] });
    await first;

    expect(second).toEqual([activeGoal, archivedGoal]);
    expect(spaceStore.goals.value).toEqual([activeGoal, archivedGoal]);
  });

  it('listGoals ignores stale responses after newer goal mutations', async () => {
    await spaceStore.selectSpace('space-1');
    const staleGoal = makeGoal({ id: 'goal-1', title: 'Before update' });
    let resolveList: (value: { goals: SpaceGoal[] }) => void = () => {};
    mockHub.request.mockImplementationOnce(
      () =>
        new Promise<Awaited<ReturnType<typeof mockHub.request>>>((resolve) => {
          resolveList = (value) => resolve(value as Awaited<ReturnType<typeof mockHub.request>>);
        })
    );
    const listPromise = spaceStore.listGoals({ includeArchived: false });

    await spaceStore.updateGoal('goal-1', { title: 'After update' });
    resolveList({ goals: [staleGoal] });
    await listPromise;

    expect(spaceStore.goals.value).toMatchObject([{ id: 'goal-1', title: 'After update' }]);
  });

  it('createGoal and updateGoal call goal RPCs with current space', async () => {
    await spaceStore.selectSpace('space-1');

    await spaceStore.createGoal({ title: 'New goal', labels: ['release'] });
    expect(mockHub.request).toHaveBeenLastCalledWith('spaceGoal.create', {
      spaceId: 'space-1',
      title: 'New goal',
      labels: ['release'],
    });

    await spaceStore.updateGoal('goal-1', { progress: 50, autoTriggerNext: true });
    expect(mockHub.request).toHaveBeenLastCalledWith('spaceGoal.update', {
      spaceId: 'space-1',
      goalId: 'goal-1',
      progress: 50,
      autoTriggerNext: true,
    });
  });

  it('goal actions update goals and immediate tasks in local state', async () => {
    await spaceStore.selectSpace('space-1');

    const paused = await spaceStore.pauseGoal('goal-1');
    expect(mockHub.request).toHaveBeenLastCalledWith('spaceGoal.pause', {
      spaceId: 'space-1',
      goalId: 'goal-1',
    });
    expect(paused.status).toBe('paused');

    const resumed = await spaceStore.resumeGoal('goal-1');
    expect(mockHub.request).toHaveBeenLastCalledWith('spaceGoal.resume', {
      spaceId: 'space-1',
      goalId: 'goal-1',
    });
    expect(resumed.status).toBe('active');

    const result = await spaceStore.createImmediateGoalTask('goal-1');
    expect(mockHub.request).toHaveBeenLastCalledWith('spaceGoal.createImmediateTask', {
      spaceId: 'space-1',
      goalId: 'goal-1',
    });
    expect(result.queued).toBe(false);
    expect(spaceStore.tasks.value.some((task) => task.id === 'goal-task')).toBe(true);
  });

  it('listGoalEvents stores events by goal id', async () => {
    await spaceStore.selectSpace('space-1');

    const events = await spaceStore.listGoalEvents('goal-1');

    expect(mockHub.request).toHaveBeenLastCalledWith('spaceGoal.listEvents', {
      spaceId: 'space-1',
      goalId: 'goal-1',
      limit: 20,
    });
    expect(events).toHaveLength(1);
    expect(spaceStore.goalEvents.value.get('goal-1')).toEqual(events);
  });

  it('subscribeTaskActivity subscribes to LiveQuery and applies snapshots', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.subscribeTaskActivity('t1');
    const rows = makeTaskActivityRows('t1');

    expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
      queryName: 'spaceTaskActivity.byTask',
      params: ['t1'],
      subscriptionId: 'spaceTaskActivity-t1',
    });
    fireMockEvent('liveQuery.snapshot', {
      subscriptionId: 'spaceTaskActivity-t1',
      rows,
      version: 1,
    });
    expect(spaceStore.taskActivity.value.get('t1')).toEqual(rows);
  });

  it('subscribeTaskActivity applies deltas and unsubscribeTaskActivity tears down the subscription', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.subscribeTaskActivity('t1');
    const rows = makeTaskActivityRows('t1');
    fireMockEvent('liveQuery.snapshot', {
      subscriptionId: 'spaceTaskActivity-t1',
      rows,
      version: 1,
    });

    const updatedRow = { ...rows[0], state: 'waiting_for_input' as const };
    fireMockEvent('liveQuery.delta', {
      subscriptionId: 'spaceTaskActivity-t1',
      updated: [updatedRow],
      version: 2,
    });
    expect(spaceStore.taskActivity.value.get('t1')).toEqual([updatedRow]);

    spaceStore.unsubscribeTaskActivity();
    expect(mockHub.request).toHaveBeenCalledWith('liveQuery.unsubscribe', {
      subscriptionId: 'spaceTaskActivity-t1',
    });
  });

  it('subscribeTaskMessageActivity subscribes to the compact messages LiveQuery and stores the row count', async () => {
    await spaceStore.selectSpace('space-1');
    expect(spaceStore.hasTaskMessageActivity('t1')).toBeNull();

    await spaceStore.subscribeTaskMessageActivity('t1');

    expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
      queryName: 'spaceTaskMessages.byTask.compact',
      params: ['t1'],
      subscriptionId: 'spaceTaskMessageActivity-t1',
    });
    fireMockEvent('liveQuery.snapshot', {
      subscriptionId: 'spaceTaskMessageActivity-t1',
      rows: [{ id: 'm1' }, { id: 'm2' }],
      version: 1,
    });
    expect(spaceStore.taskMessageActivity.value.get('t1')).toBe(2);
    expect(spaceStore.hasTaskMessageActivity('t1')).toBe(true);
  });

  it('subscribeTaskMessageActivity stores zero counts and applies added/removed deltas', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.subscribeTaskMessageActivity('t1');
    fireMockEvent('liveQuery.snapshot', {
      subscriptionId: 'spaceTaskMessageActivity-t1',
      rows: [],
      version: 1,
    });
    expect(spaceStore.taskMessageActivity.value.get('t1')).toBe(0);
    expect(spaceStore.hasTaskMessageActivity('t1')).toBe(false);

    fireMockEvent('liveQuery.delta', {
      subscriptionId: 'spaceTaskMessageActivity-t1',
      added: [{ id: 'm1' }, { id: 'm2' }],
      version: 2,
    });
    expect(spaceStore.taskMessageActivity.value.get('t1')).toBe(2);
    expect(spaceStore.hasTaskMessageActivity('t1')).toBe(true);

    fireMockEvent('liveQuery.delta', {
      subscriptionId: 'spaceTaskMessageActivity-t1',
      removed: [{ id: 'm1' }, { id: 'm2' }],
      version: 3,
    });
    expect(spaceStore.taskMessageActivity.value.get('t1')).toBe(0);
    expect(spaceStore.hasTaskMessageActivity('t1')).toBe(false);
  });

  it('unsubscribeTaskMessageActivity tears down the compact messages subscription', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.subscribeTaskMessageActivity('t1');

    spaceStore.unsubscribeTaskMessageActivity();
    expect(mockHub.request).toHaveBeenCalledWith('liveQuery.unsubscribe', {
      subscriptionId: 'spaceTaskMessageActivity-t1',
    });

    fireMockEvent('liveQuery.snapshot', {
      subscriptionId: 'spaceTaskMessageActivity-t1',
      rows: [{ id: 'm1' }],
      version: 2,
    });
    expect(spaceStore.taskMessageActivity.value.get('t1')).toBeUndefined();
  });

  it('createAgent calls spaceAgent.create RPC and upserts returned agent', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.createAgent({ name: 'Coder' });

    expect(mockHub.request).toHaveBeenCalledWith('spaceAgent.create', {
      spaceId: 'space-1',
      name: 'Coder',
    });
    expect(spaceStore.agents.value.some((agent) => agent.id === 'new-agent')).toBe(true);
  });

  it('getAgentPromotionDraft calls spaceAgent.getPromotionDraft RPC', async () => {
    await spaceStore.selectSpace('space-1');
    const draft = await spaceStore.getAgentPromotionDraft('session-1');

    expect(draft.name).toBe('Promoted Agent');
    expect(mockHub.request).toHaveBeenCalledWith('spaceAgent.getPromotionDraft', {
      spaceId: 'space-1',
      sessionId: 'session-1',
    });
  });

  it('promoteSessionToAgent calls spaceAgent.promoteSession RPC', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.promoteSessionToAgent('session-1', {
      name: 'Promoted Agent',
      customPrompt: 'Reviewed profile',
    });

    expect(mockHub.request).toHaveBeenCalledWith('spaceAgent.promoteSession', {
      spaceId: 'space-1',
      sessionId: 'session-1',
      name: 'Promoted Agent',
      customPrompt: 'Reviewed profile',
    });
  });

  it('updateAgent calls spaceAgent.update RPC and upserts returned agent', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.updateAgent('a1', { name: 'Renamed' });

    expect(mockHub.request).toHaveBeenCalledWith('spaceAgent.update', {
      id: 'a1',
      spaceId: 'space-1',
      name: 'Renamed',
    });
    expect(spaceStore.agents.value.some((agent) => agent.id === 'a1')).toBe(true);
  });

  it('syncAgentFromTemplate calls spaceAgent.syncFromTemplate RPC and upserts returned agent', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.syncAgentFromTemplate('a1');

    expect(mockHub.request).toHaveBeenCalledWith('spaceAgent.syncFromTemplate', {
      spaceId: 'space-1',
      agentId: 'a1',
    });
    expect(spaceStore.agents.value.some((agent) => agent.id === 'a1')).toBe(true);
  });

  it('previewAgentTemplateSync calls spaceAgent.previewTemplateSync RPC and returns the preview', async () => {
    await spaceStore.selectSpace('space-1');

    const preview = await spaceStore.previewAgentTemplateSync('a1');

    expect(mockHub.request).toHaveBeenCalledWith('spaceAgent.previewTemplateSync', {
      spaceId: 'space-1',
      agentId: 'a1',
    });
    expect(preview.agentId).toBe('a1');
    expect(preview.updateAvailable).toBe(true);
    expect(preview.customized).toBe(true);
    expect(preview.diff.customPrompt?.after).toBe('new prompt');
  });

  it('previewWorkflowTemplateSync calls spaceWorkflow.previewTemplateSync RPC and returns the preview', async () => {
    await spaceStore.selectSpace('space-1');

    const preview = await spaceStore.previewWorkflowTemplateSync('wf1');

    expect(mockHub.request).toHaveBeenCalledWith('spaceWorkflow.previewTemplateSync', {
      id: 'wf1',
      spaceId: 'space-1',
    });
    expect(preview.workflowId).toBe('wf1');
    expect(preview.updateAvailable).toBe(true);
    expect(preview.customized).toBe(true);
    expect(preview.diff.description?.after).toBe('new desc');
  });

  it('ignores returned agent when the active space changes before the request resolves', async () => {
    await spaceStore.selectSpace('space-1');
    let resolveRequest: (value: { agent: SpaceWorkerAgent }) => void = () => {};
    mockHub.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        })
    );

    const request = spaceStore.createAgent({ name: 'Coder' });
    await spaceStore.selectSpace('space-2');
    resolveRequest({ agent: makeAgent('stale-agent') });
    await request;

    expect(spaceStore.agents.value.some((agent) => agent.id === 'stale-agent')).toBe(false);
  });

  it('deleteAgent calls spaceAgent.delete RPC and removes the agent locally', async () => {
    await spaceStore.selectSpace('space-1');
    spaceStore.agents.value = [makeAgent('a1')];
    await spaceStore.deleteAgent('a1');

    expect(mockHub.request).toHaveBeenCalledWith('spaceAgent.delete', {
      id: 'a1',
      spaceId: 'space-1',
    });
    expect(spaceStore.agents.value.some((agent) => agent.id === 'a1')).toBe(false);
  });

  it('createLongHorizonAgent upserts RPC result already appended by created event', async () => {
    await spaceStore.selectSpace('space-1');

    const created = makeLongHorizonAgent('new-lh-agent');
    mockHub.request.mockImplementationOnce(async () => {
      mockEventHandlers.get('spaceLongHorizonAgent.created')?.({
        sessionId: 'space:space-1',
        spaceId: 'space-1',
        agent: created,
      });
      return { agent: created };
    });

    await spaceStore.createLongHorizonAgent({ id: 'new-lh-agent', handle: 'new-lh-agent' });

    expect(mockHub.request).toHaveBeenCalledWith('spaceLongHorizonAgent.create', {
      spaceId: 'space-1',
      id: 'new-lh-agent',
      handle: 'new-lh-agent',
    });
    expect(spaceStore.longHorizonAgents.value.map((agent) => agent.id)).toEqual(['new-lh-agent']);
  });

  it('long-horizon subscription methods call RPC with current space', async () => {
    await spaceStore.selectSpace('space-1');

    await spaceStore.listLongHorizonAgentSubscriptions('lh-1');
    await spaceStore.createLongHorizonAgentSubscription({
      agentId: 'lh-1',
      source: 'github',
      topic: 'github/*/*/pull_request/*',
      filter: { label: 'PRs' },
    });
    await spaceStore.updateLongHorizonAgentSubscription('sub-1', { status: 'paused' });
    await spaceStore.deleteLongHorizonAgentSubscription('sub-1');

    expect(mockHub.request).toHaveBeenCalledWith('spaceLongHorizonAgent.listSubscriptions', {
      agentId: 'lh-1',
      spaceId: 'space-1',
    });
    expect(mockHub.request).toHaveBeenCalledWith('spaceLongHorizonAgent.createSubscription', {
      agentId: 'lh-1',
      source: 'github',
      topic: 'github/*/*/pull_request/*',
      filter: { label: 'PRs' },
      spaceId: 'space-1',
    });
    expect(mockHub.request).toHaveBeenCalledWith('spaceLongHorizonAgent.updateSubscription', {
      subscriptionId: 'sub-1',
      spaceId: 'space-1',
      status: 'paused',
    });
    expect(mockHub.request).toHaveBeenCalledWith('spaceLongHorizonAgent.deleteSubscription', {
      subscriptionId: 'sub-1',
      spaceId: 'space-1',
    });
  });

  it('createWorkflow calls spaceWorkflow.create RPC', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.createWorkflow({ name: 'My Workflow' });

    expect(mockHub.request).toHaveBeenCalledWith('spaceWorkflow.create', {
      spaceId: 'space-1',
      name: 'My Workflow',
    });
  });

  it('updateWorkflow calls spaceWorkflow.update RPC', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.updateWorkflow('wf1', { name: 'Renamed' });

    expect(mockHub.request).toHaveBeenCalledWith('spaceWorkflow.update', {
      id: 'wf1',
      spaceId: 'space-1',
      name: 'Renamed',
    });
  });

  it('deleteWorkflow calls spaceWorkflow.delete RPC', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.deleteWorkflow('wf1');

    expect(mockHub.request).toHaveBeenCalledWith('spaceWorkflow.delete', {
      id: 'wf1',
      spaceId: 'space-1',
    });
  });

  it('throws when calling CRUD methods with no space selected', async () => {
    await spaceStore.clearSpace();

    await expect(spaceStore.createTask({ title: 'T', description: 'D' })).rejects.toThrow(
      'No space selected'
    );
    await expect(spaceStore.archiveSpace()).rejects.toThrow('No space selected');
    await expect(spaceStore.deleteSpace()).rejects.toThrow('No space selected');
    await expect(spaceStore.createAgent({ name: 'A' })).rejects.toThrow('No space selected');
    await expect(spaceStore.createWorkflow({ name: 'W' })).rejects.toThrow('No space selected');
  });

  it('pauseSpace calls space.pause RPC and updates space + runtimeState', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.pauseSpace();

    expect(mockHub.request).toHaveBeenCalledWith('space.pause', { id: 'space-1' });
    expect(spaceStore.space.value?.paused).toBe(true);
    expect(spaceStore.runtimeState.value).toBe('paused');
  });

  it('resumeSpace calls space.resume RPC and updates space + runtimeState', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.pauseSpace();
    expect(spaceStore.runtimeState.value).toBe('paused');

    await spaceStore.resumeSpace();

    expect(mockHub.request).toHaveBeenCalledWith('space.resume', { id: 'space-1' });
    expect(spaceStore.space.value?.paused).toBe(false);
    expect(spaceStore.runtimeState.value).toBe('running');
  });

  it('pauseSpace throws when no space selected', async () => {
    await spaceStore.clearSpace();
    await expect(spaceStore.pauseSpace()).rejects.toThrow('No space selected');
  });

  it('resumeSpace throws when no space selected', async () => {
    await spaceStore.clearSpace();
    await expect(spaceStore.resumeSpace()).rejects.toThrow('No space selected');
  });

  it('stopSpace calls space.stop RPC and updates space + runtimeState to stopped', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.stopSpace();

    expect(mockHub.request).toHaveBeenCalledWith('space.stop', { id: 'space-1' });
    expect(spaceStore.space.value?.stopped).toBe(true);
    expect(spaceStore.runtimeState.value).toBe('stopped');
  });

  it('startSpace calls space.start RPC and updates space + runtimeState to running', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.stopSpace();
    expect(spaceStore.runtimeState.value).toBe('stopped');

    await spaceStore.startSpace();

    expect(mockHub.request).toHaveBeenCalledWith('space.start', { id: 'space-1' });
    expect(spaceStore.space.value?.stopped).toBe(false);
    expect(spaceStore.runtimeState.value).toBe('running');
  });

  it('stopSpace throws when no space selected', async () => {
    await spaceStore.clearSpace();
    await expect(spaceStore.stopSpace()).rejects.toThrow('No space selected');
  });

  it('startSpace throws when no space selected', async () => {
    await spaceStore.clearSpace();
    await expect(spaceStore.startSpace()).rejects.toThrow('No space selected');
  });
});

describe('SpaceStore — runtimeState', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('runtimeState is "running" for active non-paused space', async () => {
    await spaceStore.selectSpace('space-1');
    expect(spaceStore.runtimeState.value).toBe('running');
  });

  it('runtimeState is "stopped" for archived space', async () => {
    mockHub.request.mockImplementation(async (method: string) => {
      if (method === 'space.overview') {
        return {
          space: { ...makeSpace(), status: 'archived' },
          tasks: [],
          workflowRuns: [],
          sessions: [],
        };
      }
      return {};
    });

    await spaceStore.selectSpace('space-1');
    expect(spaceStore.runtimeState.value).toBe('stopped');
  });

  it('runtimeState is "stopped" for stopped (non-archived) space', async () => {
    mockHub.request.mockImplementation(async (method: string) => {
      if (method === 'space.overview') {
        return {
          space: { ...makeSpace(), status: 'active', stopped: true },
          tasks: [],
          workflowRuns: [],
          sessions: [],
        };
      }
      return {};
    });

    await spaceStore.selectSpace('space-1');
    expect(spaceStore.runtimeState.value).toBe('stopped');
  });

  it('runtimeState is "paused" for paused space', async () => {
    mockHub.request.mockImplementation(async (method: string) => {
      if (method === 'space.overview') {
        return {
          space: { ...makeSpace(), paused: true },
          tasks: [],
          workflowRuns: [],
          sessions: [],
        };
      }
      return {};
    });

    await spaceStore.selectSpace('space-1');
    expect(spaceStore.runtimeState.value).toBe('paused');
  });

  it('runtimeState is null when no space is selected', async () => {
    await spaceStore.clearSpace();
    expect(spaceStore.runtimeState.value).toBeNull();
  });

  it('space.updated event with paused: true updates runtimeState to paused', async () => {
    await spaceStore.selectSpace('space-1');
    expect(spaceStore.runtimeState.value).toBe('running');

    fireMockEvent('space.updated', {
      spaceId: 'space-1',
      space: { paused: true },
    });

    expect(spaceStore.runtimeState.value).toBe('paused');
    expect(spaceStore.space.value?.paused).toBe(true);
  });

  it('space.updated event with paused: false updates runtimeState to running', async () => {
    await spaceStore.selectSpace('space-1');
    fireMockEvent('space.updated', {
      spaceId: 'space-1',
      space: { paused: true },
    });
    expect(spaceStore.runtimeState.value).toBe('paused');

    fireMockEvent('space.updated', {
      spaceId: 'space-1',
      space: { paused: false },
    });

    expect(spaceStore.runtimeState.value).toBe('running');
  });
});

type SpaceStorePrivate = {
  globalListInitialized: boolean;
  globalListCleanupFns: Array<() => void>;
};

function resetGlobalListState() {
  const priv = spaceStore as unknown as SpaceStorePrivate;
  priv.globalListInitialized = false;
  priv.globalListCleanupFns = [];
  spaceStore.spaces.value = [];
}

describe('SpaceStore — initGlobalList', () => {
  beforeEach(async () => {
    await resetStore();
    resetGlobalListState();
  });
  afterEach(() => vi.clearAllMocks());

  it('fetches space list and populates spaces signal', async () => {
    await spaceStore.initGlobalList();

    expect(mockHub.request).toHaveBeenCalledWith('space.listWithTasks', { summary: true });
    expect(spaceStore.spaces.value).toHaveLength(2);
    expect(spaceStore.spaces.value[0].id).toBe('s1');
    expect(spaceStore.spaces.value[1].id).toBe('s2');
  });

  it('is idempotent — second call skips fetch', async () => {
    await spaceStore.initGlobalList();
    const callCount = mockHub.request.mock.calls.length;

    await spaceStore.initGlobalList();

    expect(mockHub.request.mock.calls.length).toBe(callCount);
  });

  it('adds new space on space.created when not already in list', async () => {
    await spaceStore.initGlobalList();
    const newSpace = makeSpace('new-s');

    mockEventHandlers.get('space.created')?.({ spaceId: 'new-s', space: newSpace });

    expect(spaceStore.spaces.value.some((s) => s.id === 'new-s')).toBe(true);
    expect(spaceStore.spaces.value).toHaveLength(3);
  });

  it('does not add duplicate on space.created if already in list', async () => {
    await spaceStore.initGlobalList();
    const count = spaceStore.spaces.value.length;

    mockEventHandlers.get('space.created')?.({ spaceId: 's1', space: makeSpace('s1') });

    expect(spaceStore.spaces.value).toHaveLength(count);
  });

  it('updates matching space on space.updated', async () => {
    await spaceStore.initGlobalList();

    mockEventHandlers.get('space.updated')?.({ spaceId: 's1', space: { name: 'Renamed' } });

    expect(spaceStore.spaces.value.find((s) => s.id === 's1')?.name).toBe('Renamed');
    expect(spaceStore.spaces.value.find((s) => s.id === 's2')?.name).toBe('Test Space');
  });

  it('replaces matching space on space.archived', async () => {
    await spaceStore.initGlobalList();
    const archived = { ...makeSpace('s1'), status: 'archived' } as Space;

    mockEventHandlers.get('space.archived')?.({ spaceId: 's1', space: archived });

    expect(spaceStore.spaces.value.find((s) => s.id === 's1')?.status).toBe('archived');
    expect(spaceStore.spaces.value).toHaveLength(2);
  });

  it('removes matching space on space.deleted', async () => {
    await spaceStore.initGlobalList();
    expect(spaceStore.spaces.value.some((s) => s.id === 's1')).toBe(true);

    mockEventHandlers.get('space.deleted')?.({ spaceId: 's1' });

    expect(spaceStore.spaces.value.some((s) => s.id === 's1')).toBe(false);
    expect(spaceStore.spaces.value).toHaveLength(1);
  });

  it('removes stale handlers before re-registering on reconnect re-init', async () => {
    await spaceStore.initGlobalList();
    expect(spaceStore.spaces.value).toHaveLength(2);

    const priv = spaceStore as unknown as SpaceStorePrivate;
    priv.globalListInitialized = false;

    await spaceStore.initGlobalList();

    fireMockEvent('space.created', { spaceId: 'new-s', space: makeSpace('new-s') });
    expect(spaceStore.spaces.value.filter((s) => s.id === 'new-s')).toHaveLength(1);
  });

  it('resets globalListInitialized flag on failure so retry works', async () => {
    mockHub.request.mockRejectedValueOnce(new Error('Network error'));
    await spaceStore.initGlobalList();

    const priv = spaceStore as unknown as SpaceStorePrivate;
    expect(priv.globalListInitialized).toBe(false);

    await spaceStore.initGlobalList();
    expect(priv.globalListInitialized).toBe(true);
    expect(spaceStore.spaces.value).toHaveLength(2);
  });
});

describe('SpaceStore — refresh', () => {
  beforeEach(async () => {
    await resetStore();
    resetGlobalListState();
  });
  afterEach(() => vi.clearAllMocks());

  function mockWorkflowSummaries(ids: string[]) {
    mockHub.request.mockImplementation(
      async (method: string, params?: Record<string, unknown>): Promise<any> => {
        if (method === 'space.overview') {
          const spaceId = (params?.spaceId as string) ?? 'space-1';
          return { space: makeSpace(spaceId), tasks: [], workflowRuns: [], sessions: [] };
        }
        if (method === 'spaceWorkflow.list') {
          return { workflows: ids.map((id) => makeWorkflowSummary(id)) };
        }
        if (method === 'spaceWorkflow.get') {
          return { workflow: makeWorkflow((params?.id as string) ?? 'wf1') };
        }
        if (method === 'spaceAgent.list') return { agents: [] };
        if (method === 'spaceAgent.listBuiltInTemplates') return { templates: [] };
        if (method === 'spaceWorkflow.listBuiltInTemplates') return { workflows: [] };
        if (method === 'spaceLongHorizonAgent.list') return { agents: [] };
        if (method === 'spaceLongHorizonAgent.listBuiltInTemplates') return { templates: [] };
        return {};
      }
    );
  }

  it('re-initializes global list on reconnect when previously initialized', async () => {
    await spaceStore.initGlobalList();
    mockHub.request.mockClear();

    await spaceStore.refresh();

    expect(mockHub.request).toHaveBeenCalledWith('space.listWithTasks', { summary: true });
  });

  it('does not re-init global list when never initialized', async () => {
    await spaceStore.refresh();

    expect(mockHub.request).not.toHaveBeenCalledWith('space.listWithTasks', expect.anything());
  });

  it('re-fetches space overview when a space is selected', async () => {
    await spaceStore.selectSpace('space-1');
    mockHub.request.mockClear();

    await spaceStore.refresh();

    expect(mockHub.request).toHaveBeenCalledWith('space.overview', {
      slug: 'space-1',
      summary: true,
    });
  });

  it('is a no-op for space state when no space is selected', async () => {
    await spaceStore.refresh();

    expect(mockHub.request).not.toHaveBeenCalledWith('space.overview', expect.anything());
  });

  it('does not re-fetch workflow details on reconnect when they were never loaded', async () => {
    mockWorkflowSummaries(['wf1']);
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureConfigData();
    mockHub.request.mockClear();

    await spaceStore.refresh();
    await new Promise((r) => setTimeout(r, 0));

    const gets = mockHub.request.mock.calls.filter((c) => (c[0] as string) === 'spaceWorkflow.get');
    expect(gets).toHaveLength(0);
  });

  it('re-fetches workflow details on reconnect when they had been loaded', async () => {
    mockWorkflowSummaries(['wf1']);
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureConfigData();
    await spaceStore.ensureWorkflowDetails();
    mockHub.request.mockClear();

    await spaceStore.refresh();
    await new Promise((r) => setTimeout(r, 0));

    const gets = mockHub.request.mock.calls.filter((c) => (c[0] as string) === 'spaceWorkflow.get');
    expect(gets).toHaveLength(1);
  });

  it('re-establishes the open task run node-exec subscription on reconnect', async () => {
    mockWorkflowSummaries([]);
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureNodeExecutions('run-1');
    mockHub.request.mockClear();

    await spaceStore.refresh();
    await new Promise((r) => setTimeout(r, 0));

    expect(mockHub.request).toHaveBeenCalledWith('nodeExecution.list', {
      workflowRunId: 'run-1',
      spaceId: 'space-1',
    });
    expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
      queryName: 'nodeExecutions.byRun',
      params: ['run-1'],
      subscriptionId: 'nodeExecutions-byRun-run-1',
    });
  });

  it('does not re-establish node-exec subscription on reconnect when none was active', async () => {
    mockWorkflowSummaries([]);
    await spaceStore.selectSpace('space-1');
    mockHub.request.mockClear();

    await spaceStore.refresh();
    await new Promise((r) => setTimeout(r, 0));

    const methods = mockHub.request.mock.calls.map((c) => c[0] as string);
    expect(methods).not.toContain('nodeExecution.list');
  });
});

function makeNodeExecution(overrides: Partial<NodeExecution> = {}): NodeExecution {
  return {
    id: overrides.id ?? 'exec-1',
    workflowRunId: overrides.workflowRunId ?? 'run-1',
    workflowNodeId: overrides.workflowNodeId ?? 'node-1',
    agentName: overrides.agentName ?? 'coder',
    agentId: overrides.agentId ?? 'agent-1',
    agentSessionId: overrides.agentSessionId ?? null,
    status: overrides.status ?? ('pending' as NodeExecution['status']),
    result: overrides.result ?? null,
    data: overrides.data ?? null,
    createdAt: overrides.createdAt ?? Date.now(),
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
    updatedAt: overrides.updatedAt ?? Date.now(),
    lastActivityAt: overrides.lastActivityAt ?? null,
  };
}

describe('SpaceStore — task detail cache', () => {
  beforeEach(async () => {
    taskDetailResult = null;
    await resetStore();
  });
  afterEach(() => vi.clearAllMocks());

  it('fetches full task detail once, sharing in-flight and cached calls per task id', async () => {
    await spaceStore.selectSpace('space-1');
    taskDetailResult = { ...makeTask('t1'), description: 'full description' };
    mockHub.request.mockClear();

    const [a, b] = await Promise.all([
      spaceStore.ensureTaskDetail('t1'),
      spaceStore.ensureTaskDetail('t1'),
    ]);
    const third = await spaceStore.ensureTaskDetail('t1');

    expect(a?.description).toBe('full description');
    expect(b).toBe(a);
    expect(third).toBe(a);
    const getCalls = mockHub.request.mock.calls.filter((c: unknown[]) => c[0] === 'spaceTask.get');
    expect(getCalls).toHaveLength(1);
    expect(getCalls[0][1]).toEqual({ spaceId: 'space-1', taskId: 't1' });
    expect(spaceStore.taskDetails.value.get('t1')).toBe(a);
  });

  it('refreshes cached detail from full space.task.updated events without refetching', async () => {
    await spaceStore.selectSpace('space-1');
    taskDetailResult = { ...makeTask('t1'), description: 'full description' };
    await spaceStore.ensureTaskDetail('t1');
    mockHub.request.mockClear();

    const eventTask = {
      ...makeTask('t1'),
      description: 'updated full description',
      updatedAt: Date.now() + 1,
    };
    fireMockEvent('space.task.updated', {
      sessionId: 'session-1',
      spaceId: 'space-1',
      taskId: 't1',
      task: eventTask,
    });

    expect(spaceStore.taskDetails.value.get('t1')?.description).toBe('updated full description');
    await expect(spaceStore.ensureTaskDetail('t1')).resolves.toBe(eventTask);
    expect(
      mockHub.request.mock.calls.filter((c: unknown[]) => c[0] === 'spaceTask.get')
    ).toHaveLength(0);
  });

  it('does not cache tasks whose detail was never requested', async () => {
    await spaceStore.selectSpace('space-1');

    fireMockEvent('space.task.updated', {
      sessionId: 'session-1',
      spaceId: 'space-1',
      taskId: 't9',
      task: makeTask('t9'),
    });

    expect(spaceStore.taskDetails.value.size).toBe(0);
  });

  it('clears cached details when the selected space changes', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureTaskDetail('t1');
    expect(spaceStore.taskDetails.value.size).toBe(1);

    await spaceStore.clearSpace();

    expect(spaceStore.taskDetails.value.size).toBe(0);
    await expect(spaceStore.ensureTaskDetail('t1')).resolves.toBeNull();
  });

  it('does not write a detail resolved after a space switch into the fresh cache', async () => {
    await spaceStore.selectSpace('space-1');
    let resolveGet: (task: SpaceTask) => void = () => {};
    mockHub.request.mockImplementationOnce(
      () =>
        new Promise<SpaceTask>((resolve) => {
          resolveGet = resolve;
        })
    );

    const pending = spaceStore.ensureTaskDetail('t1');
    await spaceStore.clearSpace();
    resolveGet({ ...makeTask('t1'), description: 'full description' });
    await expect(pending).resolves.toBeNull();

    expect(spaceStore.taskDetails.value.size).toBe(0);
  });

  it('refetches when the cached detail is staler than the requested freshness', async () => {
    await spaceStore.selectSpace('space-1');
    taskDetailResult = { ...makeTask('t1'), description: 'stale full', updatedAt: 10 };
    await spaceStore.ensureTaskDetail('t1');
    taskDetailResult = { ...makeTask('t1'), description: 'fresh full', updatedAt: 20 };
    mockHub.request.mockClear();

    await expect(spaceStore.ensureTaskDetail('t1', 20)).resolves.toHaveProperty(
      'description',
      'fresh full'
    );

    expect(
      mockHub.request.mock.calls.filter((c: unknown[]) => c[0] === 'spaceTask.get')
    ).toHaveLength(1);
    expect(spaceStore.taskDetails.value.get('t1')?.description).toBe('fresh full');
  });

  it('rejects a detail resolved after navigating away and back from an obsolete generation', async () => {
    await spaceStore.selectSpace('space-1');
    let resolveFirst: (task: SpaceTask) => void = () => {};
    mockHub.request.mockImplementationOnce(
      () =>
        new Promise<SpaceTask>((resolve) => {
          resolveFirst = resolve;
        })
    );

    const pending = spaceStore.ensureTaskDetail('t1');
    await spaceStore.selectSpace('space-2');
    await spaceStore.selectSpace('space-1');
    resolveFirst({ ...makeTask('t1'), description: 'stale full' });
    await expect(pending).resolves.toBeNull();

    expect(spaceStore.taskDetails.value.size).toBe(0);
  });

  it('does not let a stale completion remove a newer in-flight request', async () => {
    await spaceStore.selectSpace('space-1');
    let resolveFirst: (task: SpaceTask) => void = () => {};
    mockHub.request.mockImplementationOnce(
      () =>
        new Promise<SpaceTask>((resolve) => {
          resolveFirst = resolve;
        })
    );
    const first = spaceStore.ensureTaskDetail('t1');
    await spaceStore.selectSpace('space-2');
    await spaceStore.selectSpace('space-1');

    let resolveSecond: (task: SpaceTask) => void = () => {};
    mockHub.request.mockImplementationOnce(
      () =>
        new Promise<SpaceTask>((resolve) => {
          resolveSecond = resolve;
        })
    );
    const second = spaceStore.ensureTaskDetail('t1');
    resolveFirst({ ...makeTask('t1'), description: 'stale full' });
    await expect(first).resolves.toBeNull();

    const third = spaceStore.ensureTaskDetail('t1');
    resolveSecond({ ...makeTask('t1'), description: 'fresh full' });
    await expect(second).resolves.toHaveProperty('description', 'fresh full');
    await expect(third).resolves.toHaveProperty('description', 'fresh full');

    expect(
      mockHub.request.mock.calls.filter((c: unknown[]) => c[0] === 'spaceTask.get')
    ).toHaveLength(2);
    expect(spaceStore.taskDetails.value.get('t1')?.description).toBe('fresh full');
  });
});

describe('SpaceStore — node execution LiveQuery subscriptions', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  function nodeExecSubscribeCalls() {
    return mockHub.request.mock.calls.filter(
      (c: unknown[]) =>
        c[0] === 'liveQuery.subscribe' &&
        (c[1] as Record<string, unknown>)?.queryName === 'nodeExecutions.byRun'
    );
  }

  it('ensureNodeExecutions(runId) fetches + subscribes to nodeExecutions.byRun for that run only', async () => {
    await spaceStore.selectSpace('space-1');

    await spaceStore.ensureNodeExecutions('run-1');

    expect(mockHub.request).toHaveBeenCalledWith('nodeExecution.list', {
      workflowRunId: 'run-1',
      spaceId: 'space-1',
    });
    expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
      queryName: 'nodeExecutions.byRun',
      params: ['run-1'],
      subscriptionId: 'nodeExecutions-byRun-run-1',
    });
    expect(nodeExecSubscribeCalls()).toHaveLength(1);
  });

  it('ensureNodeExecutions(null) is a no-op when no run is active (standalone task)', async () => {
    await spaceStore.selectSpace('space-1');

    await spaceStore.ensureNodeExecutions(null);

    expect(nodeExecSubscribeCalls()).toHaveLength(0);
    const calledMethods = mockHub.request.mock.calls.map((c: unknown[]) => c[0]);
    expect(calledMethods).not.toContain('nodeExecution.list');
  });

  it('ensureNodeExecutions(null) tears down the active run subscription when switching to a standalone task', async () => {
    await spaceStore.selectSpace('space-1');

    await spaceStore.ensureNodeExecutions('run-1');
    expect(nodeExecSubscribeCalls()).toHaveLength(1);

    await spaceStore.ensureNodeExecutions(null);

    expect(mockHub.request).toHaveBeenCalledWith('liveQuery.unsubscribe', {
      subscriptionId: 'nodeExecutions-byRun-run-1',
    });
    expect(spaceStore.nodeExecutions.value).toEqual([]);
  });

  it('ensureNodeExecutions does not subscribe before a space is selected', async () => {
    await spaceStore.ensureNodeExecutions('run-1');

    expect(nodeExecSubscribeCalls()).toHaveLength(0);
  });

  it('workflowRun.created does not auto-subscribe (subscription is per-run via ensureNodeExecutions)', async () => {
    await spaceStore.selectSpace('space-1');

    const handler = mockEventHandlers.get('space.workflowRun.created')!;
    const run = makeRun('run-1');
    handler({ spaceId: 'space-1', runId: run.id, run, sessionId: 's1' });

    expect(spaceStore.workflowRuns.value).toContainEqual(run);
    expect(nodeExecSubscribeCalls()).toHaveLength(0);
  });

  it('applies LiveQuery snapshot to nodeExecutions signal', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureNodeExecutions('run-1');

    const exec1 = makeNodeExecution({
      id: 'exec-1',
      workflowRunId: 'run-1',
      workflowNodeId: 'node-a',
    });
    const exec2 = makeNodeExecution({
      id: 'exec-2',
      workflowRunId: 'run-1',
      workflowNodeId: 'node-b',
    });
    fireMockEvent('liveQuery.snapshot', {
      subscriptionId: 'nodeExecutions-byRun-run-1',
      rows: [exec1, exec2],
      version: 1,
    });

    expect(spaceStore.nodeExecutions.value).toEqual([exec1, exec2]);
  });

  it('applies LiveQuery delta (add/update/remove) to nodeExecutions signal', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureNodeExecutions('run-1');

    const exec1 = makeNodeExecution({ id: 'exec-1', status: 'pending' });
    const exec2 = makeNodeExecution({ id: 'exec-2', status: 'pending' });
    fireMockEvent('liveQuery.snapshot', {
      subscriptionId: 'nodeExecutions-byRun-run-1',
      rows: [exec1, exec2],
      version: 1,
    });

    const exec1Updated = { ...exec1, status: 'done' as const, result: 'All good' };
    const exec3 = makeNodeExecution({ id: 'exec-3', workflowNodeId: 'node-c' });
    fireMockEvent('liveQuery.delta', {
      subscriptionId: 'nodeExecutions-byRun-run-1',
      updated: [exec1Updated],
      removed: [exec2],
      added: [exec3],
      version: 2,
    });

    expect(spaceStore.nodeExecutions.value).toHaveLength(2);
    expect(spaceStore.nodeExecutions.value).toContainEqual(exec1Updated);
    expect(spaceStore.nodeExecutions.value).toContainEqual(exec3);
    expect(spaceStore.nodeExecutions.value).not.toContainEqual(exec2);
  });

  it('switching runs replaces node executions and unsubscribes the previous run', async () => {
    await spaceStore.selectSpace('space-1');

    await spaceStore.ensureNodeExecutions('run-1');
    const exec1 = makeNodeExecution({ id: 'exec-1', workflowRunId: 'run-1' });
    fireMockEvent('liveQuery.snapshot', {
      subscriptionId: 'nodeExecutions-byRun-run-1',
      rows: [exec1],
      version: 1,
    });
    expect(spaceStore.nodeExecutions.value).toEqual([exec1]);

    await spaceStore.ensureNodeExecutions('run-2');

    expect(mockHub.request).toHaveBeenCalledWith('liveQuery.unsubscribe', {
      subscriptionId: 'nodeExecutions-byRun-run-1',
    });
    fireMockEvent('liveQuery.snapshot', {
      subscriptionId: 'nodeExecutions-byRun-run-1',
      rows: [makeNodeExecution({ id: 'stale', workflowRunId: 'run-1' })],
      version: 2,
    });
    expect(spaceStore.nodeExecutions.value).toEqual([]);

    const exec2 = makeNodeExecution({ id: 'exec-2', workflowRunId: 'run-2' });
    fireMockEvent('liveQuery.snapshot', {
      subscriptionId: 'nodeExecutions-byRun-run-2',
      rows: [exec2],
      version: 1,
    });
    expect(spaceStore.nodeExecutions.value).toEqual([exec2]);
  });

  it('handles empty snapshot (clears executions for that run)', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureNodeExecutions('run-1');

    const exec1 = makeNodeExecution({ id: 'exec-1', workflowRunId: 'run-1' });
    fireMockEvent('liveQuery.snapshot', {
      subscriptionId: 'nodeExecutions-byRun-run-1',
      rows: [exec1],
      version: 1,
    });
    expect(spaceStore.nodeExecutions.value).toHaveLength(1);

    fireMockEvent('liveQuery.snapshot', {
      subscriptionId: 'nodeExecutions-byRun-run-1',
      rows: [],
      version: 2,
    });
    expect(spaceStore.nodeExecutions.value).toHaveLength(0);
  });

  it('computes nodeExecutionsByNodeId correctly', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureNodeExecutions('run-1');

    const exec1 = makeNodeExecution({
      id: 'exec-1',
      workflowRunId: 'run-1',
      workflowNodeId: 'node-a',
    });
    const exec2 = makeNodeExecution({
      id: 'exec-2',
      workflowRunId: 'run-1',
      workflowNodeId: 'node-a',
    });
    const exec3 = makeNodeExecution({
      id: 'exec-3',
      workflowRunId: 'run-1',
      workflowNodeId: 'node-b',
    });
    fireMockEvent('liveQuery.snapshot', {
      subscriptionId: 'nodeExecutions-byRun-run-1',
      rows: [exec1, exec2, exec3],
      version: 1,
    });

    const byNode = spaceStore.nodeExecutionsByNodeId.value;
    expect(byNode.get('node-a')).toEqual([exec1, exec2]);
    expect(byNode.get('node-b')).toEqual([exec3]);
    expect(byNode.get('node-nonexistent')).toBeUndefined();
  });

  it('ignores snapshot events for wrong subscriptionId', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureNodeExecutions('run-1');

    const exec1 = makeNodeExecution({ id: 'exec-1' });
    fireMockEvent('liveQuery.snapshot', {
      subscriptionId: 'wrong-subscription-id',
      rows: [exec1],
      version: 1,
    });

    expect(spaceStore.nodeExecutions.value).toHaveLength(0);
  });

  it('clears nodeExecutions on space switch', async () => {
    await spaceStore.selectSpace('space-1');
    await spaceStore.ensureNodeExecutions('run-1');

    const exec1 = makeNodeExecution({ id: 'exec-1' });
    fireMockEvent('liveQuery.snapshot', {
      subscriptionId: 'nodeExecutions-byRun-run-1',
      rows: [exec1],
      version: 1,
    });
    expect(spaceStore.nodeExecutions.value).toHaveLength(1);

    mockHub.request.mockImplementation(async (method: string) => {
      if (method === 'space.overview')
        return { space: makeSpace('space-2'), tasks: [], workflowRuns: [], sessions: [] };
      if (method === 'spaceAgent.list') return { agents: [] };
      if (method === 'spaceAgent.listBuiltInTemplates') return { templates: [] };
      if (method === 'spaceWorkflow.list') return { workflows: [] };
      if (method === 'nodeExecution.list') return { executions: [] };
      return {};
    });
    await spaceStore.selectSpace('space-2');

    expect(spaceStore.nodeExecutions.value).toHaveLength(0);
  });

  it('does not duplicate subscription when ensureNodeExecutions(runId) is called twice', async () => {
    await spaceStore.selectSpace('space-1');

    await spaceStore.ensureNodeExecutions('run-1');
    await spaceStore.ensureNodeExecutions('run-1');

    expect(nodeExecSubscribeCalls()).toHaveLength(1);
  });

  it('discards a stale fetch when the run switches mid-load (nodeExecLoadGen guard)', async () => {
    await spaceStore.selectSpace('space-1');

    const run1Exec = makeNodeExecution({ id: 'stale', workflowRunId: 'run-1' });
    const run2Exec = makeNodeExecution({ id: 'exec-2', workflowRunId: 'run-2' });
    let resolveRun1!: (v: { executions: NodeExecution[] }) => void;
    let resolveRun2!: (v: { executions: NodeExecution[] }) => void;
    const run1Promise = new Promise<{ executions: NodeExecution[] }>((r) => {
      resolveRun1 = r;
    });
    const run2Promise = new Promise<{ executions: NodeExecution[] }>((r) => {
      resolveRun2 = r;
    });
    mockHub.request.mockImplementation(async (method: string, params: any) => {
      if (method === 'nodeExecution.list') {
        return params.workflowRunId === 'run-1' ? run1Promise : run2Promise;
      }
      return {};
    });

    const p1 = spaceStore.ensureNodeExecutions('run-1');
    const p2 = spaceStore.ensureNodeExecutions('run-2');

    resolveRun1({ executions: [run1Exec] });
    resolveRun2({ executions: [run2Exec] });
    await Promise.all([p1, p2]);

    expect(spaceStore.nodeExecutions.value).toEqual([run2Exec]);
    const run1Subscribes = nodeExecSubscribeCalls().filter(
      (c) => (c[1] as { params?: string[] }).params?.[0] === 'run-1'
    );
    expect(run1Subscribes).toHaveLength(0);
    expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
      queryName: 'nodeExecutions.byRun',
      params: ['run-2'],
      subscriptionId: 'nodeExecutions-byRun-run-2',
    });
  });
  describe('sendTaskMessage', () => {
    beforeEach(async () => {
      await spaceStore.selectSpace('space-1');
    });

    it('returns delivered:false without queued when daemon has no queue', async () => {
      mockHub.request.mockImplementation(async (method: string): Promise<any> => {
        if (method === 'space.task.sendMessage') {
          return {
            ok: true,
            routedTo: ['Reviewer'],
            delivered: false,
            activated: true,
          };
        }
        return {};
      });

      const result = await spaceStore.sendTaskMessage('task-1', 'Orphaned', {
        kind: 'node_agent',
        agentName: 'Reviewer',
      });

      expect(result?.delivered).toBe(false);
      expect((result as { queued?: boolean }).queued).toBeUndefined();
    });
  });
});

describe('SpaceStore — refreshLongHorizonAgents preserves cache on failure', () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it('keeps the cached agent list when a force-refresh fails (review fix)', async () => {
    spaceStore.spaceId.value = 'space-1';
    spaceStore.longHorizonAgents.value = [makeLongHorizonAgent('lh-1')];
    mockHub.request.mockImplementation((method: string) => {
      if (method === 'spaceLongHorizonAgent.list') return Promise.reject(new Error('timeout'));
      return Promise.resolve({});
    });
    await spaceStore.refreshLongHorizonAgents();
    expect(spaceStore.longHorizonAgents.value).toHaveLength(1);
  });

  it('drops a longHorizonAgent.list result that arrived after a space switch', async () => {
    spaceStore.spaceId.value = 'space-1';
    spaceStore.longHorizonAgents.value = [makeLongHorizonAgent('seeded')];
    let resolveList: (value: { agents: SpaceLongHorizonAgent[] }) => void = () => {};
    mockHub.request.mockImplementation(((method: string) => {
      if (method === 'spaceLongHorizonAgent.list') {
        return new Promise<{ agents: SpaceLongHorizonAgent[] }>((r) => {
          resolveList = r;
        });
      }
      return Promise.resolve({});
    }) as never);
    const pending = spaceStore.refreshLongHorizonAgents();
    await vi.waitFor(() =>
      expect(mockHub.request).toHaveBeenCalledWith('spaceLongHorizonAgent.list', {
        spaceId: 'space-1',
      })
    );
    spaceStore.spaceId.value = 'space-2';
    resolveList({ agents: [makeLongHorizonAgent('stale')] });
    await pending;
    expect(spaceStore.longHorizonAgents.value.map((a) => a.id)).toEqual(['seeded']);
  });
});
