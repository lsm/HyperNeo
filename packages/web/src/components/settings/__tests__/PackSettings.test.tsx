import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { NeoPackSetting } from '@hyperneo/shared/types/neo-snapshot';
import { applyLanguage } from '../../../lib/i18n/index.ts';

const { request, rows, connection } = vi.hoisted(() => ({
  request: vi.fn(),
  rows: [] as NeoPackSetting[],
  connection: { ready: true },
}));
vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: { getHubIfConnected: () => (connection.ready ? { request } : null) },
}));
vi.mock('../CodingPackSettings.tsx', () => ({
  CodingPackSettings: () => <section aria-label="Coding pack settings">Coding controls</section>,
}));
import { PackSettings } from '../PackSettings.tsx';

const scope = { kind: 'global', key: '' } as const;
const writes = () => request.mock.calls.filter(([, call]) => call.name === 'pack.preferences.set');
beforeEach(() => {
  connection.ready = true;
  rows.length = 0;
  applyLanguage('en');
  request.mockReset().mockImplementation(async (_method, { name, input }) => {
    if (name === 'pack.preferences.list') return { preferences: rows.map((row) => ({ ...row })) };
    if (name === 'pack.preferences.get')
      return { preference: rows.find((row) => row.key === input.key) ?? null };
    const index = rows.findIndex((row) => row.key === input.key);
    if (index >= 0) rows.splice(index, 1);
    rows.push({ ...input, setBy: 'human', setAt: 1 });
    return { ok: true };
  });
});
afterEach(() => {
  cleanup();
  applyLanguage('en');
});

async function page() {
  render(<PackSettings />);
  const ui = within(await screen.findByRole('region', { name: 'Delegation preferences' }));
  await waitFor(() => expect(ui.queryByText('Loading…')).toBeNull());
  return ui;
}

test('shows delegation beside existing coding settings with conservative unsaved defaults', async () => {
  const ui = await page();
  expect(screen.getByRole('region', { name: 'Coding pack settings' })).toBeTruthy();
  expect(ui.getAllByRole('combobox')).toHaveLength(6);
  expect(ui.getByRole('option', { name: 'I sign in' })).toBeTruthy();
  expect(ui.getByRole('option', { name: 'Fill it, I press the last button' })).toBeTruthy();
  expect(ui.getAllByText('Unanswered', { exact: true })).toHaveLength(6);
  expect(writes()).toHaveLength(0);
});

test('a human choice writes and reads back only the selected global delegation preference', async () => {
  const ui = await page();
  fireEvent.change(ui.getByRole('combobox', { name: 'Who completes payments?' }), {
    target: { value: 'fillStop' },
  });
  await waitFor(() => expect(ui.getByText('Saved')).toBeTruthy());
  expect(writes().map(([, call]) => call.input)).toEqual([
    { pack: 'delegation', scope, key: 'payment', value: 'fillStop' },
  ]);
  expect(request).toHaveBeenCalledWith('operation.invoke', {
    name: 'pack.preferences.get',
    input: { pack: 'delegation', scope, key: 'payment' },
  });
  expect(
    (ui.getByRole('combobox', { name: 'Who completes payments?' }) as HTMLSelectElement).value
  ).toBe('fillStop');
});

test('a refusal stays visible and leaves the previous value selected', async () => {
  rows.push({ pack: 'delegation', scope, key: 'payment', value: 'self', setBy: 'human', setAt: 1 });
  const ui = await page();
  const normal = request.getMockImplementation()!;
  request.mockImplementation((method, call) =>
    call.name === 'pack.preferences.set'
      ? { ok: false, reason: 'Human setting refused' }
      : normal(method, call)
  );
  fireEvent.change(ui.getByRole('combobox', { name: 'Who completes payments?' }), {
    target: { value: 'confirmed' },
  });
  expect((await ui.findByRole('alert')).textContent).toBe('Human setting refused');
  expect(
    (ui.getByRole('combobox', { name: 'Who completes payments?' }) as HTMLSelectElement).value
  ).toBe('self');
});

test('does not claim a save when the exact global value fails readback', async () => {
  const ui = await page();
  const normal = request.getMockImplementation()!;
  request.mockImplementation((method, call) =>
    call.name === 'pack.preferences.get' ? { preference: null } : normal(method, call)
  );
  fireEvent.change(ui.getByRole('combobox', { name: 'Who signs in?' }), {
    target: { value: 'saved' },
  });
  expect(await ui.findByRole('alert')).toBeTruthy();
  expect(ui.queryByText('Saved')).toBeNull();
});

test('shows Chinese field names and choices', async () => {
  applyLanguage('zh-Hans');
  render(<PackSettings />);
  const ui = within(await screen.findByRole('region', { name: '委托偏好' }));
  await waitFor(() => expect(ui.getAllByRole('combobox')).toHaveLength(6));
  expect(ui.getByRole('combobox', { name: '需要我操作时用什么设备？' })).toBeTruthy();
  expect(ui.getByRole('option', { name: '只发到我的手机' })).toBeTruthy();
  expect(writes()).toHaveLength(0);
});

test('a disconnected page shows a reconnect error without writing settings', async () => {
  connection.ready = false;
  render(<PackSettings />);
  expect((await screen.findByRole('alert')).textContent).toContain('Reconnect');
  expect(writes()).toHaveLength(0);
});

test('renders field and choice labels supplied by the pack preferences response', async () => {
  request.mockImplementation(async (_method, { name }) => {
    if (name === 'pack.preferences.list')
      return {
        preferences: [],
        declarations: {
          signIn: {
            label: { en: 'Pack-provided question', 'zh-Hans': '包提供的问题' },
            valueLabels: { self: { en: 'Pack-provided choice', 'zh-Hans': '包提供的选项' } },
          },
        },
      };
    throw new Error('Unexpected operation');
  });
  const ui = await page();
  expect(ui.getByRole('combobox', { name: 'Pack-provided question' })).toBeTruthy();
  expect(ui.getByRole('option', { name: 'Pack-provided choice' })).toBeTruthy();
});
