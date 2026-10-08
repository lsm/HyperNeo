import type { NeoWorkDriverReceipt } from '@hyperneo/shared/types/neo-snapshot';

const apps: Record<string, string> = {
  hyperneo: 'HyperNeo',
  space: 'a Space',
  'codex-desktop': 'Codex Desktop',
  'claude-desktop': 'Claude Code Desktop',
  'copilot-cli': 'GitHub Copilot',
  opencode: 'OpenCode',
};

export function neoWorkDriverLabel(driver: NeoWorkDriverReceipt): string {
  const app = `${apps[driver.adapter] ?? driver.adapter}${driver.daemon ? ` on ${driver.daemon}` : ''}`;
  if (driver.status === 'needs_you') return `Needs you in ${app}`;
  if (driver.status === 'running') return `Running in ${app}`;
  if (driver.status === 'done') return `Idle in ${app} · Neo is checking`;
  if (driver.status === 'failed' || driver.status === 'stopped') return `Stopped in ${app}`;
  return `Handed to ${app}`;
}

export function neoWorkDriverLink(driver: NeoWorkDriverReceipt | undefined): string | null {
  const link = driver?.link;
  if (!link || [...link].some((char) => char <= ' ' || char === '\\')) return null;
  if (/^(codex|claude|ghapp):\/\//.test(link)) return link;
  return !driver.daemon && /^\/(?!\/)/.test(link) ? link : null;
}
