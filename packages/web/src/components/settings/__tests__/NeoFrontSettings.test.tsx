import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
const { save } = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('../../../lib/state.ts', () => ({ globalSettings: signal({ neo: {} }) }));
vi.mock('../../../lib/api-helpers.ts', () => ({ updateGlobalSettings: save }));
import { NeoFrontSettings } from '../NeoFrontSettings.tsx';
import { globalSettings } from '../../../lib/state.ts';
beforeEach(() => {
  (globalSettings as { value: unknown }).value = { neo: {} };
  save.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);
test('one default-off switch covers text and voice', async () => {
  render(<NeoFrontSettings />);
  const toggle = screen.getByRole('checkbox', {
    name: 'Fast replies for text and voice',
  }) as HTMLInputElement;
  expect(toggle.checked).toBe(false);
  fireEvent.click(toggle);
  await waitFor(() => expect(save).toHaveBeenCalledWith({ neo: { front: { enabled: true } } }));
});
