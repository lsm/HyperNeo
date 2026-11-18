import { signal } from '@preact/signals';
import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { GlobalSettings } from '@hyperneo/shared';

const { updateGlobalSettings } = vi.hoisted(() => ({
  updateGlobalSettings: vi.fn(async () => undefined),
}));
vi.mock('../../../lib/state.ts', () => ({ globalSettings: signal(null) }));
vi.mock('../../../lib/api-helpers.ts', () => ({ updateGlobalSettings }));
vi.mock('../ModelsSettings.tsx', () => ({ ModelsSettings: () => <h2>HyperNeo sessions</h2> }));
vi.mock('../NeoRulesSettings.tsx', () => ({ NeoRulesSettings: () => null }));
vi.mock('../NeoMutedSessionsSettings.tsx', () => ({ NeoMutedSessionsSettings: () => null }));
vi.mock('../DriverHealthSettings.tsx', () => ({
  DriverHealthSettings: () => <h2>Worker client health</h2>,
}));

import { globalSettings } from '../../../lib/state.ts';
import { NeoModelSettings } from '../NeoModelSettings.tsx';
import { SessionsHarnessSettings } from '../SessionsHarnessSettings.tsx';

const settle = (workerSandbox?: string) => {
  (globalSettings as { value: GlobalSettings | null }).value = {
    workerSandbox,
  } as unknown as GlobalSettings;
};

beforeEach(() => settle());

afterEach(() => {
  cleanup();
  updateGlobalSettings.mockClear();
});

test('orders the sections as designed and writes nothing on open', () => {
  render(<SessionsHarnessSettings />);
  const titles = [
    'HyperNeo sessions',
    'HyperNeo session permissions',
    'Claude Code',
    'Codex',
    'All Neo workers',
    'Worker client health',
  ].map((name) => screen.getByText(name));
  titles
    .slice(1)
    .forEach((title, index) =>
      expect(
        titles[index].compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy()
    );
  expect(updateGlobalSettings).not.toHaveBeenCalled();
});

test('shows what Codex uses today, read-only, with no saved control', () => {
  render(<SessionsHarnessSettings />);
  expect(screen.getByText('never')).toBeTruthy();
  expect(screen.getByText('danger-full-access')).toBeTruthy();
  expect(screen.getByText('Fixed today unless the worker sandbox below is on.')).toBeTruthy();
  expect(
    screen.getByText('Shown for reference. Saved Codex defaults come in step two.')
  ).toBeTruthy();
  expect(screen.queryByRole('combobox', { name: /approvalPolicy|Codex/ })).toBeNull();
});

test.each(['always', 'on-demand'])('says eligible Codex workers get limits when %s', (mode) => {
  settle(mode);
  render(<SessionsHarnessSettings />);
  expect(screen.queryByText('danger-full-access')).toBeNull();
  expect(screen.getByText('worker sandbox')).toBeTruthy();
  expect(
    screen.getByText('Worker sandbox is on, so eligible workers get write limits instead.')
  ).toBeTruthy();
});

test('the Neo page no longer holds worker settings or client health', () => {
  render(<NeoModelSettings />);
  expect(screen.queryByRole('combobox', { name: 'Claude worker permission' })).toBeNull();
  expect(screen.queryByRole('combobox', { name: 'Worker sandbox' })).toBeNull();
  expect(screen.queryByText('Worker client health')).toBeNull();
});
