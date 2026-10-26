import { signal } from '@preact/signals';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { GlobalSettings } from '@hyperneo/shared';

const { request, hub } = vi.hoisted(() => {
  const request = vi.fn();
  return { request, hub: { current: { request } as { request: typeof request } | null } };
});
vi.mock('../../../lib/state.ts', () => ({
  globalSettings: signal(null),
  connectionState: signal('connected'),
}));
vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: { getHubIfConnected: () => hub.current },
}));
import { NeoRulesSettings } from '../NeoRulesSettings.tsx';
import { globalSettings } from '../../../lib/state.ts';

const saved = ['Ship PRs from a worktree.', 'Ask before deleting data.'];
function settle(rules: string[]) {
  (globalSettings as { value: GlobalSettings | null }).value = {
    neo: { standingRules: rules },
  } as GlobalSettings;
}

beforeEach(() => {
  hub.current = { request };
  settle(saved);
  request.mockReset().mockImplementation(async (_method, { input }) => {
    const rules = [
      ...saved.filter((rule) => !(input.remove ?? []).includes(rule)),
      ...(input.add ?? []),
    ];
    return { ok: true, standingRules: rules };
  });
});
afterEach(cleanup);

function section() {
  render(<NeoRulesSettings />);
  return within(screen.getByRole('region', { name: 'Neo standing rules' }));
}

test('lists each saved rule on its own row without a rule budget', () => {
  const ui = section();
  expect(ui.getAllByRole('listitem').map((row) => row.textContent)).toEqual([
    expect.stringContaining(saved[0]),
    expect.stringContaining(saved[1]),
  ]);
  expect(ui.getByText('2 rules')).toBeTruthy();
});

test('adding a rule asks first; Cancel writes nothing and Confirm adds only that rule', async () => {
  const ui = section();
  fireEvent.input(ui.getByLabelText('New Neo rule'), {
    target: { value: '  Merge only after review.  ' },
  });
  fireEvent.click(ui.getByRole('button', { name: 'Add rule' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog.textContent).toContain('Merge only after review.');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(request).not.toHaveBeenCalled();

  fireEvent.click(ui.getByRole('button', { name: 'Add rule' }));
  fireEvent.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Add' })
  );
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.rule.save',
      input: { add: ['Merge only after review.'] },
    })
  );
  await waitFor(() => expect(ui.getAllByRole('listitem')).toHaveLength(3));
  expect((ui.getByLabelText('New Neo rule') as HTMLTextAreaElement).value).toBe('');
});

test('removing a rule confirms its exact text and removes only that rule', async () => {
  const ui = section();
  fireEvent.click(ui.getByRole('button', { name: 'Remove Neo rule 2' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog.textContent).toContain(saved[1]);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
  await waitFor(() =>
    expect(request).toHaveBeenCalledWith('operation.invoke', {
      name: 'neo.rule.save',
      input: { remove: [saved[1]] },
    })
  );
  await waitFor(() => expect(ui.getAllByRole('listitem')).toHaveLength(1));
});

test('a refused or disconnected save keeps the dialog open with the reason and the list unchanged', async () => {
  request.mockResolvedValueOnce({ ok: false, reason: '"x" is not a saved rule.' });
  const ui = section();
  fireEvent.click(ui.getByRole('button', { name: 'Remove Neo rule 1' }));
  const dialog = await screen.findByRole('alertdialog');
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
  expect(await within(dialog).findByText('"x" is not a saved rule.')).toBeTruthy();
  expect(ui.getAllByRole('listitem')).toHaveLength(2);
  hub.current = null;
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
  expect(await within(dialog).findByText('Reconnect before changing Neo rules.')).toBeTruthy();
  expect(ui.getAllByRole('listitem')).toHaveLength(2);
});

test('the add button stays off for empty, duplicate, over-500-character text but permits more than 20 rules', () => {
  const ui = section();
  const box = ui.getByLabelText('New Neo rule');
  const add = () => ui.getByRole('button', { name: 'Add rule' }) as HTMLButtonElement;
  expect(add().disabled).toBe(true);
  fireEvent.input(box, { target: { value: saved[0] } });
  expect(add().disabled).toBe(true);
  expect(ui.getByText('This rule is already saved.')).toBeTruthy();
  fireEvent.input(box, { target: { value: 'x'.repeat(501) } });
  expect(add().disabled).toBe(true);
  expect(ui.getByText('501 / 500 characters')).toBeTruthy();
  fireEvent.input(box, { target: { value: 'x'.repeat(500) } });
  expect(add().disabled).toBe(false);
  cleanup();
  settle(Array.from({ length: 20 }, (_, i) => `Rule ${i + 1}.`));
  const full = section();
  fireEvent.input(full.getByLabelText('New Neo rule'), { target: { value: 'One more.' } });
  expect((full.getByRole('button', { name: 'Add rule' }) as HTMLButtonElement).disabled).toBe(false);
});
