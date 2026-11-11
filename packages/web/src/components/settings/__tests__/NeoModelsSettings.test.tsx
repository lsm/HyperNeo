import { signal } from '@preact/signals';
import { MODEL_LIST_REQUEST_TIMEOUT_MS } from '@hyperneo/shared/provider';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
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
vi.mock('../NeoRelaySendersSettings.tsx', () => ({ NeoRelaySendersSettings: () => null }));
import { NeoModelSettings } from '../NeoModelSettings.tsx';
import { connectionState, globalSettings } from '../../../lib/state.ts';

const primary = { model: 'opus', provider: 'anthropic', thinkingLevel: 'think24k' as const };
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
  connectionState.value = 'connected';
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
      within(section).getByRole('button', { name: 'Change Neo primary' }).hasAttribute('disabled')
    ).toBe(false)
  );
  return within(section);
}

test('edits each effort, reorders provider fallbacks and saves through the human operation', async () => {
  const ui = await editor();
  expect((ui.getByLabelText('Neo model 1 thinking') as HTMLSelectElement).value).toBe('think24k');
  fireEvent.change(ui.getByLabelText('Neo model 2 thinking'), { target: { value: 'off' } });
  await waitFor(() =>
    expect(ui.getByLabelText('Neo model 1 thinking').hasAttribute('disabled')).toBe(false)
  );
  fireEvent.click(ui.getAllByTitle('Move up')[1]);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, fallbacks: [copilot, { ...glm, thinkingLevel: 'off' }] },
    })
  );
  expect(ui.getByRole('button', { name: 'Add Neo model' })).toBeTruthy();
});

test('adds a different-provider model with supported thinking and can remove all fallbacks', async () => {
  const ui = await editor();
  fireEvent.click(ui.getByRole('button', { name: 'Add Neo model' }));
  fireEvent.click(await screen.findByRole('button', { name: 'router/test' }));
  expect((ui.getByLabelText('Neo model 4 thinking') as HTMLSelectElement).value).toBe('off');
  for (let n = 0; n < 3; n++) {
    await waitFor(() =>
      expect(ui.getByLabelText('Neo model 1 thinking').hasAttribute('disabled')).toBe(false)
    );
    fireEvent.click(ui.getAllByTitle('Remove')[0]);
  }
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, fallbacks: [] },
    })
  );
});

test('one list shows the primary first and Make primary moves another model to the top', async () => {
  const ui = await editor();
  expect(ui.getByRole('button', { name: 'Change Neo primary' })).toBeTruthy();
  const rows = ui.getAllByTitle('Remove').map((button) => button.parentElement?.textContent ?? '');
  expect(rows).toHaveLength(2);
  expect(ui.getByRole('button', { name: 'Make Neo model 2 primary' })).toBeTruthy();
  fireEvent.click(ui.getByRole('button', { name: 'Make Neo model 2 primary' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...glm, fallbacks: [primary, copilot] },
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
  expect(ui.getByTitle('88% ≈ 176K of 200K tokens')).toBeTruthy();
  expect(ui.getByTitle('90% · context window unknown')).toBeTruthy();
  fireEvent.focusOut(ui.getByLabelText('Neo model 2 auto-compact percentage'));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, fallbacks: [{ ...glm, autoCompactPercent: 88 }, copilot] },
    })
  );
});

test('rolls back a refused save and reports the error', async () => {
  const ui = await editor();
  request.mockImplementation(async (method) =>
    method === 'models.list'
      ? { models }
      : { ok: false, reason: 'invalid_model: provider unavailable' }
  );
  fireEvent.change(ui.getByLabelText('Neo model 1 thinking'), { target: { value: 'think8k' } });
  expect((await ui.findByRole('alert')).textContent).toContain('provider unavailable');
  expect((ui.getByLabelText('Neo model 1 thinking') as HTMLSelectElement).value).toBe('think24k');
});

test('preserves an inherited fallback chain when only primary thinking is edited', async () => {
  (globalSettings as { value: GlobalSettings | null }).value = {
    neo: { preferences: primary },
  } as GlobalSettings;
  const ui = await editor();
  expect(ui.queryByLabelText('Neo model 2 thinking')).toBeNull();
  fireEvent.change(ui.getByLabelText('Neo model 1 thinking'), { target: { value: 'think8k' } });
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, thinkingLevel: 'think8k' },
    })
  );
});

test('lists only runnable providers and offers each model its thinking levels', async () => {
  auth.mockResolvedValue({
    providers: models.map((model) => ({
      id: model.provider,
      isAuthenticated: model.provider !== 'openrouter',
    })),
  });
  const ui = await editor();
  fireEvent.click(ui.getByRole('button', { name: 'Add Neo model' }));
  expect(screen.queryByRole('button', { name: 'router/test' })).toBeNull();
  fireEvent.click(
    screen.getByText('Add Neo model', { selector: 'h3' }).parentElement!.querySelector('button')!
  );
  const values = (index: number) =>
    [...ui.getByLabelText(`Neo model ${index} thinking`).querySelectorAll('option')].map(
      (option) => option.value
    );
  expect(values(1)).toEqual([
    'off',
    'think8k',
    'think16k',
    'think24k',
    'think32k',
    'think48k',
    'think64k',
  ]);
  expect(values(3)).toEqual(['off']);
});

test('the first model added to an empty list becomes the primary', async () => {
  (globalSettings as { value: GlobalSettings | null }).value = { settingSources: [] };
  render(<NeoModelSettings />);
  const ui = within(await screen.findByRole('region', { name: 'Neo models' }));
  const change = ui.getByRole('button', { name: 'Add Neo model' });
  await waitFor(() => expect(change.hasAttribute('disabled')).toBe(false));
  fireEvent.click(change);
  fireEvent.click(await screen.findByRole('button', { name: 'opus', exact: true }));
  await waitFor(() =>
    expect(ui.getByLabelText('Neo model 1 thinking').hasAttribute('disabled')).toBe(false)
  );
  fireEvent.change(ui.getByLabelText('Neo model 1 thinking'), { target: { value: 'think24k' } });
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
  expect(ui.getByTitle('70% ≈ 700K of 1M tokens')).toBeTruthy();
  fireEvent.focusOut(ui.getByLabelText('Neo model 1 auto-compact percentage'));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, fallbacks: [glm, copilot], autoCompactPercent: 70 },
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
  expect(ui.getByTitle('90% ≈ 900K of 1M tokens')).toBeTruthy();
  fireEvent.focusOut(ui.getByLabelText('Neo model 1 auto-compact percentage'));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: primary,
    })
  );
});

test.each(['', '70.5', '1', '101'])(
  'rejects invalid percentage %s without sending a preference',
  async (value) => {
    const ui = await editor();
    fireEvent.input(ui.getByLabelText('Neo model 1 auto-compact percentage'), {
      target: { value },
    });
    fireEvent.focusOut(ui.getByLabelText('Neo model 1 auto-compact percentage'));
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
  expect(ui.getAllByTitle('80% ≈ 800K of 1M tokens')).toHaveLength(3);
  fireEvent.change(ui.getByLabelText('Neo model 1 thinking'), { target: { value: 'off' } });
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
  const first =
    ui.getByRole('button', { name: 'Change Neo primary' }).closest('[data-model-row]')
      ?.textContent ?? '';
  expect(first).toContain('Opus 5.5');
});

test('an unsaved Neo preference shows that it follows the current default', async () => {
  (globalSettings as { value: GlobalSettings | null }).value = {
    model: 'opus',
    modelProvider: 'anthropic',
    neo: {},
  } as GlobalSettings;
  render(<NeoModelSettings />);
  expect(await screen.findByText('Follows default (current: opus)')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Clear saved fallbacks' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Disable Neo fallbacks' })).toBeNull();
});

test('refresh reloads the model list and never saves a Neo default', async () => {
  const { updateGlobalSettings } = await import('../../../lib/api-helpers.ts');
  const ui = await editor();
  request.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      'models.list',
      expect.objectContaining({ forceRefresh: true }),
      { timeout: MODEL_LIST_REQUEST_TIMEOUT_MS }
    )
  );
  expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
  expect(updateGlobalSettings).not.toHaveBeenCalled();
  expect(ui.getByRole('button', { name: 'Change Neo primary' })).toBeTruthy();
});

test('offers only what each model supports and keeps an unsupported saved level', async () => {
  (globalSettings as { value: GlobalSettings | null }).value = {
    neo: {
      preferences: {
        ...primary,
        thinkingLevel: 'think32k',
        fallbacks: [{ ...glm, thinkingLevel: 'think24k' }],
      },
    },
  } as GlobalSettings;
  request.mockImplementation(async (method, data) => {
    if (method === 'models.list')
      return {
        models: [
          { ...models[0], effortLevels: ['low', 'high'] },
          { ...models[1], thinkingModes: 'off' },
        ],
      };
    if (method === 'operation.invoke') return { ok: true, preferences: data.input };
    throw new Error(`Unexpected ${method}`);
  });
  const ui = await editor();
  const values = (index: number) =>
    [...ui.getByLabelText(`Neo model ${index} thinking`).querySelectorAll('option')].map(
      (option) => option.value
    );

  await waitFor(() => expect(values(1)).toEqual(['off', 'think8k', 'think24k', 'think32k']));
  expect(values(2)).toEqual(['off', 'think24k']);
  expect((ui.getByLabelText('Neo model 1 thinking') as HTMLSelectElement).value).toBe('think32k');
  expect((ui.getByLabelText('Neo model 2 thinking') as HTMLSelectElement).value).toBe('think24k');
  expect(ui.getAllByText(/not supported by this model/).length).toBe(2);
  expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());

  fireEvent.input(ui.getByLabelText('Neo model 1 auto-compact percentage'), {
    target: { value: '70' },
  });
  fireEvent.focusOut(ui.getByLabelText('Neo model 1 auto-compact percentage'));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith(
      'operation.invoke',
      expect.objectContaining({
        input: expect.objectContaining({
          thinkingLevel: 'think32k',
          fallbacks: [expect.objectContaining({ thinkingLevel: 'think24k' })],
        }),
      })
    )
  );
});

test('says nothing about support while the catalog is loading', async () => {
  request.mockImplementation(() => new Promise(() => {}));
  render(<NeoModelSettings />);

  const section = await screen.findByRole('region', { name: 'Neo models' });
  expect(section.textContent).not.toContain('not supported by this model');
  expect(section.textContent).not.toContain('support for this model is unknown');
});

test('primary and fallback controls are visible without writing', async () => {
  const ui = await editor();
  expect(ui.queryByText('Advanced')).toBeNull();
  expect(ui.getByLabelText('Neo model 1 thinking').closest('details')).toBeNull();
  expect(ui.getByLabelText('Neo model 1 auto-compact percentage').closest('details')).toBeNull();
  expect(ui.getByLabelText('Neo model 2 thinking').closest('details')).toBeNull();
  expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
});

test('automatically saves primary thinking without a disclosure and preserves inherited fallbacks', async () => {
  (globalSettings as { value: GlobalSettings | null }).value = {
    neo: { preferences: primary },
  } as GlobalSettings;
  render(<NeoModelSettings />);
  const ui = within(await screen.findByRole('region', { name: 'Neo models' }));
  await waitFor(() =>
    expect(ui.getByLabelText('Neo model 1 thinking').hasAttribute('disabled')).toBe(false)
  );
  expect(ui.queryByRole('button', { name: 'Save Neo models' })).toBeNull();
  expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
  fireEvent.change(ui.getByLabelText('Neo model 1 thinking'), { target: { value: 'think8k' } });
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, thinkingLevel: 'think8k' },
    })
  );
});

test('automatically saves the compact percentage on blur and rejects out-of-range values', async () => {
  const ui = await editor();
  const input = ui.getByLabelText('Neo model 1 auto-compact percentage');
  fireEvent.input(input, { target: { value: '70' } });
  expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
  fireEvent.focusOut(input);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, autoCompactPercent: 70, fallbacks: [glm, copilot] },
    })
  );
  request.mockClear();
  fireEvent.input(input, { target: { value: '101' } });
  fireEvent.focusOut(input);
  expect((await ui.findByRole('alert')).textContent).toContain('10 to 100');
  expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
});

test('the primary is not duplicated as a removable fallback', async () => {
  (globalSettings as { value: GlobalSettings | null }).value = {
    settingSources: [],
    neo: { preferences: { ...primary, fallbacks: [] } },
  } as GlobalSettings;
  const ui = await editor();
  expect(ui.queryByTitle('Remove')).toBeNull();
  expect(ui.getByRole('button', { name: 'Change Neo primary' })).toBeTruthy();
  expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
});

test('chooses the first model and changes primary and thinking without a disclosure', async () => {
  (globalSettings as { value: GlobalSettings | null }).value = { settingSources: [] };
  render(<NeoModelSettings />);
  const ui = within(await screen.findByRole('region', { name: 'Neo models' }));
  expect(ui.queryByText('Advanced')).toBeNull();
  const choose = ui.getByRole('button', { name: 'Choose Neo model' });
  await waitFor(() => expect(choose.hasAttribute('disabled')).toBe(false));
  expect(choose.closest('details')).toBeNull();
  fireEvent.click(choose);
  fireEvent.click(await screen.findByRole('button', { name: 'opus', exact: true }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, thinkingLevel: 'off' },
    })
  );
  await waitFor(() =>
    expect(ui.getByRole('button', { name: 'Change Neo primary' }).hasAttribute('disabled')).toBe(
      false
    )
  );
  fireEvent.click(ui.getByRole('button', { name: 'Change Neo primary' }));
  fireEvent.click(await screen.findByRole('button', { name: 'router/test' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(ui.getByLabelText('Neo model 1 thinking').hasAttribute('disabled')).toBe(false)
  );
  fireEvent.change(ui.getByLabelText('Neo model 1 thinking'), { target: { value: 'think8k' } });
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { model: 'router/test', provider: 'openrouter', thinkingLevel: 'think8k' },
    })
  );
  expect(ui.queryByText('Advanced')).toBeNull();
});

test('disables controls during an outstanding save and rolls back a rejected change', async () => {
  const ui = await editor();
  let finish!: (result: { ok: false; reason: string }) => void;
  request.mockImplementation((method) =>
    method === 'operation.invoke'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({ models })
  );
  fireEvent.change(ui.getByLabelText('Neo model 1 thinking'), { target: { value: 'think8k' } });
  expect(ui.getByRole('button', { name: 'Change Neo primary' }).hasAttribute('disabled')).toBe(
    true
  );
  expect(ui.getByLabelText('Neo model 2 thinking').hasAttribute('disabled')).toBe(true);
  finish({ ok: false, reason: 'unavailable' });
  expect((await ui.findByRole('alert')).textContent).toContain('unavailable');
  expect((ui.getByLabelText('Neo model 1 thinking') as HTMLSelectElement).value).toBe('think24k');
  expect(ui.getByRole('button', { name: 'Change Neo primary' }).hasAttribute('disabled')).toBe(
    false
  );
});

test('clearing fallbacks saves immediately and leaves primary untouched', async () => {
  const ui = await editor();
  fireEvent.click(ui.getByRole('button', { name: 'Clear saved fallbacks' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, fallbacks: [] },
    })
  );
});

test.each(['picker', 'make primary', 'move up'])(
  'confirms %s before changing the primary and leaves no change on cancel',
  async (action) => {
    const ui = await editor();
    if (action === 'picker') {
      fireEvent.click(ui.getByRole('button', { name: 'Change Neo primary' }));
      fireEvent.click(await screen.findByRole('button', { name: 'router/test' }));
    } else if (action === 'make primary') {
      fireEvent.click(ui.getByRole('button', { name: 'Make Neo model 2 primary' }));
    } else if (action === 'move up') {
      fireEvent.click(ui.getAllByTitle('Move up')[0]);
    } else {
      fireEvent.click(ui.getAllByTitle('Remove')[0]);
    }
    expect(
      await screen.findByText(`Switch Neo to ${action === 'picker' ? 'router/test' : 'glm-5'}?`)
    ).toBeTruthy();
    expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
    expect(
      ui.getByRole('button', { name: 'Change Neo primary' }).parentElement?.textContent
    ).toContain('opus');
  }
);

test('saves a primary switch only after confirmation', async () => {
  const ui = await editor();
  fireEvent.click(ui.getByRole('button', { name: 'Make Neo model 2 primary' }));
  expect(await screen.findByText('Switch Neo to glm-5?')).toBeTruthy();
  expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...glm, fallbacks: [primary, copilot] },
    })
  );
});

test('keeps a pending confirmation when the connection drops and saves after reconnection', async () => {
  const ui = await editor();
  fireEvent.click(ui.getByRole('button', { name: 'Make Neo model 2 primary' }));
  expect(await screen.findByText('Switch Neo to glm-5?')).toBeTruthy();
  act(() => {
    connectionState.value = 'disconnected';
  });
  const confirm = screen.getByRole('button', { name: 'Processing...' }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(true);
  fireEvent.click(confirm);
  expect(screen.getByText('Switch Neo to glm-5?')).toBeTruthy();
  expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
  act(() => {
    connectionState.value = 'connected';
  });
  fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...glm, fallbacks: [primary, copilot] },
    })
  );
});

test('changing primary via picker does not transfer the previous model compaction override', async () => {
  (globalSettings as { value: GlobalSettings | null }).value = {
    neo: { preferences: { ...primary, autoCompactPercent: 70, fallbacks: [glm, copilot] } },
  } as GlobalSettings;
  const ui = await editor();
  fireEvent.click(ui.getByRole('button', { name: 'Change Neo primary' }));
  fireEvent.click(await screen.findByRole('button', { name: 'router/test' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: {
        ...primary,
        model: 'router/test',
        provider: 'openrouter',
        fallbacks: [glm, copilot],
      },
    })
  );
  expect((ui.getByLabelText('Neo model 1 auto-compact percentage') as HTMLInputElement).value).toBe(
    '90'
  );
});

test.each(['Change Neo primary', 'Add Neo model'])(
  'keeps %s picker open and prevents selection while disconnected',
  async (action) => {
    const ui = await editor();
    fireEvent.click(ui.getByRole('button', { name: action }));
    const model = await screen.findByRole('button', { name: 'router/test' });
    act(() => {
      connectionState.value = 'disconnected';
    });
    expect((model as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(model);
    expect(screen.getByRole('button', { name: 'router/test' })).toBeTruthy();
    expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
    act(() => {
      connectionState.value = 'connected';
    });
    expect((model as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(model);
    if (action === 'Change Neo primary') {
      expect(await screen.findByText('Switch Neo to router/test?')).toBeTruthy();
    } else {
      await waitFor(() =>
        expect(request).toHaveBeenCalledWith('operation.invoke', {
          name: 'neo.preferences.set',
          input: {
            ...primary,
            fallbacks: [
              glm,
              copilot,
              { model: 'router/test', provider: 'openrouter', thinkingLevel: 'off' },
            ],
          },
        })
      );
    }
  }
);

test('a busy confirmation ignores Escape and backdrop until reconnected', async () => {
  const ui = await editor();
  fireEvent.click(ui.getByRole('button', { name: 'Make Neo model 2 primary' }));
  const dialog = await screen.findByRole('dialog', { name: 'Confirm Neo model' });
  act(() => {
    connectionState.value = 'disconnected';
  });
  fireEvent.keyDown(document, { key: 'Escape' });
  fireEvent.click(dialog.parentElement!.querySelector('.absolute')!);
  expect(screen.getByRole('dialog', { name: 'Confirm Neo model' })).toBeTruthy();
  expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
  act(() => {
    connectionState.value = 'connected';
  });
  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Confirm Neo model' })).toBeNull()
  );
});

test('explains that actions must be retried while a percent save is pending', async () => {
  const ui = await editor();
  let finish!: (result: { ok: true; preferences: unknown }) => void;
  request.mockImplementation((method) =>
    method === 'operation.invoke'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({ models })
  );
  const input = ui.getByLabelText('Neo model 1 auto-compact percentage');
  fireEvent.input(input, { target: { value: '70' } });
  fireEvent.focusOut(input);
  expect(ui.getByText(/wait.*retry/i)).toBeTruthy();
  const clear = ui.getByRole('button', { name: 'Clear saved fallbacks' }) as HTMLButtonElement;
  expect(clear.disabled).toBe(true);
  fireEvent.click(clear);
  expect(request.mock.calls.filter(([method]) => method === 'operation.invoke')).toHaveLength(1);
  finish({
    ok: true,
    preferences: { ...primary, autoCompactPercent: 70, fallbacks: [glm, copilot] },
  });
  await waitFor(() => expect(ui.queryByText(/wait.*retry/i)).toBeNull());
  fireEvent.click(clear);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, autoCompactPercent: 70, fallbacks: [] },
    })
  );
  finish({ ok: true, preferences: { ...primary, autoCompactPercent: 70, fallbacks: [] } });
});

test('a failed save retains a newer pushed preference instead of restoring stale data', async () => {
  const ui = await editor();
  let finish!: (result: { ok: false; reason: string }) => void;
  request.mockImplementation((method) =>
    method === 'operation.invoke'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve({ models })
  );
  fireEvent.change(ui.getByLabelText('Neo model 1 thinking'), { target: { value: 'think8k' } });
  act(() => {
    (globalSettings as { value: GlobalSettings | null }).value = {
      neo: {
        preferences: {
          ...primary,
          thinkingLevel: 'off',
          autoCompactPercent: 80,
          fallbacks: [glm, copilot],
        },
      },
    } as GlobalSettings;
  });
  await waitFor(() =>
    expect((ui.getByLabelText('Neo model 1 thinking') as HTMLSelectElement).value).toBe('off')
  );
  finish({ ok: false, reason: 'offline' });
  expect((await ui.findByRole('alert')).textContent).toContain('offline');
  expect((ui.getByLabelText('Neo model 1 thinking') as HTMLSelectElement).value).toBe('off');
  expect((ui.getByLabelText('Neo model 1 auto-compact percentage') as HTMLInputElement).value).toBe(
    '80'
  );
});

async function frontEditor() {
  const settings = globalSettings.value as GlobalSettings;
  if (!settings.neo?.front?.model)
    (globalSettings as { value: GlobalSettings }).value = {
      ...settings,
      neo: { ...settings.neo, front: { enabled: false, model: primary } },
    };
  render(<NeoModelSettings />);
  const section = await screen.findByRole('region', { name: 'Neo models' });
  const ui = within(section);
  await waitFor(() =>
    expect(ui.getByRole('button', { name: 'Change Neo primary' }).hasAttribute('disabled')).toBe(
      false
    )
  );
  return ui;
}

test('chooses a separate provider/model through the targeted front operation', async () => {
  await frontEditor();
  const convo = within(screen.getByRole('region', { name: 'Front' }));
  fireEvent.click(convo.getByRole('button', { name: 'Choose Front model' }));
  fireEvent.click(await screen.findByRole('button', { name: 'glm-5' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.front.model.set',
      input: { ...glm, thinkingLevel: 'think24k' },
    })
  );
  expect(globalSettings.value?.neo?.preferences?.model).toBe('opus');
  expect(globalSettings.value?.neo?.front?.enabled).toBe(false);
});

test.each(['refused', 'failed'])(
  'a %s front model save retains the saved selection',
  async (mode) => {
    request.mockImplementation(async (method) => {
      if (method === 'models.list') return { models };
      if (mode === 'failed') throw new Error('Disconnected');
      return { ok: false, reason: 'Unavailable model' };
    });
    await frontEditor();
    const convo = within(screen.getByRole('region', { name: 'Front' }));
    fireEvent.click(convo.getByRole('button', { name: 'Choose Front model' }));
    fireEvent.click(await screen.findByRole('button', { name: 'glm-5' }));
    expect((await convo.findByRole('alert')).textContent).toBeTruthy();
    expect(convo.getByText('opus')).toBeTruthy();
    expect(globalSettings.value?.neo?.front?.enabled).toBe(false);
  }
);

test('the Front compact percentage saves through the targeted front operation', async () => {
  await frontEditor();
  const convo = within(screen.getByRole('region', { name: 'Front' }));
  const input = convo.getByLabelText('Front model auto-compact percentage') as HTMLInputElement;
  expect(input.value).toBe('90');
  fireEvent.input(input, { target: { value: '65' } });
  fireEvent.focusOut(input);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.front.model.set',
      input: { ...primary, thinkingLevel: 'think24k', autoCompactPercent: 65 },
    })
  );
});

test('primary model groups visibly labeled thinking and compaction controls', async () => {
  const ui = await editor();
  const button = ui.getByRole('button', { name: 'Change Neo primary' });
  const row = button.closest('[data-model-row]');
  expect(row).toBeTruthy();
  expect(row?.contains(ui.getByLabelText('Neo model 1 thinking'))).toBe(true);
  expect(row?.contains(ui.getByLabelText('Neo model 1 auto-compact percentage'))).toBe(true);
  expect(ui.queryByText('Advanced')).toBeNull();
  expect(ui.getAllByText('Thinking').length).toBeGreaterThan(0);
  expect(ui.getAllByText('Auto-compact').length).toBeGreaterThan(0);
});

test('the mode switch sits above the separate Front and Neo sections', async () => {
  await frontEditor();
  const convo = screen.getByRole('region', { name: 'Front' });
  const neo = screen.getByRole('region', { name: 'Neo models' });
  expect(neo.contains(convo)).toBe(false);
  expect(convo.contains(neo)).toBe(false);
  expect(screen.getByRole('checkbox', { name: 'Dual-model mode' })).toBeTruthy();
  expect(within(convo).queryByRole('checkbox')).toBeNull();
  expect(within(convo).getByRole('button', { name: 'Choose Front model' })).toBeTruthy();
  expect(within(neo).queryByRole('button', { name: 'Choose Front model' })).toBeNull();
});

test('Neo and Front render the same model row component', async () => {
  await frontEditor();
  const neoRow = screen
    .getByRole('button', { name: 'Change Neo primary' })
    .closest('[data-model-row]')!;
  const convoRow = screen
    .getByRole('button', { name: 'Choose Front model' })
    .closest('[data-model-row]')!;
  expect(neoRow).toBeTruthy();
  expect(convoRow).toBeTruthy();
  expect(convoRow.contains(screen.getByLabelText('Front model thinking'))).toBe(true);
  expect(convoRow.contains(screen.getByLabelText('Front model auto-compact percentage'))).toBe(
    true
  );
  expect(neoRow.contains(screen.getByLabelText('Neo model 1 thinking'))).toBe(true);
  expect(neoRow.contains(screen.getByLabelText('Neo model 1 auto-compact percentage'))).toBe(true);
});

test('all Neo model controls are visible without an Advanced disclosure', async () => {
  const ui = await editor();
  expect(ui.queryByText('Advanced')).toBeNull();
  expect(ui.getByLabelText('Neo model 2 thinking').closest('details')).toBeNull();
  expect(ui.getByLabelText('Neo model 3 auto-compact percentage').closest('details')).toBeNull();
});

test.each(['percent', 'thinking'])(
  'Front saves %s from the saved model when its provider is absent from the authenticated catalog',
  async (control) => {
    auth.mockResolvedValue({
      providers: models.map((model) => ({
        id: model.provider,
        isAuthenticated: model.provider !== primary.provider,
      })),
    });
    await frontEditor();
    const front = within(screen.getByRole('region', { name: 'Front' }));
    if (control === 'percent') {
      const input = front.getByLabelText('Front model auto-compact percentage');
      fireEvent.input(input, { target: { value: '65' } });
      fireEvent.focusOut(input);
    } else {
      fireEvent.change(front.getByLabelText('Front model thinking'), {
        target: { value: 'think8k' },
      });
    }
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('operation.invoke', {
        name: 'neo.front.model.set',
        input: {
          ...primary,
          ...(control === 'percent' ? { autoCompactPercent: 65 } : { thinkingLevel: 'think8k' }),
        },
      })
    );
    expect(globalSettings.value?.neo?.preferences?.model).toBe(primary.model);
  }
);
