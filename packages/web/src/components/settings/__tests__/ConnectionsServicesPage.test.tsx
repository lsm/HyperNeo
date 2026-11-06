import { lazy } from 'preact/compat';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { navigateToSettings } = vi.hoisted(() => ({ navigateToSettings: vi.fn() }));
vi.mock('../../../lib/router.ts', () => ({ navigateToSettings }));

import { locale } from '../../../lib/i18n/index.ts';
import type { SettingsSection } from '../../../lib/signals.ts';
import { ConnectionsServicesPage, isConnectionsSection } from '../ConnectionsServicesPage.tsx';

beforeEach(() => {
  locale.value = 'en';
  navigateToSettings.mockReset();
});

afterEach(cleanup);

describe('ConnectionsServicesPage', () => {
  it.each([
    ['providers', 'Providers'],
    ['connections', 'Accounts'],
    ['devices', 'Devices'],
    ['remote-daemons', 'Remote Daemons'],
  ] as const)('marks %s as the open tab and shows its panel', (section, label) => {
    render(
      <ConnectionsServicesPage section={section}>
        <p>Panel</p>
      </ConnectionsServicesPage>
    );
    const tabs = within(screen.getByRole('navigation', { name: 'Connections & Services' }));
    expect(tabs.getAllByRole('button').map((tab) => tab.textContent)).toEqual([
      'Providers',
      'Accounts',
      'Devices',
      'Remote Daemons',
    ]);
    expect(tabs.getByRole('button', { name: label }).getAttribute('aria-current')).toBe('page');
    expect(
      tabs.getAllByRole('button').filter((tab) => tab.hasAttribute('aria-current'))
    ).toHaveLength(1);
    expect(screen.getByText('Panel')).toBeTruthy();
  });

  it('opens a tab at the address its panel already had', () => {
    render(
      <ConnectionsServicesPage section="providers">
        <p>Panel</p>
      </ConnectionsServicesPage>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remote Daemons' }));
    expect(navigateToSettings).toHaveBeenCalledWith('remote-daemons');
  });

  it('keeps the tabs while a panel is still loading', async () => {
    const Loading = lazy(() => new Promise<{ default: () => null }>(() => {}));
    render(
      <ConnectionsServicesPage section="devices" fallback={<p>Loading panel</p>}>
        <Loading />
      </ConnectionsServicesPage>
    );
    expect(await screen.findByText('Loading panel')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Devices' })).toBeTruthy();
  });

  it('labels the tabs in Chinese', () => {
    locale.value = 'zh-Hans';
    render(
      <ConnectionsServicesPage section="connections">
        <p>Panel</p>
      </ConnectionsServicesPage>
    );
    expect(screen.getByRole('navigation', { name: '连接与服务' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '账号' }).getAttribute('aria-current')).toBe('page');
  });
});

describe('isConnectionsSection', () => {
  it.each<[SettingsSection, boolean]>([
    ['providers', true],
    ['connections', true],
    ['devices', true],
    ['remote-daemons', true],
    ['exa', false],
    ['models', false],
  ])('%s is %s', (section, expected) => {
    expect(isConnectionsSection(section)).toBe(expected);
  });
});
