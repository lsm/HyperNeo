import { cleanup, fireEvent, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loginProvider, submitProviderCallback } from '../../lib/api-helpers.ts';
import { navigateToSettings } from '../../lib/router.ts';
import { NeoModelHoldLine } from '../NeoModelHoldLine.tsx';

vi.mock('../../lib/api-helpers.ts', () => ({
  loginProvider: vi.fn(),
  submitProviderCallback: vi.fn(),
}));
vi.mock('../../lib/router.ts', () => ({ navigateToSettings: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('NeoModelHoldLine', () => {
  it('starts Claude login and relays the phone callback without settings navigation or popups', async () => {
    vi.mocked(loginProvider).mockResolvedValue({
      success: true,
      authUrl: 'https://example.com/oauth',
    });
    vi.mocked(submitProviderCallback).mockResolvedValue({ success: true });
    const popup = vi.spyOn(window, 'open').mockReturnValue(null);
    const app = render(
      <NeoModelHoldLine hold={{ provider: 'anthropic', reason: 'login', since: 1 }} />
    );
    fireEvent.click(app.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(app.getByLabelText('Authorization code')).toBeTruthy());
    expect(loginProvider).toHaveBeenCalledWith('anthropic');
    expect(navigateToSettings).not.toHaveBeenCalled();
    expect(popup).not.toHaveBeenCalled();
    fireEvent.click(app.getByRole('button', { name: 'Open Auth URL' }));
    expect(popup).toHaveBeenCalledWith(
      'https://example.com/oauth',
      '_blank',
      'noopener,noreferrer'
    );
    fireEvent.input(app.getByLabelText('Authorization code'), {
      target: { value: 'callback-code' },
    });
    fireEvent.click(app.getByRole('button', { name: 'Submit' }));
    await waitFor(() =>
      expect(submitProviderCallback).toHaveBeenCalledWith('anthropic', 'callback-code')
    );
    await waitFor(() => expect(app.queryByLabelText('Authorization code')).toBeNull());
  });

  it('starts the held provider login without the Claude callback relay', async () => {
    vi.mocked(loginProvider).mockResolvedValue({
      success: true,
      authUrl: 'https://example.com/codex/oauth',
    });
    const app = render(
      <NeoModelHoldLine hold={{ provider: 'anthropic-codex', reason: 'login', since: 1 }} />
    );
    fireEvent.click(app.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(app.getByText('Authenticate with anthropic-codex')).toBeTruthy());
    expect(loginProvider).toHaveBeenCalledWith('anthropic-codex');
    expect(app.queryByLabelText('Authorization code')).toBeNull();
    expect(navigateToSettings).not.toHaveBeenCalled();
  });

  it('shows login failures and lets the human retry', async () => {
    vi.mocked(loginProvider).mockResolvedValue({ success: false, error: 'Login unavailable' });
    const app = render(
      <NeoModelHoldLine hold={{ provider: 'anthropic', reason: 'login', since: 1 }} />
    );
    fireEvent.click(app.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(app.getByRole('alert').textContent).toBe('Login unavailable'));
    expect(app.getByRole('button', { name: 'Sign in' }).hasAttribute('disabled')).toBe(false);
  });
});
