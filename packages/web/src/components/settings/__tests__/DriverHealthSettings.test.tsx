import { signal } from '@preact/signals';
import { cleanup, render, screen } from '@testing-library/preact';
import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../../../lib/state.ts', () => ({ globalSettings: signal(null) }));
import { globalSettings } from '../../../lib/state.ts';
import { DriverHealthSettings } from '../DriverHealthSettings.tsx';

afterEach(cleanup);

test('Settings shows the affected client, its version, and the concrete failure', () => {
  globalSettings.value = { driverHealth: {
    'codex-desktop': { status: 'unavailable', reason: 'Codex state database is missing.', checkedAt: 1, clientVersions: { desktop: '2.0.0' }, unverifiedVersion: true },
  } } as never;
  render(<DriverHealthSettings />);
  expect(screen.getByText('Codex Desktop')).toBeTruthy();
  expect(screen.getByText('Unavailable')).toBeTruthy();
  expect(screen.getByText('Codex state database is missing.')).toBeTruthy();
  expect(screen.getByText(/2.0.0/)).toBeTruthy();
  expect(screen.getByText('Unverified version')).toBeTruthy();
});
