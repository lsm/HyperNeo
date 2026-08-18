import type { Space } from '@hyperneo/shared';
import type { ComponentChildren } from 'preact';
import { type Signal, signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockNavigateToSpace,
  mockNavigateToSpaceAgent,
  mockNavigateToSpaceConfigure,
  mockNavigateToSpaceSessions,
  mockNavigateToSpaceGoals,
  mockNavigateToSpaceTasks,
  mockNavigateToSession,
  mockNavigateToSessions,
  mockNavigateToSettings,
  mockNavigateToSpaces,
} = vi.hoisted(() => ({
  mockNavigateToSpace: vi.fn(),
  mockNavigateToSpaceAgent: vi.fn(),
  mockNavigateToSpaceConfigure: vi.fn(),
  mockNavigateToSpaceSessions: vi.fn(),
  mockNavigateToSpaceGoals: vi.fn(),
  mockNavigateToSpaceTasks: vi.fn(),
  mockNavigateToSession: vi.fn(),
  mockNavigateToSessions: vi.fn(),
  mockNavigateToSettings: vi.fn(),
  mockNavigateToSpaces: vi.fn(),
}));

let mockNavSectionSignal!: Signal<'chats' | 'spaces' | 'settings'>;
let mockContextPanelOpenSignal!: Signal<boolean>;
let mockCurrentSpaceIdSignal!: Signal<string | null>;
let mockCurrentSpaceConfigureTabSignal!: Signal<'agents' | 'workflows' | 'settings'>;
let mockCurrentSpaceSessionIdSignal!: Signal<string | null>;
let mockCurrentSpaceTasksFilterTabSignal!: Signal<
  'action' | 'active' | 'completed' | 'archived' | 'draft'
>;
let mockCurrentSpaceViewModeSignal!: Signal<
  'overview' | 'goals' | 'tasks' | 'sessions' | 'configure'
>;
let mockSettingsSectionSignal!: Signal<
  'general' | 'providers' | 'app-mcp-servers' | 'skills' | 'models' | 'usage' | 'about'
>;
let mockConnectionStateSignal!: Signal<'connecting' | 'connected'>;
let mockSpacesWithTasksSignal!: Signal<Array<Space & { tasks: unknown[]; sessions: unknown[] }>>;
let mockSpaceSignal!: Signal<Space | null>;
const mockInitGlobalList = vi.fn(() => Promise.resolve());

function makeSpace(id: string, overrides: Partial<Space> = {}): Space {
  return {
    id,
    slug: id,
    workspacePath: `/workspace/${id}`,
    name: `Space ${id}`,
    description: '',
    backgroundContext: '',
    instructions: '',
    sessionIds: [],
    status: 'active',
    paused: false,
    stopped: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Space;
}

function initSignals() {
  mockNavSectionSignal = signal('spaces');
  mockContextPanelOpenSignal = signal(true);
  mockCurrentSpaceIdSignal = signal('space-1');
  mockCurrentSpaceConfigureTabSignal = signal('agents');
  mockCurrentSpaceSessionIdSignal = signal(null);
  mockCurrentSpaceTasksFilterTabSignal = signal('active');
  mockCurrentSpaceViewModeSignal = signal('overview');
  mockSettingsSectionSignal = signal('general');
  mockConnectionStateSignal = signal('connected');
  mockSpacesWithTasksSignal = signal([
    { ...makeSpace('space-1', { name: 'Alpha' }), tasks: [], sessions: [] },
    { ...makeSpace('space-2', { name: 'Beta' }), tasks: [], sessions: [] },
  ]);
  mockSpaceSignal = signal(makeSpace('space-1', { name: 'Alpha' }));
  mockInitGlobalList.mockClear();
}

initSignals();

vi.mock('../SessionList.tsx', () => ({
  SessionList: () => <div data-testid="session-list" />,
}));

vi.mock('../SpaceDetailPanel.tsx', () => ({
  SpaceDetailPanel: () => <div data-testid="space-detail-panel" />,
}));

vi.mock('../../components/space/SpaceCreateDialog.tsx', () => ({
  SpaceCreateDialog: ({ isOpen }: { isOpen: boolean }) =>
    isOpen ? <div role="dialog">Create Space Dialog</div> : null,
}));

vi.mock('../../components/DaemonStatusIndicator.tsx', () => ({
  DaemonStatusIndicator: () => <div data-testid="daemon-status" />,
}));

vi.mock('../../components/ui/Button.tsx', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: ComponentChildren;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

vi.mock('../../components/ui/NavIconButton.tsx', () => ({
  NavIconButton: ({
    children,
    onClick,
    label,
  }: {
    children: ComponentChildren;
    onClick: () => void;
    label: string;
  }) => (
    <button type="button" onClick={onClick} aria-label={label}>
      {children}
    </button>
  ),
}));

vi.mock('../../lib/router.ts', () => ({
  navigateToSession: mockNavigateToSession,
  navigateToSessions: mockNavigateToSessions,
  navigateToSettings: mockNavigateToSettings,
  navigateToSpaces: mockNavigateToSpaces,
  navigateToSpace: mockNavigateToSpace,
  navigateToSpaceAgent: mockNavigateToSpaceAgent,
  navigateToSpaceConfigure: mockNavigateToSpaceConfigure,
  navigateToSpaceSessions: mockNavigateToSpaceSessions,
  navigateToSpaceGoals: mockNavigateToSpaceGoals,
  navigateToSpaceTasks: mockNavigateToSpaceTasks,
}));

vi.mock('../../lib/signals.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/signals.ts')>();
  return {
    ...actual,
    get navSectionSignal() {
      return mockNavSectionSignal;
    },
    get contextPanelOpenSignal() {
      return mockContextPanelOpenSignal;
    },
    get currentSpaceIdSignal() {
      return mockCurrentSpaceIdSignal;
    },
    get currentSpaceConfigureTabSignal() {
      return mockCurrentSpaceConfigureTabSignal;
    },
    get currentSpaceSessionIdSignal() {
      return mockCurrentSpaceSessionIdSignal;
    },
    get currentSpaceTasksFilterTabSignal() {
      return mockCurrentSpaceTasksFilterTabSignal;
    },
    get currentSpaceViewModeSignal() {
      return mockCurrentSpaceViewModeSignal;
    },
    get settingsSectionSignal() {
      return mockSettingsSectionSignal;
    },
  };
});

vi.mock('../../lib/state.ts', () => ({
  get connectionState() {
    return mockConnectionStateSignal;
  },
  authStatus: { value: { isAuthenticated: true } },
}));

vi.mock('../../lib/space-store.ts', () => ({
  get spaceStore() {
    return {
      spacesWithTasks: mockSpacesWithTasksSignal,
      space: mockSpaceSignal,
      initGlobalList: mockInitGlobalList,
    };
  },
}));

vi.mock('../../lib/api-helpers.ts', () => ({
  createSession: vi.fn(),
}));

vi.mock('../../lib/toast.ts', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

import { ContextPanel } from '../ContextPanel';

describe('ContextPanel', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    initSignals();
  });

  afterEach(() => {
    cleanup();
  });

  it.each([
    ['overview', mockNavigateToSpace, ['space-2']],
    ['goals', mockNavigateToSpaceGoals, ['space-2']],
    ['tasks', mockNavigateToSpaceTasks, ['space-2', 'active']],
    ['sessions', mockNavigateToSpaceSessions, ['space-2']],
    ['configure', mockNavigateToSpaceConfigure, ['space-2', 'agents']],
  ] as const)('preserves the %s view mode when switching spaces', (viewMode, expectedNavigate, args) => {
    mockCurrentSpaceViewModeSignal.value = viewMode;
    mockCurrentSpaceIdSignal.value = null;
    render(<ContextPanel />);

    fireEvent.click(screen.getByText('Beta'));

    expect(expectedNavigate).toHaveBeenCalledWith(...args);
    expect(mockNavigateToSpaceAgent).not.toHaveBeenCalled();
    expect(mockContextPanelOpenSignal.value).toBe(false);
  });

  it('preserves the current task filter when switching spaces from tasks', () => {
    mockCurrentSpaceViewModeSignal.value = 'tasks';
    mockCurrentSpaceTasksFilterTabSignal.value = 'completed';
    mockCurrentSpaceIdSignal.value = null;
    render(<ContextPanel />);

    fireEvent.click(screen.getByText('Beta'));

    expect(mockNavigateToSpaceTasks).toHaveBeenCalledWith('space-2', 'completed');
    expect(mockContextPanelOpenSignal.value).toBe(false);
  });

  it('preserves the current configure subtab when switching spaces from configure', () => {
    mockCurrentSpaceViewModeSignal.value = 'configure';
    mockCurrentSpaceConfigureTabSignal.value = 'workflows';
    mockCurrentSpaceIdSignal.value = null;
    render(<ContextPanel />);

    fireEvent.click(screen.getByText('Beta'));

    expect(mockNavigateToSpaceConfigure).toHaveBeenCalledWith('space-2', 'workflows');
    expect(mockContextPanelOpenSignal.value).toBe(false);
  });

  it('navigates to tasks view when switching spaces while tasks view is active', () => {
    mockCurrentSpaceViewModeSignal.value = 'tasks';
    mockCurrentSpaceIdSignal.value = null;
    render(<ContextPanel />);

    fireEvent.click(screen.getByText('Beta'));

    expect(mockNavigateToSpaceTasks).toHaveBeenCalledWith('space-2', 'active');
    expect(mockNavigateToSpaceAgent).not.toHaveBeenCalled();
    expect(mockContextPanelOpenSignal.value).toBe(false);
  });

  it('renders the spaces list when no space is selected', () => {
    mockCurrentSpaceIdSignal.value = null;
    mockContextPanelOpenSignal.value = true;

    render(<ContextPanel />);

    expect(screen.getByTestId('space-switcher')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.getByText('Beta')).toBeTruthy();
    expect(mockContextPanelOpenSignal.value).toBe(true);
  });

  it('keeps global navigation available in the sidebar switcher', () => {
    render(<ContextPanel />);

    fireEvent.click(screen.getAllByRole('tab', { name: 'Spaces' })[0]);
    fireEvent.click(screen.getAllByRole('tab', { name: 'Chats' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(mockNavigateToSpaces).toHaveBeenCalledTimes(1);
    expect(mockNavigateToSessions).toHaveBeenCalledTimes(1);
    expect(mockNavigateToSettings).toHaveBeenCalledTimes(1);
  });

  it('opens the create space dialog directly from the mobile switcher', () => {
    mockCurrentSpaceIdSignal.value = null;
    render(<ContextPanel />);

    fireEvent.click(screen.getByText('Create Space'));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Create Space Dialog')).toBeTruthy();
    expect(mockNavigateToSpaces).not.toHaveBeenCalled();
    expect(mockContextPanelOpenSignal.value).toBe(false);
  });
});
