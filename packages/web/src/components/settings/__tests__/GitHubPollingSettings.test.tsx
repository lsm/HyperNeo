import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { updateGlobalSettings, toastError } = vi.hoisted(() => ({
  updateGlobalSettings: vi.fn(),
  toastError: vi.fn(),
}));
vi.mock('../../../lib/api-helpers.ts', () => ({ updateGlobalSettings }));
vi.mock('../../../lib/toast.ts', () => ({ toast: { error: toastError } }));
vi.mock('../../../lib/state.ts', async () => {
  const { signal } = await import('@preact/signals');
  return { globalSettings: signal(null) };
});

import { globalSettings } from '../../../lib/state.ts';
import { GitHubPollingSettings } from '../GitHubPollingSettings.tsx';

const settings = globalSettings as unknown as { value: unknown };
const field = () => screen.getByRole('spinbutton') as HTMLInputElement;
function enter(value: string) {
  fireEvent.input(field(), { target: { value } });
  fireEvent.blur(field());
}

beforeEach(() => {
  updateGlobalSettings.mockReset().mockResolvedValue(undefined);
  toastError.mockReset();
  settings.value = { githubPollingInterval: 300 };
});

afterEach(() => {
  cleanup();
  settings.value = null;
});

describe('GitHubPollingSettings', () => {
  it('shows the saved interval and writes nothing on opening', () => {
    render(<GitHubPollingSettings />);
    expect(screen.getByText('GitHub polling interval (seconds)')).toBeTruthy();
    expect(field().value).toBe('300');
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });

  it('shows 120 when no interval is saved', () => {
    settings.value = {};
    render(<GitHubPollingSettings />);
    expect(field().value).toBe('120');
  });

  it.each([
    ['0', 0],
    ['60', 60],
  ])('saves %s', async (value, githubPollingInterval) => {
    render(<GitHubPollingSettings />);
    enter(value);
    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenCalledWith({ githubPollingInterval })
    );
  });

  it('says 0 stops polling', () => {
    render(<GitHubPollingSettings />);
    expect(screen.getByText(/0 disables polling/)).toBeTruthy();
  });

  it('leaves an unchanged value unsaved', () => {
    render(<GitHubPollingSettings />);
    enter('300');
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });

  it.each(['-1', '1.5', '999999999'])('refuses %s and restores the saved value', (value) => {
    render(<GitHubPollingSettings />);
    enter(value);
    expect(toastError).toHaveBeenCalled();
    expect(updateGlobalSettings).not.toHaveBeenCalled();
    expect(field().value).toBe('300');
  });

  it('restores the saved value when saving fails', async () => {
    updateGlobalSettings.mockRejectedValue(new Error('offline'));
    render(<GitHubPollingSettings />);
    enter('60');
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    await waitFor(() => expect(field().value).toBe('300'));
  });
});
