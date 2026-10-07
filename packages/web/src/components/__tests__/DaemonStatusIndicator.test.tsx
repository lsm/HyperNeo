import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/connection-manager.ts', () => ({ connectionManager: { reconnect: vi.fn() } }));

import { connectionState } from '../../lib/state.ts';
import { DaemonStatusIndicator } from '../DaemonStatusIndicator.tsx';

describe('DaemonStatusIndicator', () => {
  afterEach(() => {
    cleanup();
    connectionState.value = 'connected';
  });

  it('shows nothing while connected', () => {
    connectionState.value = 'connected';
    const { container } = render(<DaemonStatusIndicator />);
    expect(container.innerHTML).toBe('');
  });

  it('offers a reconnect when offline', () => {
    connectionState.value = 'disconnected';
    const { getByRole } = render(<DaemonStatusIndicator showLabel />);
    expect(getByRole('button', { name: 'Connection offline' }).hasAttribute('disabled')).toBe(
      false
    );
  });
});
