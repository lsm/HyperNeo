import { render } from '@testing-library/preact';
import { signal } from '@preact/signals';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  let resolveHub: (hub: unknown) => void = () => {};
  return {
    hub: new Promise<unknown>((resolve) => {
      resolveHub = resolve;
    }),
    resolveHub: (hub: unknown) => resolveHub(hub),
    select: vi.fn(),
  };
});

vi.mock('../hooks/useViewportSafety.ts', () => ({ useViewportSafety: () => {} }));
vi.mock('../hooks/useGlobalShortcuts.ts', () => ({ useGlobalShortcuts: () => {} }));
vi.mock('../islands/ContextPanel.tsx', () => ({ ContextPanel: () => null }));
vi.mock('../islands/MainContent.tsx', () => ({ default: () => null }));
vi.mock('../islands/RightPanel.tsx', () => ({
  RightPanel: () => null,
  RightPanelToggle: () => null,
}));
vi.mock('../islands/ToastContainer.tsx', () => ({ default: () => null }));
vi.mock('../islands/CommandPalette.tsx', () => ({ CommandPalette: () => null }));
vi.mock('../components/ConnectionOverlay.tsx', () => ({ ConnectionOverlay: () => null }));
vi.mock('../lib/default-commands.ts', () => ({}));
vi.mock('../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: () => fixture.hub },
}));
vi.mock('../lib/state.ts', () => ({ initializeApplicationState: async () => {} }));
vi.mock('../lib/session-status.ts', () => ({ initSessionStatusTracking: () => {} }));
vi.mock('../lib/global-store.ts', () => ({ globalStore: { initialize: async () => {} } }));
vi.mock('../lib/session-store.ts', () => ({ sessionStore: { select: fixture.select } }));
vi.mock('../lib/app-routing.ts', () => ({ deriveAppExpectedPath: () => window.location.pathname }));
vi.mock('../lib/signals.ts', async () => {
  const { signal: make } = await import('@preact/signals');
  return {
    currentSessionIdSignal: make<string | null>(null),
    currentSpaceAgentHandleSignal: make(null),
    currentSpaceIdSignal: make(null),
    currentSpaceSessionIdSignal: make(null),
    currentSpaceSettingsTabSignal: make(null),
    currentSpaceTaskIdSignal: make(null),
    currentSpaceViewModeSignal: make(null),
    currentSpaceTasksFilterTabSignal: make(null),
    navSectionSignal: make('chats'),
  };
});
vi.mock('../lib/router.ts', () => {
  const noop = () => {};
  return {
    initializeRouter: () => null,
    navigateToSession: noop,
    navigateToHome: noop,
    navigateToSessions: noop,
    navigateToSpacesPage: noop,
    navigateToSpace: noop,
    navigateToSpaceConfigure: noop,
    navigateToSpaceGoals: noop,
    navigateToSpaceMemories: noop,
    navigateToSpaceEvolve: noop,
    navigateToSpaceTasks: noop,
    navigateToSpaceAgent: noop,
    navigateToSpaceSession: noop,
    navigateToSpaceTask: noop,
    navigateToSettings: noop,
  };
});

const { App } = await import('../App.tsx');
const { currentSessionIdSignal } = (await import('../lib/signals.ts')) as unknown as {
  currentSessionIdSignal: ReturnType<typeof signal<string | null>>;
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('App', () => {
  afterEach(() => {
    fixture.select.mockClear();
  });

  it('does not observe session selection after unmounting before init finishes', async () => {
    const view = render(<App />);
    view.unmount();
    fixture.resolveHub({});
    await settle();

    currentSessionIdSignal.value = 'session-after-unmount';

    expect(fixture.select).not.toHaveBeenCalled();
  });

  it('stops observing session selection when unmounted after init', async () => {
    fixture.resolveHub({});
    const view = render(<App />);
    await settle();
    currentSessionIdSignal.value = 'session-mounted';
    expect(fixture.select).toHaveBeenLastCalledWith('session-mounted');

    view.unmount();
    fixture.select.mockClear();
    currentSessionIdSignal.value = 'session-after-unmount-2';

    expect(fixture.select).not.toHaveBeenCalled();
  });
});
