import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { GlobalSettings } from '@hyperneo/shared';

const { request, auth } = vi.hoisted(() => ({ request: vi.fn(), auth: vi.fn() }));
vi.mock('../../../lib/state.ts', () => ({
  globalSettings: signal(null),
  connectionState: signal('connected'),
}));
vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: { getHubIfConnected: () => ({ request }) },
}));
vi.mock('../../../lib/api-helpers.ts', () => ({
  listProviderAuthStatus: () => auth(),
  updateGlobalSettings: vi.fn(),
}));
import { ModelsSettings } from '../ModelsSettings.tsx';
import { globalSettings } from '../../../lib/state.ts';

const primary = { model: 'opus', provider: 'anthropic', thinkingLevel: 'think24k' };
const glm = { model: 'glm-5', provider: 'glm', thinkingLevel: 'think8k' };
const copilot = { model: 'gpt-5', provider: 'anthropic-copilot', thinkingLevel: 'off' };
const models = [primary, glm, copilot, { model: 'router/test', provider: 'openrouter' }].map(
  (m) => ({
    id: m.model,
    provider: m.provider,
    display_name: m.model,
    description: '',
    available: true,
    thinkingLevels:
      m.provider === 'anthropic-copilot' ? ['off', 'think32k'] : ['off', 'think8k', 'think24k'],
  })
);

beforeEach(() => {
  (globalSettings as { value: GlobalSettings | null }).value = {
    neo: { preferences: { ...primary, fallbacks: [glm, copilot] } },
  } as GlobalSettings;
  auth.mockResolvedValue({
    providers: [...new Set(models.map((m) => m.provider))].map((id) => ({
      id,
      isAuthenticated: true,
    })),
  });
  request.mockReset().mockImplementation(async (method, data) => {
    if (method === 'models.list') return { models };
    if (method === 'operation.invoke') return { ok: true, preferences: data.input };
    throw new Error(`Unexpected ${method}`);
  });
});
afterEach(cleanup);

async function editor() {
  render(<ModelsSettings />);
  const section = await screen.findByRole('region', { name: 'Neo models' });
  await waitFor(() =>
    expect(
      within(section).getByRole('button', { name: 'Save Neo models' }).hasAttribute('disabled')
    ).toBe(false)
  );
  return within(section);
}

test('edits each effort, reorders provider fallbacks and saves through the human operation', async () => {
  const ui = await editor();
  expect((ui.getByLabelText('Neo primary thinking') as HTMLSelectElement).value).toBe('think24k');
  fireEvent.change(ui.getByLabelText('Neo fallback 1 thinking'), { target: { value: 'off' } });
  fireEvent.click(ui.getAllByTitle('Move up')[1]);
  fireEvent.click(ui.getByRole('button', { name: 'Save Neo models' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, fallbacks: [copilot, { ...glm, thinkingLevel: 'off' }] },
    })
  );
  expect(ui.getByText(/Usable fallback providers:/).textContent).toContain('OpenRouter');
  expect(ui.getByText(/Usable fallback providers:/).textContent).toContain('Z.ai');
});

test('adds a different-provider model with supported thinking and can remove all fallbacks', async () => {
  const ui = await editor();
  fireEvent.click(ui.getByRole('button', { name: 'Add Neo fallback' }));
  fireEvent.click(await screen.findByRole('button', { name: 'router/test' }));
  expect((ui.getByLabelText('Neo fallback 3 thinking') as HTMLSelectElement).value).toBe('off');
  for (let n = 0; n < 3; n++) fireEvent.click(ui.getAllByTitle('Remove')[0]);
  fireEvent.click(ui.getByRole('button', { name: 'Save Neo models' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, fallbacks: [] },
    })
  );
});

test('shows a refused save without discarding edits or changing the general session chain', async () => {
  const ui = await editor();
  request.mockImplementation(async (method) =>
    method === 'models.list'
      ? { models }
      : { ok: false, reason: 'invalid_model: provider unavailable' }
  );
  fireEvent.change(ui.getByLabelText('Neo primary thinking'), { target: { value: 'think8k' } });
  fireEvent.click(ui.getByRole('button', { name: 'Save Neo models' }));
  expect((await ui.findByRole('alert')).textContent).toContain('provider unavailable');
  expect((ui.getByLabelText('Neo primary thinking') as HTMLSelectElement).value).toBe('think8k');
});

test('preserves an inherited fallback chain when only primary thinking is edited', async () => {
  (globalSettings as { value: GlobalSettings | null }).value = {
    neo: { preferences: primary },
  } as GlobalSettings;
  const ui = await editor();
  expect(ui.getByText(/Uses the general session fallback chain/)).toBeTruthy();
  fireEvent.change(ui.getByLabelText('Neo primary thinking'), { target: { value: 'think8k' } });
  fireEvent.click(ui.getByRole('button', { name: 'Save Neo models' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, thinkingLevel: 'think8k' },
    })
  );
});

test('lists only runnable providers and limits thinking to the server catalog', async () => {
  auth.mockResolvedValue({
    providers: models.map((model) => ({
      id: model.provider,
      isAuthenticated: model.provider !== 'openrouter',
    })),
  });
  const ui = await editor();
  expect(ui.getByText(/Usable fallback providers:/).textContent).not.toContain('OpenRouter');
  expect(
    [...ui.getByLabelText('Neo fallback 2 thinking').querySelectorAll('option')].map(
      (option) => option.value
    )
  ).toEqual(['off', 'think32k']);
});

test('selects a primary when Neo preferences have never been saved', async () => {
  (globalSettings as { value: GlobalSettings | null }).value = { settingSources: [] };
  render(<ModelsSettings />);
  const ui = within(await screen.findByRole('region', { name: 'Neo models' }));
  const change = ui.getByRole('button', { name: 'Change Neo primary' });
  await waitFor(() => expect(change.hasAttribute('disabled')).toBe(false));
  fireEvent.click(change);
  fireEvent.click(await screen.findByRole('button', { name: 'opus', exact: true }));
  fireEvent.change(ui.getByLabelText('Neo primary thinking'), { target: { value: 'think24k' } });
  fireEvent.click(ui.getByRole('button', { name: 'Save Neo models' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: primary,
    })
  );
});
