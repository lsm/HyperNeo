// @ts-nocheck
/**
 * Tests for SpaceIsland.
 *
 * Covers:
 * - route-driven overview vs configure rendering
 * - workflow editor behavior inside configure
 * - content priority for session/task routes
 */

import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Default waitFor timeout of 1000ms is too tight for lazy-loaded routes under
// full-suite load (CI parallel workers, Vite transform pipeline). Bumping to
// 5s for all lazy-module assertions eliminates flakiness without slowing the
// happy path, since waitFor returns as soon as the assertion passes.
const LAZY_LOAD_TIMEOUT = 5000;

import type { Space, SpaceWorkerAgent, SpaceWorkflow } from '@hyperneo/shared';
import { signal } from '@preact/signals';
import { connectionState } from '../../lib/state';

let mockLoading = signal(false);
let mockError = signal<string | null>(null);
let mockSpace = signal<Space | null>(null);
let mockWorkflows = signal<SpaceWorkflow[]>([]);
let mockAgents = signal<SpaceWorkerAgent[]>([]);
let mockStoreSpaceId = signal<string | null>('space-1');
let mockConfigDataLoaded = signal(true);
const mockEnsureConfigData = vi.fn().mockResolvedValue(undefined);
const mockEnsureWorkflowDetails = vi.fn().mockResolvedValue(undefined);

const mockSelectSpace = vi.fn().mockResolvedValue(undefined);

// Bridge pattern: hoisted bridge so mockNavigateToSpaceConfigure can update
// the real Preact signal (created after import) for reactivity.
const { configureTabBridge, idBridge } = vi.hoisted(() => ({
  configureTabBridge: { signal: null as ReturnType<typeof signal<string>> | null },
  idBridge: { signal: null as ReturnType<typeof signal<string | null>> | null },
}));

// Hoisted mock for navigateToSpaceConfigure — updates real signal at call time
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

const { mockToastWarning } = vi.hoisted(() => ({
  mockToastWarning: vi.fn(),
}));

// Captured hub.onEvent subscriptions so tests can emit client events into the
// component (externalEvent.dropped drop surfacing). Each entry is the handler
// registered for that client event name. getHub can be made to reject to
// simulate a daemon-offline mount, then succeed on reconnection.
const { mockGetHub, hubEventHandlers, setGetHubResult } = vi.hoisted(() => {
  const hubEventHandlers = new Map<string, Array<(event: unknown) => void>>();
  let hubResult: Promise<unknown> | null = null;
  const mockGetHub = vi.fn().mockImplementation(() => {
    if (hubResult) return hubResult;
    return Promise.resolve({
      onEvent: (name: string, handler: (event: unknown) => void) => {
        const existing = hubEventHandlers.get(name) ?? [];
        existing.push(handler);
        hubEventHandlers.set(name, existing);
        return () => {
          const handlers = hubEventHandlers.get(name);
          const idx = handlers?.indexOf(handler) ?? -1;
          if (idx >= 0) handlers!.splice(idx, 1);
        };
      },
    });
  });
  const setGetHubResult = (result: Promise<unknown> | null) => {
    hubResult = result;
  };
  return { mockGetHub, hubEventHandlers, setGetHubResult };
});

// Real Preact signal for the configure tab (read during render — needs reactivity)
const mockCurrentSpaceConfigureTabSignal = signal<string>('agents');
const mockCurrentSpaceIdSignal = signal<string | null>(null);
const mockCurrentSpaceCanonicalIdSignal = signal<string | null>(null);
const mockCurrentSpaceAgentHandleSignal = signal<string | null>(null);
const mockCurrentSpaceViewModeSignal = signal<string>('overview');

// Overlay signals (task #873) — control whether an agent overlay is open over
// the base content so the inert/aria-hidden behavior is testable.
const mockSpaceOverlaySessionIdSignal = signal<string | null>(null);
const mockSpaceOverlayAgentNameSignal = signal<string | null>(null);
const mockSpaceOverlayHighlightMessageIdSignal = signal<string | null>(null);
const mockSpaceOverlayPendingTaskIdSignal = signal<string | null>(null);
const mockSpaceOverlayPendingAgentNameSignal = signal<string | null>(null);
const mockSpaceOverlayTaskContextSignal = signal<unknown>(null);

// Wire bridge so mockNavigateToSpaceConfigure can update the real signal
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

// Stub the agent overlay so opening it doesn't drag in Portal/focus-trap/scroll
// logic — the inert test only cares that the base layer is disabled when an
// overlay is open, not the overlay's own internals.
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

// SpaceIsland subscribes to `externalEvent.dropped` through the real
// connection manager — unmocked it would open a WebSocket under happy-dom and
// reject, surfacing as unhandled rejections in CI.
vi.mock('../../lib/connection-manager', () => ({
  connectionManager: {
    getHub: mockGetHub,
  },
}));

vi.mock('../../lib/toast', () => ({
  toast: {
    error: mockToastError,
    warning: mockToastWarning,
  },
}));

import SpaceIsland from '../SpaceIsland';

// Eagerly resolve the lazily-imported modules used by SpaceIsland so that
// <Suspense> boundaries inside the component tree can resolve on the first
// microtask in tests. Without this, test assertions race against Vite's
// module transform pipeline under full-suite load.
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
  capturedVisualEditorProps = {};
  configureTabBridge.signal.value = 'agents';
  idBridge.signal.value = null;
  mockCurrentSpaceAgentHandleSignal.value = null;
  mockCurrentSpaceCanonicalIdSignal.value = null;
  // Reset overlay signals so each test starts with no overlay open.
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
  mockToastWarning.mockClear();
  mockGetHub.mockClear();
  hubEventHandlers.clear();
  setGetHubResult(null);
  connectionState.value = 'connected';
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
    // Overlay itself renders on top.
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
    // An overlay can persist across sidebar navigation, so the inert/hidden
    // props must apply to the sessions view (and the other viewMode branches),
    // not only the session + task-detail branches.
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
    // Wait for lazy SpaceOverview to load through Suspense
    await waitFor(
      () => {
        expect(getByTestId('space-dashboard')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );
    // Outer wrapper and Overview-only workspace treatment
    expect(getByTestId('space-overview-view')).toBeTruthy();
    expect(getByTestId('space-overview-view').getAttribute('data-overview-surface')).toBe(
      'glass-workspace'
    );
    expect(getByTestId('space-dashboard').getAttribute('data-space-id')).toBe('space-1');
    expect(getByText('Space operations and recent activity')).toBeTruthy();
    // Legacy tab bar is removed from overview
    expect(queryByTestId('space-tab-bar')).toBeNull();
  });

  it('renders the configure view when requested', async () => {
    const { getByTestId } = render(<SpaceIsland spaceId="space-1" viewMode="configure" />);
    // Wait for lazy SpaceConfigurePage to load through Suspense
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
    // Wait for lazy SpaceConfigurePage to load through Suspense
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
    // Navigation is conditional on currentSpaceIdSignal and currentSpaceViewModeSignal
    // matching the origin values. In tests these signals are real Preact signals
    // but the component reads them at resolution time, not via subscription,
    // so the guard should pass when values match.
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
    // Simulate user navigating to a different space while request is in flight
    mockCurrentSpaceIdSignal.value = 'space-2';
    await waitFor(() => {
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
    });
    // Wait for the delayed promise to fully settle before asserting no navigation
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
    // Wait for the async handler to finish and re-enable the button
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
    // Dialog title is a heading; use getByRole to avoid matching the submit button
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

describe('SpaceIsland — externalEvent.dropped surfacing', () => {
  async function emitDrop(event: Record<string, unknown>): Promise<void> {
    await waitFor(() => {
      expect(hubEventHandlers.get('externalEvent.dropped')).toBeTruthy();
    });
    for (const handler of hubEventHandlers.get('externalEvent.dropped') ?? []) {
      handler(event);
    }
  }

  it('toasts a retry-exhausted drop for the open space', async () => {
    render(<SpaceIsland spaceId="space-1" viewMode="overview" />);
    await waitFor(() => {
      // Signal subscriptions invoke their callback immediately, so a connected
      // mount registers exactly ONE listener — not one from an unconditional
      // subscribe() plus another from the immediate signal callback.
      expect(hubEventHandlers.get('externalEvent.dropped')?.length).toBe(1);
    });
    await emitDrop({
      spaceId: 'space-1',
      eventId: 'evt-1',
      deliveryKey: 'dk-1',
      topic: 'github/o/r/pull_request/42.review_comment_polled',
      summary: 'PR review comment',
      category: 'retry_exhausted',
      reason: 'retry_exhausted; deliveryMode:defer; ...',
      agentName: 'coder',
      timestamp: 0,
    });

    await waitFor(() => {
      expect(mockToastWarning).toHaveBeenCalledTimes(1);
    });
    const [message] = mockToastWarning.mock.calls[0];
    expect(message).toContain('coder');
    expect(message).toContain('PR review comment');
    expect(message).toContain('exhausted delivery retries');
  });

  it('toasts a ttl-expired drop with the expiry detail', async () => {
    render(<SpaceIsland spaceId="space-1" viewMode="overview" />);
    await emitDrop({
      spaceId: 'space-1',
      eventId: 'evt-ttl',
      topic: 'github/o/r/pull_request/42.push',
      summary: 'PR pushed',
      category: 'ttl_expired',
      agentName: 'coder',
    });

    await waitFor(() => {
      expect(mockToastWarning).toHaveBeenCalledTimes(1);
    });
    expect(mockToastWarning.mock.calls[0][0]).toContain('expired before delivery');
  });

  it('ignores drops for other spaces', async () => {
    render(<SpaceIsland spaceId="space-1" viewMode="overview" />);
    await emitDrop({
      spaceId: 'space-other',
      eventId: 'evt-other',
      topic: 'github/o/r/pull_request/42.review_comment_polled',
      summary: 'PR review comment',
      category: 'retry_exhausted',
      agentName: 'coder',
    });

    // Give the (filtered) handler a tick — no toast may fire.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mockToastWarning).not.toHaveBeenCalled();
  });

  it('collapses duplicate drops of the same event but still toasts a distinct later drop on the same topic', async () => {
    render(<SpaceIsland spaceId="space-1" viewMode="overview" />);
    const baseDrop = {
      spaceId: 'space-1',
      topic: 'github/o/r/pull_request/42.review_comment_polled',
      summary: 'PR review comment',
      category: 'retry_exhausted',
      agentName: 'coder',
    };
    // Same event fanned out to multiple deliveries (coder + reviewer).
    await emitDrop({ ...baseDrop, eventId: 'evt-dup', deliveryKey: 'dk-a' });
    await emitDrop({ ...baseDrop, eventId: 'evt-dup', deliveryKey: 'dk-b' });
    await waitFor(() => {
      expect(mockToastWarning).toHaveBeenCalledTimes(1);
    });

    // A genuinely distinct later drop on the SAME topic still surfaces — the
    // dedupe key is the eventId, not the topic.
    await emitDrop({ ...baseDrop, eventId: 'evt-distinct', deliveryKey: 'dk-c' });
    await waitFor(() => {
      expect(mockToastWarning).toHaveBeenCalledTimes(2);
    });
  });

  it('re-toasts the same event after the dedupe window expires', async () => {
    // Subscribe under real timers first — waitFor needs a live clock and the
    // component's getHub resolves on the microtask queue.
    const view = render(<SpaceIsland spaceId="space-1" viewMode="overview" />);
    await waitFor(() => {
      expect(hubEventHandlers.get('externalEvent.dropped')).toBeTruthy();
    });
    const drop = {
      spaceId: 'space-1',
      eventId: 'evt-window',
      topic: 'github/o/r/pull_request/42.review_comment_polled',
      summary: 'PR review comment',
      category: 'retry_exhausted',
      agentName: 'coder',
    };
    for (const handler of hubEventHandlers.get('externalEvent.dropped') ?? []) handler(drop);
    await waitFor(() => {
      expect(mockToastWarning).toHaveBeenCalledTimes(1);
    });

    vi.useFakeTimers();
    try {
      // Same event again inside the window: suppressed.
      for (const handler of hubEventHandlers.get('externalEvent.dropped') ?? []) handler(drop);
      await vi.advanceTimersByTimeAsync(10);
      expect(mockToastWarning).toHaveBeenCalledTimes(1);

      // Past the 60s window the key expires — a re-drop toasts again.
      await vi.advanceTimersByTimeAsync(61_000);
      for (const handler of hubEventHandlers.get('externalEvent.dropped') ?? []) handler(drop);
      await vi.advanceTimersByTimeAsync(10);
      expect(mockToastWarning).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
    view.unmount();
  });

  it('collapses a burst of drops beyond the first three into one counted summary', async () => {
    // The toast container renders only the last few toasts, so one toast per
    // dropped event hides the tail of a burst. The first three drops toast
    // individually; the rest land as a single counted summary when the burst
    // window closes.
    render(<SpaceIsland spaceId="space-1" viewMode="overview" />);
    await waitFor(() => {
      expect(hubEventHandlers.get('externalEvent.dropped')).toBeTruthy();
    });
    const drop = (n: number) => ({
      spaceId: 'space-1',
      eventId: `evt-burst-${n}`,
      topic: 'github/o/r/pull_request/42.review_comment_polled',
      summary: `PR review comment ${n}`,
      category: 'retry_exhausted',
      agentName: 'coder',
    });
    // Emit the burst under fake timers so the summary timer the component
    // arms for the window close is itself fake and advanceable.
    vi.useFakeTimers();
    try {
      for (let i = 1; i <= 6; i++) {
        for (const handler of hubEventHandlers.get('externalEvent.dropped') ?? []) handler(drop(i));
      }
      // The individually shown toasts are the FIRST three drops, in order;
      // the tail is suppressed with no immediate toast.
      expect(mockToastWarning).toHaveBeenCalledTimes(3);
      expect(mockToastWarning.mock.calls[0][0]).toContain('PR review comment 1');
      expect(mockToastWarning.mock.calls[1][0]).toContain('PR review comment 2');
      expect(mockToastWarning.mock.calls[2][0]).toContain('PR review comment 3');

      // Advance past the burst window: the suppressed tail surfaces as ONE
      // counted summary instead of three more invisible toasts.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockToastWarning).toHaveBeenCalledTimes(4);
      expect(mockToastWarning.mock.calls[3][0]).toContain('3 more external events dropped');
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-subscribes after the connection recovers from a daemon-offline mount', async () => {
    // Mount while the daemon is unreachable: getHub rejects, no subscription.
    // The stored promise carries a no-op .catch of its own so vitest never
    // sees it as unhandled; the DERIVED promise returned to the component
    // still rejects into the component's own .catch.
    const offlineHub = Promise.reject(new Error('daemon offline'));
    offlineHub.catch(() => {});
    setGetHubResult(offlineHub);
    connectionState.value = 'disconnected';
    render(<SpaceIsland spaceId="space-1" viewMode="overview" />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(hubEventHandlers.get('externalEvent.dropped')).toBeFalsy();

    // Connection recovers → the effect re-subscribes through the new hub.
    setGetHubResult(null);
    connectionState.value = 'connecting';
    connectionState.value = 'connected';
    await waitFor(() => {
      expect(hubEventHandlers.get('externalEvent.dropped')?.length).toBeGreaterThan(0);
    });

    // The re-established handler still toasts drops.
    for (const handler of hubEventHandlers.get('externalEvent.dropped') ?? []) {
      handler({
        spaceId: 'space-1',
        eventId: 'evt-after-reconnect',
        topic: 'github/o/r/pull_request/42.review_comment_polled',
        summary: 'PR review comment',
        category: 'retry_exhausted',
        agentName: 'coder',
      });
    }
    await waitFor(() => {
      expect(mockToastWarning).toHaveBeenCalledTimes(1);
    });
  });
});
