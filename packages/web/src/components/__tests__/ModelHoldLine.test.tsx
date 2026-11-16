import { cleanup, fireEvent, render } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigateToSettings } from '../../lib/router.ts';
import { ModelHoldLine } from '../ModelHoldLine.tsx';

vi.mock('../../lib/router.ts', () => ({
  navigateToSettings: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ModelHoldLine', () => {
  it('asks to sign in again and opens the provider login', () => {
    const app = render(
      <ModelHoldLine hold={{ provider: 'anthropic', reason: 'login', since: 1 }} />
    );
    expect(app.container.textContent).toBe('Claude needs you to sign in again · Sign in');
    fireEvent.click(app.getByRole('button', { name: 'Sign in' }));
    expect(navigateToSettings).toHaveBeenCalledWith('providers');
  });

  it('shows a retrying hold as one line without a sign-in button', () => {
    const app = render(
      <ModelHoldLine hold={{ provider: 'anthropic', reason: 'overloaded', since: 1 }} />
    );
    expect(app.container.textContent).toBe('Claude is overloaded · retrying');
    expect(app.queryByRole('button')).toBeNull();
  });
});
