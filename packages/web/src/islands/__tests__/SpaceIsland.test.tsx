// @ts-nocheck

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const LAZY_LOAD_TIMEOUT = 5000;

import type { Space, SpaceWorkerAgent, SpaceWorkflow } from '@hyperneo/shared';
import { signal } from '@preact/signals';

let mockLoading = signal(false);
let mockError = signal<string | null>(null);
let mockSpace = signal<Space | null>(null);
let mockWorkflows = signal<SpaceWorkflow[]>([]);
let mockAgents = signal<SpaceWorkerAgent[]>([]);
let mockStoreSpaceId = signal<string | null>('space-1');
let mockConfigDataLoaded = signal(true);
let mockTaskMessageActivity = signal<Map<string, number>>(new Map());
const mockEnsureConfigData = vi.fn().mockResolvedValue(undefined);
const mockEnsureWorkflowDetails = vi.fn().mockResolvedValue(undefined);
const mockSubscribeTaskMessageActivity = vi.fn().mockResolvedValue(undefined);
const mockUnsubscribeTaskMessageActivity = vi.fn();

const mockSelectSpace = vi.fn().mockResolvedValue(undefined);

const { configureTabBridge, idBridge } = vi.hoisted(() => ({
  configureTabBridge: { signal: null as ReturnType<typeof signal<string>> | null },
  idBridge: { signal: null as ReturnType<typeof signal<string | null>> | null },
}));

const { mockNavigateToSpaceConfigure } = vi.hoisted(() => ({
  mockNavigateToSpaceConfigure: vi.fn((_spaceId: string, tab?: string) => {
    if (configureTabBridge.signal) {
      configureTabBridge.signal.value = tab ?? 'agents';
    }
  }),
}));

const { mockNavigateToSpaceSession, mockNavigateToSpaceTask } = vi.hoisted(() => ({
  mockNavigateToSpaceSession: vi.fn(),
  mockNavigateToSpaceTask: vi.fn(),
}));

const { mockCreateSession } = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
}));

const { mockToastError } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
}));

const mockCurrentSpaceConfigureTabSignal = signal<string>('agents');
const mockCurrentSpaceIdSignal = signal<string | null>(null);
const mockCurrentSpaceCanonicalIdSignal = signal<string | null>(null);
const mockCurrentSpaceAgentHandleSignal = signal<string | null>(null);
const mockCurrentSpaceViewModeSignal = signal<string>('overview');

const mockSpaceOverlaySessionIdSignal = signal<string | null>(null);
const mockSpaceOverlayAgentNameSignal = signal<string | null>(null);
const mockSpaceOverlayHighlightMessageIdSignal = signal<string | null>(null);
const mockSpaceOverlayPendingTaskIdSignal = signal<string | null>(null);
const mockSpaceOverlayPendingAgentNameSignal = signal<string | null>(null);
const mockSpaceOverlayTaskContextSignal = signal<unknown>(null);

configureTabBridge.signal = mockCurrentSpaceConfigureTabSignal;
idBridge.signal = mockCurrentSpaceIdSignal;

vi.mock('../../lib/signals', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    get currentSpaceConfigureTabSignal() {
      return mockCurrentSpaceConfigureTabSignal;
    },
    get currentSpaceIdSignal() {
      return mockCurrentSpaceIdSignal;
    },
    get currentSpaceCanonicalIdSignal() {
      return mockCurrentSpaceCanonicalIdSignal;
    },
    get currentSpaceAgentHandleSignal() {
      return mockCurrentSpaceAgentHandleSignal;
    },
    get currentSpaceViewModeSignal() {
      return mockCurrentSpaceViewModeSignal;
    },
    get spaceOverlaySessionIdSignal() {
      return mockSpaceOverlaySessionIdSignal;
    },
    get spaceOverlayAgentNameSignal() {
      return mockSpaceOverlayAgentNameSignal;
    },
    get spaceOverlayHighlightMessageIdSignal() {
      return mockSpaceOverlayHighlightMessageIdSignal;
    },
    get spaceOverlayPendingTaskIdSignal() {
      return mockSpaceOverlayPendingTaskIdSignal;
    },
    get spaceOverlayPendingAgentNameSignal() {
      return mockSpaceOverlayPendingAgentNameSignal;
    },
    get spaceOverlayTaskContextSignal() {
      return mockSpaceOverlayTaskContextSignal;
    },
  };
});

vi.mock('../../components/space/WorkflowList', () => ({
  WorkflowList: (props: { onCreateWorkflow: () => void; onEditWorkflow: (id: string) => void }) => (
    <div data-testid="workflow-list">
      <button data-testid="create-workflow-btn" onClick={props.onCreateWorkflow}>
        Create
      </button>
      <button data-testid="edit-workflow-btn" onClick={() => props.onEditWorkflow('wf-existing')}>
        Edit
      </button>
    </div>
  ),
}));

let capturedVisualEditorProps: Record<string, unknown> = {};
vi.mock('../../components/space/visual-editor/VisualWorkflowEditor', () => ({
  VisualWorkflowEditor: (props: {
    workflow?: SpaceWorkflow;
    onSave: () => void;
    onCancel: () => void;
  }) => {
    capturedVisualEditorProps = props;
    return (
      <div data-testid="visual-workflow-editor">
        <span data-testid="visual-editor-name">{props.workflow?.name ?? 'new'}</span>
        <button data-testid="visual-editor-save" onClick={props.onSave}>
          Save
        </button>
        <button data-testid="visual-editor-cancel" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    );
  },
}));

vi.mock('../../components/space/SpaceOverview', () => ({
  SpaceOverview: (props: {
    spaceId: string;
    navigationSpaceId?: string;
    onSelectTask?: (taskId: string) => void;
  }) => (
    <div
      data-testid="space-dashboard"
      data-space-id={props.spaceId}
      data-navigation-space-id={props.navigationSpaceId ?? ''}
    >
      <button
        data-testid="overview-select-task"
        onClick={() => props.onSelectTask?.('task-from-overview')}
      >
        Select Task
      </button>
    </div>
  ),
}));

vi.mock('../../components/space/SpaceTaskPane', () => ({
  SpaceTaskPane: (props: {
    taskId: string | null;
    spaceId?: string;
    navigationSpaceId?: string;
  }) => (
    <div
      data-testid="space-task-pane-inner"
      data-task-id={props.taskId ?? ''}
      data-space-id={props.spaceId ?? ''}
      data-navigation-space-id={props.navigationSpaceId ?? ''}
    />
  ),
}));

vi.mock('../../components/space/TaskAuxiliaryPanel', () => ({
  TaskAuxiliaryPanel: (props: { taskId: string; spaceId?: string }) => (
    <div
      data-testid="task-auxiliary-panel"
      data-task-id={props.taskId}
      data-space-id={props.spaceId ?? ''}
    />
  ),
}));

vi.mock('../../components/space/SpaceCreateTaskDialog', () => ({
  SpaceCreateTaskDialog: (props: {
    isOpen: boolean;
    onCreated?: (task: { id: string; title: string }) => void;
  }) =>
    props.isOpen ? (
      <div>
        <h2>Create Task</h2>
        <button
          type="button"
          onClick={() => props.onCreated?.({ id: 'new-task-123', title: 'New Task' })}
        >
          Create Test Task
        </button>
      </div>
    ) : null,
}));

vi.mock('../../components/space/SpaceGoals', () => ({
  SpaceGoals: (props: { spaceId: string; navigationSpaceId?: string }) => (
    <div
      data-testid="space-goals"
      data-space-id={props.spaceId}
      data-navigation-space-id={props.navigationSpaceId ?? ''}
    />
  ),
}));

vi.mock('../../components/space/SpaceSessionsPage', () => ({
  SpaceSessionsPage: (props: { spaceId: string; navigationSpaceId?: string }) => (
    <div
      data-testid="space-sessions-page"
      data-space-id={props.spaceId}
      data-navigation-space-id={props.navigationSpaceId ?? ''}
    />
  ),
}));

vi.mock('../../components/space/SpaceWorkerAgentList', () => ({
  SpaceWorkerAgentList: () => <div data-testid="space-worker-agent-list" />,
}));

vi.mock('../../components/space/SpaceLongHorizonAgents', () => ({
  SpaceLongHorizonAgents: (props: {
    spaceId: string;
    navigationSpaceId?: string;
    selectedHandle?: string | null;
  }) => {
    const spaceAgent = mockAgents.value.find((agent) => agent.handle === props.selectedHandle);
    return (
      <div
        data-testid="space-long-horizon-agents"
        data-space-id={props.spaceId}
        data-navigation-space-id={props.navigationSpaceId ?? ''}
        data-selected-handle={props.selectedHandle ?? ''}
        data-space-agent={spaceAgent?.handle ?? ''}
      />
    );
  },
}));

vi.mock('../../components/space/SpaceSettings', () => ({
  SpaceSettings: () => <div data-testid="space-settings" />,
}));

vi.mock('../ChatContainer', () => ({
  default: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="chat-container" data-session-id={sessionId} />
  ),
}));

vi.mock('../../components/space/AgentOverlayChat', () => ({
  AgentOverlayChat: ({ sessionId, agentName }: { sessionId?: string; agentName?: string }) => (
    <div
      data-testid="agent-overlay-chat"
      data-session-id={sessionId ?? ''}
      data-agent-name={agentName ?? ''}
    />
  ),
}));

vi.mock('../../lib/session-store', () => ({
  sessionStore: { select: vi.fn() },
}));

vi.mock('../../lib/space-store', () => ({
  get spaceStore() {
    return {
      loading: mockLoading,
      error: mockError,
      spaceId: mockStoreSpaceId,
      space: mockSpace,
      workflows: mockWorkflows,
      workflowDetails: mockWorkflows,
      workflowDetailsLoaded: { value: true },
      agents: mockAgents,
      sessions: { value: [] },
      tasks: { value: [] },
      taskMessageActivity: mockTaskMessageActivity,
      hasTaskMessageActivity: (id: string) => {
        const count = mockTaskMessageActivity.value.get(id);
        return count === undefined ? null : count > 0;
      },
      subscribeTaskMessageActivity: mockSubscribeTaskMessageActivity,
      unsubscribeTaskMessageActivity: mockUnsubscribeTaskMessageActivity,
      schedules: { value: [] },
      listSchedules: vi.fn().mockResolvedValue(undefined),
      configDataLoaded: mockConfigDataLoaded,
      ensureConfigData: mockEnsureConfigData,
      ensureWorkflowDetails: mockEnsureWorkflowDetails,
      refreshLongHorizonAgents: vi.fn().mockResolvedValue(undefined),
      longHorizonAgents: signal([]),
      ensureNodeExecutions: vi.fn().mockResolvedValue(undefined),
      selectSpace: mockSelectSpace,
      workflowVersions: signal(new Map()),
      fetchWorkflowDetail: vi.fn((id: string) =>
        Promise.resolve(mockWorkflows.value.find((w) => w.id === id) ?? null)
      ),
    };
  },
}));

vi.mock('../../lib/memory-store', () => ({
  get memoryStore() {
    return {
      memories: signal([]),
      loaded: signal(true),
      error: signal(null),
      query: signal(''),
      hasMore: signal(false),
      isLoadingMore: signal(false),
      attach: vi.fn().mockResolvedValue(undefined),
      detach: vi.fn(),
      search: vi.fn().mockResolvedValue(undefined),
      loadMore: vi.fn().mockResolvedValue(undefined),
    };
  },
}));

vi.mock('../../lib/router', () => ({
  navigateToSpace: vi.fn(),
  navigateToSpaceTask: mockNavigateToSpaceTask,
  navigateToSpaceSession: mockNavigateToSpaceSession,
  navigateToSpaceConfigure: mockNavigateToSpaceConfigure,
  pushOverlayHistory: vi.fn(),
  closeOverlayHistory: vi.fn(),
}));

vi.mock('../../lib/api-helpers', () => ({
  createSession: mockCreateSession,
}));

vi.mock('../../lib/toast', () => ({
  toast: {
    error: mockToastError,
  },
}));

import SpaceIsland from '../SpaceIsland';

beforeAll(async () => {
  await Promise.all([
    import('../../components/space/SpaceConfigurePage'),
    import('../../components/space/SpaceOverview'),
    import('../../components/space/SpaceTaskPane'),
    import('../../components/space/SpaceTasks'),
    import('../../components/space/SpaceSessionsPage'),
    import('../../components/space/SpaceLongHorizonAgents'),
  ]);
});

function makeSpace(overrides: Partial<Space> = {}): Space {
  return {
    id: 'space-1',
    name: 'Test Space',
    description: '',
    status: 'active',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function makeWorkflow(overrides: Partial<SpaceWorkflow> = {}): SpaceWorkflow {
  return {
    id: 'wf-existing',
    spaceId: 'space-1',
    name: 'Existing Workflow',
    description: '',
    nodes: [],
    transitions: [],
    startNodeId: '',
    rules: [],
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mockLoading = signal(false);
  mockError = signal(null);
  mockSpace = signal(makeSpace());
  mockWorkflows = signal([makeWorkflow()]);
  mockAgents = signal([]);
  mockStoreSpaceId = signal('space-1');
  mockConfigDataLoaded = signal(true);
  mockTaskMessageActivity = signal(new Map());
  mockSubscribeTaskMessageActivity.mockClear();
  mockSubscribeTaskMessageActivity.mockResolvedValue(undefined);
  mockUnsubscribeTaskMessageActivity.mockClear();
  capturedVisualEditorProps = {};
  configureTabBridge.signal.value = 'agents';
  idBridge.signal.value = null;
  mockCurrentSpaceAgentHandleSignal.value = null;
  mockCurrentSpaceCanonicalIdSignal.value = null;
  mockSpaceOverlaySessionIdSignal.value = null;
  mockSpaceOverlayAgentNameSignal.value = null;
  mockSpaceOverlayHighlightMessageIdSignal.value = null;
  mockSpaceOverlayPendingTaskIdSignal.value = null;
  mockSpaceOverlayPendingAgentNameSignal.value = null;
  mockSpaceOverlayTaskContextSignal.value = null;
  mockNavigateToSpaceConfigure.mockClear();
  mockNavigateToSpaceSession.mockClear();
  mockNavigateToSpaceTask.mockClear();
  mockCreateSession.mockClear();
  mockToastError.mockClear();
  mockEnsureConfigData.mockClear();
  mockEnsureConfigData.mockResolvedValue(undefined);
  mockEnsureWorkflowDetails.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('SpaceIsland — overlay inerts the base chat (task #873)', () => {
  it('keeps the base session layer interactive when no overlay is open', async () => {
    const { findByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="overview" sessionViewId="session-abc" />
    );
    const layer = await findByTestId('space-base-session-layer');
    expect(layer.hasAttribute('inert')).toBe(false);
    expect(layer.getAttribute('aria-hidden')).toBeNull();
  });

  it('inerts + hides the base session layer from the a11y tree while an overlay is open', async () => {
    mockSpaceOverlaySessionIdSignal.value = 'overlay-session';
    mockSpaceOverlayAgentNameSignal.value = 'Coder';
    const { findByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="overview" sessionViewId="session-abc" />
    );
    await findByTestId('agent-overlay-chat');
    const layer = await findByTestId('space-base-session-layer');
    expect(layer.hasAttribute('inert')).toBe(true);
    expect(layer.getAttribute('aria-hidden')).toBe('true');
  });

  it('re-enables the base layer once the overlay closes', async () => {
    mockSpaceOverlaySessionIdSignal.value = 'overlay-session';
    const { findByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="overview" sessionViewId="session-abc" />
    );
    let layer = await findByTestId('space-base-session-layer');
    expect(layer.hasAttribute('inert')).toBe(true);

    mockSpaceOverlaySessionIdSignal.value = null;
    await waitFor(() => {
      layer = document.querySelector('[data-testid="space-base-session-layer"]') as HTMLElement;
      expect(layer?.hasAttribute('inert')).toBe(false);
    });
  });

  it('inerts every base-content branch, not just session/task (review fix)', async () => {
    mockSpaceOverlaySessionIdSignal.value = 'overlay-session';
    const { findByTestId } = render(<SpaceIsland spaceId="space-1" viewMode="sessions" />);
    await findByTestId('agent-overlay-chat');
    const view = await findByTestId('space-sessions-view');
    expect(view.hasAttribute('inert')).toBe(true);
    expect(view.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('SpaceIsland — route-driven views', () => {
  it('renders the overview view without the legacy top tab bar', async () => {
    const { getByTestId, getByText, queryByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="overview" />
    );
    await waitFor(
      () => {
        expect(getByTestId('space-dashboard')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );
    expect(getByTestId('space-overview-view')).toBeTruthy();
    expect(getByTestId('space-overview-view').getAttribute('data-overview-surface')).toBe(
      'glass-workspace'
    );
    expect(getByTestId('space-dashboard').getAttribute('data-space-id')).toBe('space-1');
    expect(getByText('Space operations and recent activity')).toBeTruthy();
    expect(queryByTestId('space-tab-bar')).toBeNull();
  });

  it('renders the configure view when requested', async () => {
    const { getByTestId } = render(<SpaceIsland spaceId="space-1" viewMode="configure" />);
    await waitFor(
      () => {
        expect(getByTestId('space-worker-agent-list')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );
    const configureView = getByTestId('space-configure-view');
    expect(configureView).toBeTruthy();
    expect(configureView.hasAttribute('data-overview-surface')).toBe(false);
  });
});

describe('SpaceIsland — overview content', () => {
  it('renders the task dashboard directly and removes legacy canvas wrappers', async () => {
    const { findByTestId, queryByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="overview" />
    );
    await findByTestId('space-dashboard');
    expect(queryByTestId('canvas-panel')).toBeNull();
    expect(queryByTestId('workflow-canvas')).toBeNull();
    expect(queryByTestId('dashboard-fallback')).toBeNull();
  });

  it('passes the route space id to overview self-managed navigation', async () => {
    const { findByTestId } = render(
      <SpaceIsland spaceId="space-1" routeSpaceId="space-slug" viewMode="overview" />
    );

    const overview = await findByTestId('space-dashboard');
    expect(overview.getAttribute('data-space-id')).toBe('space-1');
    expect(overview.getAttribute('data-navigation-space-id')).toBe('space-slug');

    fireEvent.click(await findByTestId('overview-select-task'));

    expect(mockNavigateToSpaceTask).toHaveBeenCalledWith('space-slug', 'task-from-overview');
  });
});

describe('SpaceIsland — configure workflow editor', () => {
  async function renderConfigure() {
    const result = render(<SpaceIsland spaceId="space-1" viewMode="configure" />);
    await waitFor(
      () => {
        expect(result.getByTestId('space-configure-tab-bar')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );
    return result;
  }

  it('renders configure sub-tabs', async () => {
    const { getByTestId } = await renderConfigure();
    expect(getByTestId('space-configure-tab-bar')).toBeTruthy();
    expect(getByTestId('space-configure-tab-agents')).toBeTruthy();
    expect(getByTestId('space-configure-tab-workflows')).toBeTruthy();
    expect(getByTestId('space-configure-tab-settings')).toBeTruthy();
  });

  it('does not load workflow details for the Worker Agents configure tab', async () => {
    configureTabBridge.signal.value = 'agents';
    await renderConfigure();

    expect(mockEnsureWorkflowDetails).not.toHaveBeenCalled();
  });

  it('opens the visual editor when creating a workflow', async () => {
    const result = await renderConfigure();
    fireEvent.click(result.getByTestId('space-configure-tab-workflows'));
    await waitFor(() => {
      expect(result.getByTestId('create-workflow-btn')).toBeTruthy();
    });
    fireEvent.click(result.getByTestId('create-workflow-btn'));
    await waitFor(() => {
      expect(result.getByTestId('visual-workflow-editor')).toBeTruthy();
    });
    expect(capturedVisualEditorProps.workflow).toBeUndefined();
  });

  it('opens the visual editor when editing a workflow', async () => {
    const result = await renderConfigure();
    fireEvent.click(result.getByTestId('space-configure-tab-workflows'));
    await waitFor(() => {
      expect(result.getByTestId('edit-workflow-btn')).toBeTruthy();
    });
    fireEvent.click(result.getByTestId('edit-workflow-btn'));
    await waitFor(() => {
      expect(result.getByTestId('visual-workflow-editor')).toBeTruthy();
    });
    expect((capturedVisualEditorProps.workflow as SpaceWorkflow)?.id).toBe('wf-existing');
  });

  it('hides configure sub-tabs while editing a workflow', async () => {
    const result = await renderConfigure();
    fireEvent.click(result.getByTestId('space-configure-tab-workflows'));
    await waitFor(() => {
      expect(result.getByTestId('create-workflow-btn')).toBeTruthy();
    });
    fireEvent.click(result.getByTestId('create-workflow-btn'));
    expect(result.queryByTestId('space-configure-tab-bar')).toBeNull();
  });

  it('keeps workflow editor open after save', async () => {
    const result = await renderConfigure();
    fireEvent.click(result.getByTestId('space-configure-tab-workflows'));
    await waitFor(() => {
      expect(result.getByTestId('create-workflow-btn')).toBeTruthy();
    });
    fireEvent.click(result.getByTestId('create-workflow-btn'));
    fireEvent.click(result.getByTestId('visual-editor-save'));
    expect(result.getByTestId('visual-workflow-editor')).toBeTruthy();
    expect(result.queryByTestId('space-configure-tab-bar')).toBeNull();
  });
});

describe('SpaceIsland — content priority chain', () => {
  it('renders ChatContainer when sessionViewId is set', async () => {
    const { findByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="overview" sessionViewId="session-abc" />
    );
    await findByTestId('chat-container');
  });

  it('renders SpaceTaskPane when taskViewId is set', async () => {
    const { getByTestId, findByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="overview" taskViewId="task-xyz" />
    );
    await findByTestId('space-task-pane-inner');
    expect(getByTestId('space-task-pane')).toBeTruthy();
    expect(getByTestId('space-task-pane-inner').getAttribute('data-task-id')).toBe('task-xyz');
    expect(getByTestId('space-task-pane-inner').getAttribute('data-space-id')).toBe('space-1');
  });

  it('passes the route space id to task detail navigation', async () => {
    const { getByTestId, findByTestId } = render(
      <SpaceIsland
        spaceId="space-1"
        routeSpaceId="space-slug"
        viewMode="overview"
        taskViewId="task-xyz"
      />
    );
    await findByTestId('space-task-pane-inner');
    expect(getByTestId('space-task-pane-inner').getAttribute('data-space-id')).toBe('space-1');
    expect(getByTestId('space-task-pane-inner').getAttribute('data-navigation-space-id')).toBe(
      'space-slug'
    );
  });

  it('sessionViewId takes priority over taskViewId', async () => {
    const { findByTestId, queryByTestId } = render(
      <SpaceIsland
        spaceId="space-1"
        viewMode="overview"
        sessionViewId="session-abc"
        taskViewId="task-xyz"
      />
    );
    await findByTestId('chat-container');
    expect(queryByTestId('space-task-pane')).toBeNull();
  });

  it('subscribes to task message activity while a task view is open', async () => {
    const { findByTestId, unmount } = render(
      <SpaceIsland spaceId="space-1" viewMode="overview" taskViewId="task-xyz" />
    );
    await findByTestId('space-task-pane-inner');
    expect(mockSubscribeTaskMessageActivity).toHaveBeenCalledWith('task-xyz');
    unmount();
    expect(mockUnsubscribeTaskMessageActivity).toHaveBeenCalledWith('task-xyz');
  });

  it('renders the task information panel when the task has no message activity', async () => {
    mockTaskMessageActivity.value = new Map([['task-xyz', 0]]);
    const { findByTestId, queryByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="overview" taskViewId="task-xyz" />
    );
    const panel = await findByTestId('task-auxiliary-panel');
    expect(panel.getAttribute('data-task-id')).toBe('task-xyz');
    expect(queryByTestId('space-task-pane-inner')).toBeNull();
  });

  it('renders the task thread pane when the task has message activity, regardless of status', async () => {
    mockTaskMessageActivity.value = new Map([['task-xyz', 3]]);
    const { findByTestId, queryByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="overview" taskViewId="task-xyz" />
    );
    await findByTestId('space-task-pane-inner');
    expect(queryByTestId('task-auxiliary-panel')).toBeNull();
  });

  it('switches from the information panel to the thread pane when activity arrives', async () => {
    mockTaskMessageActivity.value = new Map([['task-xyz', 0]]);
    const { findByTestId, queryByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="overview" taskViewId="task-xyz" />
    );
    await findByTestId('task-auxiliary-panel');
    mockTaskMessageActivity.value = new Map([['task-xyz', 1]]);
    await findByTestId('space-task-pane-inner');
    expect(queryByTestId('task-auxiliary-panel')).toBeNull();
  });
});

describe('SpaceIsland — goals view', () => {
  it('passes the route space id to goals page navigation', async () => {
    const { getByRole, getByTestId } = render(
      <SpaceIsland spaceId="space-1" routeSpaceId="space-slug" viewMode="goals" />
    );

    await waitFor(
      () => {
        expect(getByTestId('space-goals')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );
    expect(getByTestId('space-goals').getAttribute('data-space-id')).toBe('space-1');
    expect(getByTestId('space-goals').getAttribute('data-navigation-space-id')).toBe('space-slug');
    expect(getByTestId('space-goals-view').getAttribute('data-goals-surface')).toBe(
      'glass-workspace'
    );
    expect(getByRole('heading', { name: 'Goals' })).toBeTruthy();
  });
});

describe('SpaceIsland — memories view', () => {
  it('renders the memories route with the glass-workspace surface', async () => {
    const { getByRole, getByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="memories" />
    );

    await waitFor(
      () => {
        expect(getByTestId('space-memories-view')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );
    expect(getByTestId('space-memories-view').getAttribute('data-memories-surface')).toBe(
      'glass-workspace'
    );
    expect(getByRole('heading', { name: 'Memories' })).toBeTruthy();
  });
});

describe('SpaceIsland — sessions view', () => {
  it('renders Create Session button in the header', async () => {
    const { getByLabelText, getByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="sessions" />
    );
    await waitFor(
      () => {
        expect(getByTestId('space-sessions-view')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );
    expect(getByLabelText('Create session')).toBeTruthy();
  });

  it('passes the route space id to sessions page navigation', async () => {
    const { getByTestId } = render(
      <SpaceIsland spaceId="space-1" routeSpaceId="space-slug" viewMode="sessions" />
    );

    await waitFor(
      () => {
        expect(getByTestId('space-sessions-page')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );
    expect(getByTestId('space-sessions-page').getAttribute('data-space-id')).toBe('space-1');
    expect(getByTestId('space-sessions-page').getAttribute('data-navigation-space-id')).toBe(
      'space-slug'
    );
  });

  it('calls createSession and navigates on success', async () => {
    mockCreateSession.mockResolvedValueOnce({ sessionId: 'new-session-123' });
    mockCurrentSpaceIdSignal.value = 'space-1';
    mockCurrentSpaceViewModeSignal.value = 'sessions';

    const { getByLabelText, getByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="sessions" />
    );
    await waitFor(
      () => {
        expect(getByTestId('space-sessions-view')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );

    fireEvent.click(getByLabelText('Create session'));
    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
    });
    expect(mockCreateSession).toHaveBeenCalledWith({
      spaceId: 'space-1',
      workspacePath: undefined,
    });
    await waitFor(() => {
      expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-1', 'new-session-123');
    });
  });

  it('navigates after slug-routed session creation when canonical space still matches', async () => {
    mockCreateSession.mockResolvedValueOnce({ sessionId: 'new-session-123' });
    mockCurrentSpaceIdSignal.value = 'space-slug';
    mockCurrentSpaceCanonicalIdSignal.value = 'space-1';
    mockCurrentSpaceViewModeSignal.value = 'sessions';

    const { getByLabelText, getByTestId } = render(
      <SpaceIsland spaceId="space-1" routeSpaceId="space-slug" viewMode="sessions" />
    );
    await waitFor(
      () => {
        expect(getByTestId('space-sessions-view')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );

    fireEvent.click(getByLabelText('Create session'));

    await waitFor(() => {
      expect(mockNavigateToSpaceSession).toHaveBeenCalledWith('space-slug', 'new-session-123');
    });
  });

  it('skips slug-routed session navigation when canonical route state changed', async () => {
    mockCreateSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ sessionId: 'new-session-123' }), 50);
        })
    );
    mockCurrentSpaceIdSignal.value = 'space-slug';
    mockCurrentSpaceCanonicalIdSignal.value = 'space-1';
    mockCurrentSpaceViewModeSignal.value = 'sessions';

    const { getByLabelText, getByTestId } = render(
      <SpaceIsland spaceId="space-1" routeSpaceId="space-slug" viewMode="sessions" />
    );
    await waitFor(
      () => {
        expect(getByTestId('space-sessions-view')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );

    fireEvent.click(getByLabelText('Create session'));
    mockCurrentSpaceCanonicalIdSignal.value = 'space-2';

    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
    });
  });

  it('shows toast.error when createSession fails', async () => {
    mockCreateSession.mockRejectedValueOnce(new Error('Connection refused'));

    const { getByLabelText, getByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="sessions" />
    );
    await waitFor(
      () => {
        expect(getByTestId('space-sessions-view')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );

    fireEvent.click(getByLabelText('Create session'));
    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith('Connection refused');
    });
    expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
  });

  it('skips navigation when user has navigated to a different space', async () => {
    mockCreateSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ sessionId: 'new-session-123' }), 50);
        })
    );
    mockCurrentSpaceIdSignal.value = 'space-1';
    mockCurrentSpaceViewModeSignal.value = 'sessions';

    const { getByLabelText, getByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="sessions" />
    );
    await waitFor(
      () => {
        expect(getByTestId('space-sessions-view')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );

    fireEvent.click(getByLabelText('Create session'));
    mockCurrentSpaceIdSignal.value = 'space-2';
    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(mockNavigateToSpaceSession).not.toHaveBeenCalled();
    });
  });

  it('disables the button while creating session', async () => {
    mockCreateSession.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ sessionId: 'new-session-123' }), 50);
        })
    );

    const { getByLabelText, getByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="sessions" />
    );
    await waitFor(
      () => {
        expect(getByTestId('space-sessions-view')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );

    const btn = getByLabelText('Create session') as HTMLButtonElement;
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);
    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(btn.disabled).toBe(false);
    });
  });
});

describe('SpaceIsland — agents view', () => {
  it('renders the Agents-only Glass Workspace hero surface', async () => {
    const { findByTestId, getByRole } = render(<SpaceIsland spaceId="space-1" viewMode="agents" />);

    const agentsView = await findByTestId('space-agents-view');
    expect(agentsView.getAttribute('data-agents-surface')).toBe('glass-workspace');
    expect(getByRole('heading', { name: 'Agents' })).toBeTruthy();
  });

  it('passes the selected agent handle to the agents page', async () => {
    mockCurrentSpaceAgentHandleSignal.value = 'reviewer';
    mockAgents.value = [
      {
        id: 'agent-1',
        spaceId: 'space-1',
        name: 'Reviewer',
        handle: 'reviewer',
        status: 'active',
        customPrompt: 'Review code.',
        createdAt: 0,
        updatedAt: 0,
      },
    ];

    const { findByTestId } = render(<SpaceIsland spaceId="space-1" viewMode="agents" />);

    const agentsPage = await findByTestId('space-long-horizon-agents');
    expect(agentsPage.getAttribute('data-space-id')).toBe('space-1');
    expect(agentsPage.getAttribute('data-navigation-space-id')).toBe('space-1');
    expect(agentsPage.getAttribute('data-selected-handle')).toBe('reviewer');
    expect(agentsPage.getAttribute('data-space-agent')).toBe('reviewer');
  });

  it('passes the route space id to agent session navigation', async () => {
    const { findByTestId } = render(
      <SpaceIsland spaceId="space-1" routeSpaceId="space-slug" viewMode="agents" />
    );

    const agentsPage = await findByTestId('space-long-horizon-agents');
    expect(agentsPage.getAttribute('data-space-id')).toBe('space-1');
    expect(agentsPage.getAttribute('data-navigation-space-id')).toBe('space-slug');
  });
});

describe('SpaceIsland — tasks view', () => {
  it('renders Create Task button in the header', async () => {
    const { getByLabelText, getByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="tasks" />
    );
    await waitFor(
      () => {
        expect(getByTestId('space-tasks-view')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );
    expect(getByLabelText('Create task')).toBeTruthy();
  });

  it('opens SpaceCreateTaskDialog when Create Task button is clicked', async () => {
    const { getByLabelText, getByTestId, getByRole } = render(
      <SpaceIsland spaceId="space-1" viewMode="tasks" />
    );
    await waitFor(
      () => {
        expect(getByTestId('space-tasks-view')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );

    fireEvent.click(getByLabelText('Create task'));
    await waitFor(() => {
      expect(getByRole('heading', { name: 'Create Task' })).toBeTruthy();
    });
  });

  it('navigates after slug-routed task creation when canonical space still matches', async () => {
    mockCurrentSpaceIdSignal.value = 'space-slug';
    mockCurrentSpaceCanonicalIdSignal.value = 'space-1';
    mockCurrentSpaceViewModeSignal.value = 'tasks';

    const { getByLabelText, getByTestId, getByRole } = render(
      <SpaceIsland spaceId="space-1" routeSpaceId="space-slug" viewMode="tasks" />
    );
    await waitFor(
      () => {
        expect(getByTestId('space-tasks-view')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );

    fireEvent.click(getByLabelText('Create task'));
    await waitFor(() => {
      expect(getByRole('heading', { name: 'Create Task' })).toBeTruthy();
    });

    fireEvent.click(getByRole('button', { name: 'Create Test Task' }));

    expect(mockNavigateToSpaceTask).toHaveBeenCalledWith('space-slug', 'new-task-123');
  });

  it('skips slug-routed task navigation when canonical route state changed', async () => {
    mockCurrentSpaceIdSignal.value = 'space-slug';
    mockCurrentSpaceCanonicalIdSignal.value = 'space-1';
    mockCurrentSpaceViewModeSignal.value = 'tasks';

    const { getByLabelText, getByTestId, getByRole } = render(
      <SpaceIsland spaceId="space-1" routeSpaceId="space-slug" viewMode="tasks" />
    );
    await waitFor(
      () => {
        expect(getByTestId('space-tasks-view')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );

    fireEvent.click(getByLabelText('Create task'));
    await waitFor(() => {
      expect(getByRole('heading', { name: 'Create Task' })).toBeTruthy();
    });

    mockCurrentSpaceCanonicalIdSignal.value = 'space-2';
    fireEvent.click(getByRole('button', { name: 'Create Test Task' }));

    expect(mockNavigateToSpaceTask).not.toHaveBeenCalled();
  });
});
