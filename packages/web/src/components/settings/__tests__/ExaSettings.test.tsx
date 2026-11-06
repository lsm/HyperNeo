import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { updateGlobalSettings } = vi.hoisted(() => ({ updateGlobalSettings: vi.fn() }));
vi.mock('../../../lib/api-helpers.ts', () => ({ updateGlobalSettings }));
vi.mock('../../../lib/state.ts', async () => {
  const { signal } = await import('@preact/signals');
  return { globalSettings: signal(null) };
});

import { globalSettings } from '../../../lib/state.ts';
import { ExaSettings } from '../ExaSettings.tsx';

const settings = globalSettings as unknown as { value: unknown };
beforeEach(() => {
  updateGlobalSettings.mockReset().mockResolvedValue(undefined);
  settings.value = { exa: { enabled: false, hasApiKey: true } };
});

afterEach(() => {
  cleanup();
  settings.value = null;
});

describe('ExaSettings', () => {
  it('writes nothing on opening', () => {
    render(<ExaSettings />);
    expect(screen.getByText('Key saved. Enter a new key to replace it.')).toBeTruthy();
    expect(updateGlobalSettings).not.toHaveBeenCalled();
  });

  it('saves the enabled switch without the key flags', async () => {
    render(<ExaSettings />);
    fireEvent.click(screen.getByRole('switch'));
    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenCalledWith(
        { exa: { enabled: true } },
        { timeout: 120_000 }
      )
    );
  });

  it('saves a new key when the field loses focus', async () => {
    render(<ExaSettings />);
    const field = screen.getByPlaceholderText('exa-...');
    fireEvent.input(field, { target: { value: ' synthetic ' } });
    fireEvent.blur(field);
    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenCalledWith(
        { exa: { enabled: false, apiKey: 'synthetic' } },
        { timeout: 120_000 }
      )
    );
  });

  it('removes the saved key', async () => {
    render(<ExaSettings />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove key' }));
    await waitFor(() =>
      expect(updateGlobalSettings).toHaveBeenCalledWith(
        { exa: { enabled: false, hasApiKey: false, apiKey: undefined } },
        { timeout: 120_000 }
      )
    );
  });
});
