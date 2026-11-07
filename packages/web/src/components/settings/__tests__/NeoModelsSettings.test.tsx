import { signal } from '@preact/signals';
import { MODEL_LIST_REQUEST_TIMEOUT_MS } from '@hyperneo/shared/provider';
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
vi.mock('../../ui/ConfirmModal.tsx', () => ({
  ConfirmModal: ({
    isOpen,
    message,
    onClose,
    onConfirm,
  }: {
    isOpen: boolean;
    message: string;
    onClose: () => void;
    onConfirm: () => void;
  }) =>
    isOpen ? (
      <div role="dialog">
        <p>{message}</p>
        <button onClick={onClose}>Cancel</button>
        <button onClick={onConfirm}>Confirm</button>
      </div>
    ) : null,
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
  fireEvent.click(ui.getAllByTitle('Move up')[2]);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, fallbacks: [copilot, { ...glm, thinkingLevel: 'off' }] },
    })
  );
  expect(ui.getByText(/Providers with usable models:/).textContent).toContain('OpenRouter');
  expect(ui.getByText(/Providers with usable models:/).textContent).toContain('Z.ai');
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
    fireEvent.click(ui.getAllByTitle('Remove')[1]);
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
  expect(rows.map((row) => row.includes('Primary'))).toEqual([true, false, false]);
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
  expect(ui.getByText('88% ≈ 176K of 200K tokens')).toBeTruthy();
  expect(ui.getByText('90% · context window unknown')).toBeTruthy();
  fireEvent.blur(ui.getByLabelText('Neo model 2 auto-compact percentage'));
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
  expect(ui.getByText(/Uses the general session fallback chain/)).toBeTruthy();
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
  expect(ui.getByText(/Providers with usable models:/).textContent).not.toContain('OpenRouter');
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
  expect(ui.getByText('70% ≈ 700K of 1M tokens')).toBeTruthy();
  fireEvent.blur(ui.getByLabelText('Neo model 1 auto-compact percentage'));
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
  expect(ui.getByText('90% ≈ 900K of 1M tokens')).toBeTruthy();
  fireEvent.blur(ui.getByLabelText('Neo model 1 auto-compact percentage'));
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
    fireEvent.blur(ui.getByLabelText('Neo model 1 auto-compact percentage'));
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

test('states the saved preference does not promise recovery or return to the primary', async () => {
  const ui = await editor();
  const copy = ui.getByText(/Saved Neo model preference/).textContent ?? '';
  expect(copy).toContain('Recovery uses the ordinary session policy');
  expect(copy).not.toContain('returns to the primary');
  expect(ui.queryByText(/returns to the primary/)).toBeNull();
});

test('compaction copy says percentage changes apply when Neo is idle', async () => {
  const ui = await editor();
  expect(ui.getByText(/Percentage changes apply when Neo is idle/)).toBeTruthy();
  expect(ui.queryByText(/after the current reply/)).toBeNull();
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
  expect(screen.getByText(/Refresh reloads the model list only/)).toBeTruthy();
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
  fireEvent.blur(ui.getByLabelText('Neo model 1 auto-compact percentage'));
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

test('shows primary thinking above Advanced and keeps compaction and fallbacks inside it without writing', async () => {
  const ui = await editor();
  const advanced = ui.getByText('Advanced').closest('details');
  expect(advanced).toBeTruthy();
  expect(advanced?.hasAttribute('open')).toBe(false);
  expect(advanced?.contains(ui.getByLabelText('Neo model 1 thinking'))).toBe(false);
  expect(advanced?.contains(ui.getByLabelText('Neo model 1 auto-compact percentage'))).toBe(true);
  expect(advanced?.contains(ui.getByLabelText('Neo model 2 thinking'))).toBe(true);
  expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
});

test('automatically saves primary thinking with Advanced closed and preserves inherited fallbacks', async () => {
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
  fireEvent.blur(input);
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.preferences.set',
      input: { ...primary, autoCompactPercent: 70, fallbacks: [glm, copilot] },
    })
  );
  request.mockClear();
  fireEvent.input(input, { target: { value: '101' } });
  fireEvent.blur(input);
  expect((await ui.findByRole('alert')).textContent).toContain('10 to 100');
  expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
});

test('the only remaining model cannot be removed and explains why without saving', async () => {
  (globalSettings as { value: GlobalSettings | null }).value = {
    neo: { preferences: primary },
  } as GlobalSettings;
  const ui = await editor();
  const remove = ui.getByTitle('Remove') as HTMLButtonElement;
  expect(remove.disabled).toBe(true);
  expect(ui.getByText('Add another model before removing this one.')).toBeTruthy();
  fireEvent.click(remove);
  expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
});

test('chooses the first model and changes primary and thinking with Advanced closed', async () => {
  (globalSettings as { value: GlobalSettings | null }).value = { settingSources: [] };
  render(<NeoModelSettings />);
  const ui = within(await screen.findByRole('region', { name: 'Neo models' }));
  const advanced = ui.getByText('Advanced').closest('details');
  const choose = ui.getByRole('button', { name: 'Choose Neo model' });
  await waitFor(() => expect(choose.hasAttribute('disabled')).toBe(false));
  expect(advanced?.contains(choose)).toBe(false);
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
  expect(advanced?.open).toBe(false);
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

test.each(['picker', 'make primary', 'move up', 'remove primary'])(
  'confirms %s before changing the primary and leaves no change on cancel',
  async (action) => {
    const ui = await editor();
    if (action === 'picker') {
      fireEvent.click(ui.getByRole('button', { name: 'Change Neo primary' }));
      fireEvent.click(await screen.findByRole('button', { name: 'router/test' }));
    } else if (action === 'make primary') {
      fireEvent.click(ui.getByRole('button', { name: 'Make Neo model 2 primary' }));
    } else if (action === 'move up') {
      fireEvent.click(ui.getAllByTitle('Move up')[1]);
    } else {
      fireEvent.click(ui.getAllByTitle('Remove')[0]);
    }
    expect(
      await screen.findByText(`Switch Neo to ${action === 'picker' ? 'router/test' : 'glm-5'}?`)
    ).toBeTruthy();
    expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(request).not.toHaveBeenCalledWith('operation.invoke', expect.anything());
    expect(ui.getByText('opus · Anthropic')).toBeTruthy();
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
