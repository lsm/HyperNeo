import { signal } from '@preact/signals';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../../../lib/state.ts', () => ({ globalSettings: signal(null) }));
const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('../../../lib/connection-manager', () => ({
  connectionManager: { getHubIfConnected: () => ({ request }) },
}));
import { globalSettings } from '../../../lib/state.ts';
import { DriverHealthSettings } from '../DriverHealthSettings.tsx';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  request.mockReset();
});

test('Check now shows a slow successful result after the default request deadline', async () => {
  vi.useFakeTimers();
  (globalSettings as { value: unknown }).value = null;
  request.mockImplementation(
    (_name, _input, options?: { timeout?: number }) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Request timeout')),
          options?.timeout ?? 10_000
        );
        setTimeout(() => {
          clearTimeout(timer);
          resolve({
            ok: true,
            health: {
              'codex-desktop': {
                status: 'ok',
                reason: 'Slow check completed.',
                clientVersions: { desktop: '2.0.0' },
                checkedAt: 1,
                unverifiedVersion: false,
              },
            },
          });
        }, 12_000);
      })
  );
  render(<DriverHealthSettings />);
  fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(12_001);
  });
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.getByText('Slow check completed.')).toBeTruthy();
});

test('Settings shows the affected client, its version, and the concrete failure', () => {
  (globalSettings as { value: unknown }).value = {
    driverHealth: {
      'codex-desktop': {
        status: 'unavailable',
        reason: 'Codex state database is missing.',
        checkedAt: 1,
        clientVersions: { desktop: '2.0.0' },
        unverifiedVersion: true,
      },
    },
  } as never;
  render(<DriverHealthSettings />);
  expect(screen.getByText('Codex Desktop')).toBeTruthy();
  expect(screen.getByText('Unavailable')).toBeTruthy();
  expect(screen.getByText('Codex state database is missing.')).toBeTruthy();
  expect(screen.getByText(/2.0.0/)).toBeTruthy();
  expect(screen.getByText('Unverified version')).toBeTruthy();
});
