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
import { NeoModelSettings } from '../NeoModelSettings.tsx';
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
    contextWindow: 1_000_000,
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
  render(<NeoModelSettings />);
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
  expect((ui.getByLabelText('Neo model 1 thinking') as HTMLSelectElement).value).toBe('think24k');
  fireEvent.change(ui.getByLabelText('Neo model 2 thinking'), { target: { value: 'off' } });
  fireEvent.click(ui.getAllByTitle('Move up')[2]);
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
  fireEvent.click(ui.getByRole('button', { name: 'Add Neo model' }));
  fireEvent.click(await screen.findByRole('button', { name: 'router/test' }));
  expect((ui.getByLabelText('Neo model 4 thinking') as HTMLSelectElement).value).toBe('off');
  for (let n = 0; n < 3; n++) fireEvent.click(ui.getAllByTitle('Remove')[1]);
  fireEvent.click(ui.getByRole('button', { name: 'Save Neo models' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, fallbacks: [] },
    })
  );
});

test('one list shows the primary first and Make primary moves another model to the top', async () => {
  const ui = await editor();
  expect(ui.queryByRole('button', { name: 'Change Neo primary' })).toBeNull();
  const rows = ui.getAllByTitle('Remove').map((button) => button.parentElement?.textContent ?? '');
  expect(rows.map((row) => row.includes('Primary'))).toEqual([true, false, false]);
  fireEvent.click(ui.getByRole('button', { name: 'Make Neo model 2 primary' }));
  fireEvent.click(ui.getByRole('button', { name: 'Save Neo models' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...glm, fallbacks: [primary, copilot] },
    })
  );
});

test('removing every model and adding one back saves an explicit empty fallback chain', async () => {
  const ui = await editor();
  for (let n = 0; n < 3; n++) fireEvent.click(ui.getAllByTitle('Remove')[0]);
  fireEvent.click(ui.getByRole('button', { name: 'Add Neo model' }));
  fireEvent.click(await screen.findByRole('button', { name: 'router/test' }));
  fireEvent.click(ui.getByRole('button', { name: 'Save Neo models' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { model: 'router/test', provider: 'openrouter', thinkingLevel: 'off', fallbacks: [] },
    })
  );
});

test('saves a percentage per model and shows each against its own context window', async () => {
  request.mockImplementation(async (method, data) => {
    if (method === 'models.list')
      return {
        models: models.map((model) =>
          model.id === 'glm-5'
            ? { ...model, contextWindow: 200_000 }
            : model.id === 'gpt-5'
              ? { ...model, contextWindow: 0 }
              : model
        ),
      };
    if (method === 'operation.invoke') return { ok: true, preferences: data.input };
    throw new Error(`Unexpected ${method}`);
  });
  const ui = await editor();
  fireEvent.input(ui.getByLabelText('Neo model 2 auto-compact percentage'), {
    target: { value: '88' },
  });
  expect(ui.getByText('88% ≈ 176K of 200K tokens')).toBeTruthy();
  expect(ui.getByText('90% · context window unknown')).toBeTruthy();
  fireEvent.click(ui.getByRole('button', { name: 'Save Neo models' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, fallbacks: [{ ...glm, autoCompactPercent: 88 }, copilot] },
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
  fireEvent.change(ui.getByLabelText('Neo model 1 thinking'), { target: { value: 'think8k' } });
  fireEvent.click(ui.getByRole('button', { name: 'Save Neo models' }));
  expect((await ui.findByRole('alert')).textContent).toContain('provider unavailable');
  expect((ui.getByLabelText('Neo model 1 thinking') as HTMLSelectElement).value).toBe('think8k');
});

test('preserves an inherited fallback chain when only primary thinking is edited', async () => {
  (globalSettings as { value: GlobalSettings | null }).value = {
    neo: { preferences: primary },
  } as GlobalSettings;
  const ui = await editor();
  expect(ui.getByText(/Uses the general session fallback chain/)).toBeTruthy();
  fireEvent.change(ui.getByLabelText('Neo model 1 thinking'), { target: { value: 'think8k' } });
  fireEvent.click(ui.getByRole('button', { name: 'Save Neo models' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, thinkingLevel: 'think8k' },
    })
  );
});

test('lists only runnable providers and offers every thinking level', async () => {
  auth.mockResolvedValue({
    providers: models.map((model) => ({
      id: model.provider,
      isAuthenticated: model.provider !== 'openrouter',
    })),
  });
  const ui = await editor();
  expect(ui.getByText(/Usable fallback providers:/).textContent).not.toContain('OpenRouter');
  expect(
    [...ui.getByLabelText('Neo model 3 thinking').querySelectorAll('option')].map(
      (option) => option.value
    )
  ).toEqual(['off', 'think8k', 'think16k', 'think24k', 'think32k', 'think48k', 'think64k']);
});

test('the first model added to an empty list becomes the primary', async () => {
  (globalSettings as { value: GlobalSettings | null }).value = { settingSources: [] };
  render(<NeoModelSettings />);
  const ui = within(await screen.findByRole('region', { name: 'Neo models' }));
  const change = ui.getByRole('button', { name: 'Add Neo model' });
  await waitFor(() => expect(change.hasAttribute('disabled')).toBe(false));
  fireEvent.click(change);
  fireEvent.click(await screen.findByRole('button', { name: 'opus', exact: true }));
  fireEvent.change(ui.getByLabelText('Neo model 1 thinking'), { target: { value: 'think24k' } });
  fireEvent.click(ui.getByRole('button', { name: 'Save Neo models' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: primary,
    })
  );
});

test('saves 70 percent with the model and previews the effective token threshold', async () => {
  const ui = await editor();
  fireEvent.input(ui.getByLabelText('Neo model 1 auto-compact percentage'), {
    target: { value: '70' },
  });
  expect(ui.getByText('70% ≈ 700K of 1M tokens')).toBeTruthy();
  fireEvent.click(ui.getByRole('button', { name: 'Save Neo models' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, fallbacks: [glm, copilot], autoCompactPercent: 70 },
    })
  );
});

test.each([
  [1, 10],
  [101, 100],
])('clamps percentage %s to %s on save', async (input, expected) => {
  const ui = await editor();
  fireEvent.input(ui.getByLabelText('Neo model 1 auto-compact percentage'), {
    target: { value: String(input) },
  });
  fireEvent.click(ui.getByRole('button', { name: 'Save Neo models' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, fallbacks: [glm, copilot], autoCompactPercent: expected },
    })
  );
});

test('90 resets an explicit override to the unchanged provider default', async () => {
  (globalSettings as { value: GlobalSettings | null }).value = {
    neo: { preferences: { ...primary, autoCompactPercent: 70 } },
  } as GlobalSettings;
  const ui = await editor();
  expect((ui.getByLabelText('Neo model 1 auto-compact percentage') as HTMLInputElement).value).toBe(
    '70'
  );
  fireEvent.input(ui.getByLabelText('Neo model 1 auto-compact percentage'), {
    target: { value: '90' },
  });
  expect(ui.getByText('90% ≈ 900K of 1M tokens')).toBeTruthy();
  fireEvent.click(ui.getByRole('button', { name: 'Save Neo models' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: primary,
    })
  );
});

test.each(['', '70.5'])(
  'rejects invalid percentage %s without sending a preference',
  async (value) => {
    const ui = await editor();
    fireEvent.input(ui.getByLabelText('Neo model 1 auto-compact percentage'), {
      target: { value },
    });
    fireEvent.click(ui.getByRole('button', { name: 'Save Neo models' }));
    expect((await ui.findByRole('alert')).textContent).toContain('whole number');
    expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
  }
);

test('an omitted override keeps model metadata and stays omitted when saving thinking', async () => {
  request.mockImplementation(async (method, data) => {
    if (method === 'models.list')
      return { models: models.map((model) => ({ ...model, autoCompactPercent: 80 })) };
    if (method === 'operation.invoke') return { ok: true, preferences: data.input };
    throw new Error(`Unexpected ${method}`);
  });
  const ui = await editor();
  expect((ui.getByLabelText('Neo model 1 auto-compact percentage') as HTMLInputElement).value).toBe(
    '90'
  );
  expect(ui.getAllByText('80% ≈ 800K of 1M tokens')).toHaveLength(3);
  fireEvent.change(ui.getByLabelText('Neo model 1 thinking'), { target: { value: 'off' } });
  fireEvent.click(ui.getByRole('button', { name: 'Save Neo models' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, thinkingLevel: 'off', fallbacks: [glm, copilot] },
    })
  );
});

test('a model saved under its alias shows the listed model name', async () => {
  const pinned = { ...models[0], id: 'claude-opus-5-5', alias: 'opus', display_name: 'Opus 5.5' };
  request.mockImplementation(async (method) => {
    if (method === 'models.list') return { models: [pinned, ...models.slice(1)] };
    throw new Error(`Unexpected ${method}`);
  });
  const ui = await editor();
  const first = ui.getAllByTitle('Remove')[0].closest('.bg-surface-raised')?.textContent ?? '';
  expect(first).toContain('Opus 5.5');
});
