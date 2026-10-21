import type { ComponentChildren } from 'preact';
import { signal } from '@preact/signals';
import { cleanup, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import MainContent from '../MainContent.tsx';
import {
  currentSessionIdSignal,
  currentSpaceCanonicalIdSignal,
  currentSpaceIdSignal,
  navSectionSignal,
} from '../../lib/signals.ts';

const request = vi.hoisted(() => vi.fn());
vi.mock('../../lib/connection-manager.ts', () => ({
  connectionManager: { getHub: async () => ({ request }) },
}));
vi.mock('../../lib/space-store', () => ({
  spaceStore: { spacesWithTasks: signal([]), initGlobalList: async () => {} },
}));
vi.mock('../ChatContainer.tsx', () => ({
  default: ({ headerExtra }: { headerExtra?: ComponentChildren }) => (
    <main>
      {headerExtra}
      <p>Session chat</p>
    </main>
  ),
}));
vi.mock('../SpaceIsland.tsx', () => ({ default: () => <main>Space chat</main> }));
vi.mock('../../components/space/SpaceCreateDialog', () => ({ SpaceCreateDialog: () => null }));
vi.mock('../BottomTabBar', () => ({ BottomTabBar: () => null }));
vi.mock('../../components/voice/VoiceRecordingIndicator', () => ({
  VoiceRecordingIndicator: () => null,
}));
vi.mock('../../components/ui/MobileMenuButton', () => ({ MobileMenuButton: () => null }));
vi.mock('../../hooks/useVoiceRecorder', () => ({
  VoiceSurfaceContext: { Provider: ({ children }: { children: ComponentChildren }) => children },
}));
beforeEach(() => {
  currentSessionIdSignal.value = 'worker';
  currentSpaceCanonicalIdSignal.value = null;
  currentSpaceIdSignal.value = null;
  navSectionSignal.value = 'chats';
  request.mockReset().mockResolvedValue({ ok: true, schedules: [] });
});
afterEach(cleanup);
describe('session page schedule placement', () => {
  it('owns the session strip and its scoped list read', async () => {
    render(<MainContent />);
    await screen.findByText('Session chat');
    expect(screen.getByText('Schedules')).toBeTruthy();
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('operation.invoke', {
        name: 'schedule.session.list',
        input: { target: { adapter: 'hyperneo', id: 'worker' } },
      })
    );
  });
  it('does not mount a strip or read schedules on a Space route', async () => {
    currentSpaceIdSignal.value = 'space';
    render(<MainContent />);
    await screen.findByText('Space chat');
    expect(screen.queryByText('Schedules')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
