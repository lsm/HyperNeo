import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { AppMcpServer, AppSkill, GlobalSettings } from '@hyperneo/shared';

const mocks = vi.hoisted(() => ({ saveSkill: vi.fn(), saveServer: vi.fn() }));
vi.mock('../../../lib/state.ts', async () => {
  const { signal } = await import('@preact/signals');
  return { globalSettings: signal<GlobalSettings | null>(null) };
});
vi.mock('../../../hooks/useSkills.ts', () => ({
  useSkills: () => ({ skills: skillsStore.skills.value, isLoading: false, error: null }),
}));
vi.mock('../../../lib/skills-store.ts', () => ({
  skillsStore: {
    skills: { value: [] },
    loaded: { value: true },
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn(),
    setEnabled: mocks.saveSkill,
  },
}));
vi.mock('../../../lib/app-mcp-store.ts', () => ({
  appMcpStore: {
    appMcpServers: { value: [] },
    loading: { value: false },
    error: { value: null },
    subscribe: vi.fn().mockResolvedValue(undefined),
    unsubscribe: vi.fn(),
  },
}));
vi.mock('../../../lib/api-helpers.ts', () => ({ setAppMcpServerEnabled: mocks.saveServer }));
vi.mock('../AddSkillDialog.tsx', () => ({ AddSkillDialog: () => null }));
vi.mock('../EditSkillDialog.tsx', () => ({ EditSkillDialog: () => null }));
vi.mock('../InstallSkillFromGitDialog.tsx', () => ({ InstallSkillFromGitDialog: () => null }));
import { globalSettings } from '../../../lib/state.ts';
import { skillsStore } from '../../../lib/skills-store.ts';
import { appMcpStore } from '../../../lib/app-mcp-store.ts';
import { SkillsRegistry } from '../SkillsRegistry.tsx';
import { AppMcpServersSettings } from '../AppMcpServersSettings.tsx';
const settings = globalSettings as ReturnType<typeof signal<GlobalSettings | null>>;
const guide: AppSkill = {
  id: 'guide',
  name: 'guide',
  displayName: 'Fixture Guide',
  description: '',
  sourceType: 'builtin',
  config: { type: 'builtin', commandName: 'guide' },
  enabled: false,
  builtIn: true,
  validationStatus: 'valid',
  createdAt: 1,
};
const wrapper: AppSkill = {
  ...guide,
  id: 'wrapper',
  displayName: 'Fixture Browser',
  sourceType: 'mcp_server',
  config: { type: 'mcp_server', appMcpServerId: 'browser' },
};
const server: AppMcpServer = {
  id: 'browser',
  name: 'Fixture Server',
  sourceType: 'stdio',
  command: 'never-executed',
  enabled: false,
  source: 'user',
};
function toggle(name: string) {
  return within(
    screen.getByText(name).closest('.flex.items-center.justify-between') as HTMLElement
  ).getByRole('switch');
}
beforeEach(() => {
  vi.clearAllMocks();
  skillsStore.skills.value = [guide, wrapper];
  appMcpStore.appMcpServers.value = [server];
  settings.value = {
    toolSelectionDefaults: {
      version: 1,
      choices: { 'skill:guide': { selected: true }, 'mcp:browser': { selected: true } },
    },
  } as GlobalSettings;
  mocks.saveSkill.mockResolvedValue(guide);
  mocks.saveServer.mockResolvedValue({ ok: true });
});
afterEach(cleanup);
it('shows saved skill and backing-server defaults even when legacy flags are off', async () => {
  render(<SkillsRegistry />);
  expect(toggle('Fixture Guide').getAttribute('aria-checked')).toBe('true');
  expect(toggle('Fixture Browser').getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText(/Existing sessions keep their own choices/)).toBeTruthy();
  expect(screen.getByText(/Tools → Use here/)).toBeTruthy();
  fireEvent.click(toggle('Fixture Browser'));
  await waitFor(() => expect(mocks.saveSkill).toHaveBeenCalledWith('wrapper', false));
});
it('shows a wrapper-free server default and saves the opposite canonical choice', async () => {
  skillsStore.skills.value = [];
  render(<AppMcpServersSettings />);
  expect(toggle('Fixture Server').getAttribute('aria-checked')).toBe('true');
  expect(screen.queryByText(/no skill wrapper/i)).toBeNull();
  expect(screen.getByText(/Tools → Use here/)).toBeTruthy();
  fireEvent.click(toggle('Fixture Server'));
  await waitFor(() => expect(mocks.saveServer).toHaveBeenCalledWith('browser', false));
});
it('keeps absent canonical choices off even when legacy flags are on', () => {
  settings.value = { toolSelectionDefaults: { version: 1, choices: {} } } as GlobalSettings;
  appMcpStore.appMcpServers.value = [{ ...server, enabled: true }];
  render(<AppMcpServersSettings />);
  expect(toggle('Fixture Server').getAttribute('aria-checked')).toBe('false');
});
it('waits for settings before allowing a default edit', () => {
  settings.value = null;
  render(<SkillsRegistry />);
  expect((toggle('Fixture Guide') as HTMLButtonElement).disabled).toBe(true);
});
