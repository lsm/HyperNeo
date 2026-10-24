import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { NeoPackSetting } from '@hyperneo/shared/types/neo-snapshot';

type Scope = NeoPackSetting['scope'];
const { request, rows } = vi.hoisted(() => ({ request: vi.fn(), rows: [] as NeoPackSetting[] }));
vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: { getHubIfConnected: () => ({ request }) },
}));
import { CodingPackSettings } from '../CodingPackSettings.tsx';

const same = (a: Scope, b: Scope) => a.kind === b.kind && a.key === b.key;
function seed(key: string, scope: Scope, value: unknown) {
  rows.push({ pack: 'coding', scope, key, value, setBy: 'human', setAt: 1 });
}
const global = { kind: 'global', key: '' } as const;
const repo = { kind: 'repo', key: 'acme/app' } as const;
const sets = () => request.mock.calls.filter(([, call]) => call.name === 'pack.preferences.set');

beforeEach(() => {
  rows.length = 0;
  request.mockReset().mockImplementation(async (_method, { name, input }) => {
    if (name === 'pack.preferences.list') return { preferences: rows.map((row) => ({ ...row })) };
    if (name === 'pack.preferences.get') {
      const hit =
        rows.find((row) => row.key === input.key && same(row.scope, input.scope)) ??
        rows.find((row) => row.key === input.key && same(row.scope, global));
      return { preference: hit ?? null };
    }
    const index = rows.findIndex((row) => row.key === input.key && same(row.scope, input.scope));
    if (index >= 0) rows.splice(index, 1);
    seed(input.key, input.scope, input.value);
    return { ok: true };
  });
});
afterEach(cleanup);

async function page(repoName = '') {
  render(<CodingPackSettings />);
  const ui = within(await screen.findByRole('region', { name: 'Coding pack settings' }));
  if (repoName) fireEvent.input(ui.getByLabelText('Repository'), { target: { value: repoName } });
  await waitFor(() => expect(ui.queryByText('Loading…')).toBeNull());
  return ui;
}
const state = (ui: Awaited<ReturnType<typeof page>>, label: string) =>
  ui.getByRole('group', { name: label }).querySelector('[data-state]')?.textContent;

test('an empty pack shows every setting as unanswered and opening it writes nothing', async () => {
  const ui = await page();
  expect(state(ui, 'Merge policy')).toBe('Unanswered');
  expect(state(ui, 'Human sign-off paths or labels')).toBe('Unanswered');
  expect((ui.getByRole('combobox', { name: 'Merge policy' }) as HTMLSelectElement).value).toBe('');
  expect(ui.queryByRole('group', { name: 'Review bot' })).toBeNull();
  expect(ui.queryByRole('button', { name: /reset|delete|inherit/i })).toBeNull();
  expect(sets()).toHaveLength(0);
});

test('a repository shows its own answers and falls back to pack global for the rest', async () => {
  seed('mergePolicy', global, 'review_bot');
  seed('reviewBot', global, 'global-bot');
  seed('humanSignoff', repo, []);
  const ui = await page('acme/app');
  expect(state(ui, 'Merge policy')).toBe('Inherited from pack global');
  expect((ui.getByRole('combobox', { name: 'Merge policy' }) as HTMLSelectElement).value).toBe(
    'review_bot'
  );
  expect(state(ui, 'Review bot')).toBe('Inherited from pack global');
  expect((ui.getByRole('textbox', { name: 'Review bot' }) as HTMLInputElement).value).toBe(
    'global-bot'
  );
  expect(state(ui, 'Human sign-off paths or labels')).toBe('Saved for acme/app');
  expect(ui.getByText('No extra human sign-off paths or labels')).toBeTruthy();
  expect(sets()).toHaveLength(0);
});

test('saving for a repository writes that scope, reads it back and leaves pack global alone', async () => {
  seed('mergePolicy', global, 'human');
  const ui = await page('acme/app');
  fireEvent.change(ui.getByRole('combobox', { name: 'Merge policy' }), {
    target: { value: 'ci_only' },
  });
  await waitFor(() => expect(state(ui, 'Merge policy')).toBe('Saved for acme/app'));
  expect(sets().map(([, call]) => call.input)).toEqual([
    { pack: 'coding', scope: repo, key: 'mergePolicy', value: 'ci_only' },
  ]);
  expect(request).toHaveBeenCalledWith('operation.invoke', {
    name: 'pack.preferences.get',
    input: { pack: 'coding', scope: repo, key: 'mergePolicy' },
  });
  expect(rows.find((row) => same(row.scope, global))?.value).toBe('human');
});

test('saving no sign-off paths stores an explicit empty list, not unanswered', async () => {
  const ui = await page();
  fireEvent.click(ui.getByRole('button', { name: 'Save sign-off paths' }));
  await waitFor(() =>
    expect(state(ui, 'Human sign-off paths or labels')).toBe('Saved for pack global')
  );
  expect(sets()[0][1].input).toEqual({
    pack: 'coding',
    scope: global,
    key: 'humanSignoff',
    value: [],
  });
  expect(ui.getByText('No extra human sign-off paths or labels')).toBeTruthy();
});

test.each([
  [
    'a rejected value',
    async () => ({ ok: false, reason: 'Unknown setting, invalid scope or invalid value.' }),
    'Unknown setting, invalid scope or invalid value.',
  ],
  [
    'a refused caller',
    async () => {
      throw new Error('Operation pack.preferences.set is not available to this caller');
    },
    'Operation pack.preferences.set is not available to this caller',
  ],
])('%s shows the refusal and keeps the setting unanswered', async (_case, refuse, message) => {
  const ui = await page();
  const answer = request.getMockImplementation()!;
  request.mockImplementation((method, call) =>
    call.name === 'pack.preferences.set' ? refuse() : answer(method, call)
  );
  fireEvent.change(ui.getByRole('combobox', { name: 'Merge policy' }), {
    target: { value: 'human' },
  });
  expect((await ui.findByRole('alert')).textContent).toBe(message);
  expect(state(ui, 'Merge policy')).toBe('Unanswered');
});

test('switching repository drops an unsaved draft instead of saving it to the new scope', async () => {
  const ui = await page('acme/app');
  const box = ui.getByRole('textbox', {
    name: 'Human sign-off paths or labels',
  }) as HTMLTextAreaElement;
  fireEvent.input(box, { target: { value: 'docs/**' } });
  fireEvent.input(ui.getByLabelText('Repository'), { target: { value: 'other/repo' } });
  await waitFor(() => expect(ui.getByText('Editing: other/repo')).toBeTruthy());
  expect(box.value).toBe('');
});
