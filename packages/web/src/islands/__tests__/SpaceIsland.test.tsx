// @ts-nocheck
/**
 * Tests for SpaceIsland.
 *
 * Covers:
 * - route-driven overview vs configure rendering
 * - workflow editor behavior inside configure
 * - content priority for session/task routes
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/preact';

// Default waitFor timeout of 1000ms is too tight for lazy-loaded routes under
// full-suite load (CI parallel workers, Vite transform pipeline). Bumping to
// 5s for all lazy-module assertions eliminates flakiness without slowing the
// happy path, since waitFor returns as soon as the assertion passes.
const LAZY_LOAD_TIMEOUT = 5000;
import { signal } from '@preact/signals';
import type { SpaceWorkflow, SpaceAgent, Space } from '@neokai/shared';

let mockLoading = signal(false);
let mockError = signal<string | null>(null);
let mockSpace = signal<Space | null>(null);
let mockWorkflows = signal<SpaceWorkflow[]>([]);
let mockAgents = signal<SpaceAgent[]>([]);

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

const { mockNavigateToSpaceSession } = vi.hoisted(() => ({
  mockNavigateToSpaceSession: vi.fn(),
}));

const { mockCreateSession } = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
}));

const { mockToastError } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
}));

// Real Preact signal for the configure tab (read during render — needs reactivity)
const mockCurrentSpaceConfigureTabSignal = signal<string>('agents');
const mockCurrentSpaceIdSignal = signal<string | null>(null);
const mockCurrentSpaceViewModeSignal = signal<string>('overview');

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
    get currentSpaceViewModeSignal() {
      return mockCurrentSpaceViewModeSignal;
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
  SpaceOverview: () => <div data-testid="space-dashboard" />,
}));

vi.mock('../../components/space/SpaceTaskPane', () => ({
  SpaceTaskPane: (props: { taskId: string | null; spaceId?: string }) => (
    <div
      data-testid="space-task-pane-inner"
      data-task-id={props.taskId ?? ''}
      data-space-id={props.spaceId ?? ''}
    />
  ),
}));

vi.mock('../../components/space/SpaceAgentList', () => ({
  SpaceAgentList: () => <div data-testid="space-agent-list" />,
}));

vi.mock('../../components/space/SpaceSettings', () => ({
  SpaceSettings: () => <div data-testid="space-settings" />,
}));

vi.mock('../ChatContainer', () => ({
  default: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="chat-container" data-session-id={sessionId} />
  ),
}));

vi.mock('../../lib/space-store', () => ({
  get spaceStore() {
    return {
      loading: mockLoading,
      error: mockError,
      space: mockSpace,
      workflows: mockWorkflows,
      agents: mockAgents,
      sessions: { value: [] },
      tasks: { value: [] },
      schedules: { value: [] },
      listSchedules: vi.fn().mockResolvedValue(undefined),
      configDataLoaded: { value: true },
      ensureConfigData: vi.fn().mockResolvedValue(undefined),
      ensureNodeExecutions: vi.fn().mockResolvedValue(undefined),
      selectSpace: mockSelectSpace,
      workflowVersions: signal(new Map()),
      fetchWorkflowDetail: vi.fn((id: string) =>
        Promise.resolve(mockWorkflows.value.find((w) => w.id === id) ?? null)
      ),
    };
  },
}));

vi.mock('../../lib/router', () => ({
  navigateToSpace: vi.fn(),
  navigateToSpaceTask: vi.fn(),
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
  capturedVisualEditorProps = {};
  configureTabBridge.signal.value = 'agents';
  idBridge.signal.value = null;
  mockNavigateToSpaceConfigure.mockClear();
  mockNavigateToSpaceSession.mockClear();
  mockCreateSession.mockClear();
  mockToastError.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('SpaceIsland — route-driven views', () => {
  it('renders the overview view without the legacy top tab bar', async () => {
    const { getByTestId, queryByTestId } = render(
      <SpaceIsland spaceId="space-1" viewMode="overview" />
    );
    // Wait for lazy SpaceOverview to load through Suspense
    await waitFor(
      () => {
        expect(getByTestId('space-dashboard')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );
    // Outer wrapper
    expect(getByTestId('space-overview-view')).toBeTruthy();
    // Legacy tab bar is removed from overview
    expect(queryByTestId('space-tab-bar')).toBeNull();
  });

  it('renders the configure view when requested', async () => {
    const { getByTestId } = render(<SpaceIsland spaceId="space-1" viewMode="configure" />);
    // Wait for lazy SpaceConfigurePage to load through Suspense
    await waitFor(
      () => {
        expect(getByTestId('space-agent-list')).toBeTruthy();
      },
      { timeout: LAZY_LOAD_TIMEOUT }
    );
    expect(getByTestId('space-configure-view')).toBeTruthy();
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
});
