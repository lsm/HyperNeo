import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, expect, it, vi } from 'vitest';

const { navigateToSettings } = vi.hoisted(() => ({ navigateToSettings: vi.fn() }));
vi.mock('../../../lib/router.ts', () => ({ navigateToSettings }));
import { CapabilitiesPage } from '../CapabilitiesPage.tsx';

afterEach(() => {
  cleanup();
  navigateToSettings.mockReset();
});

it.each([
  ['skills', 'Skills'],
  ['app-mcp-servers', 'MCP Servers'],
  ['coding-pack', 'Coding pack'],
] as const)('keeps %s reachable as the active Capabilities tab', (section, label) => {
  render(
    <CapabilitiesPage section={section}>
      <p>Existing panel</p>
    </CapabilitiesPage>
  );
  const nav = within(screen.getByRole('navigation', { name: 'Capabilities' }));
  expect(nav.getAllByRole('button').map((button) => button.textContent)).toEqual([
    'Skills',
    'MCP Servers',
    'Coding pack',
  ]);
  expect(nav.getByRole('button', { name: label }).getAttribute('aria-current')).toBe('page');
  expect(screen.getByText('Existing panel')).toBeTruthy();
  fireEvent.click(nav.getByRole('button', { name: 'MCP Servers' }));
  expect(navigateToSettings).toHaveBeenCalledWith('app-mcp-servers');
});
