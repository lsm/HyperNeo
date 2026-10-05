import type { NeoWorkDriverReceipt } from '@hyperneo/shared/types/neo-snapshot';

const apps: Record<string, string> = {
  hyperneo: 'HyperNeo',
  space: 'a Space',
  'codex-desktop': 'Codex Desktop',
  'claude-desktop': 'Claude Code Desktop',
};

export function neoWorkDriverLabel(driver: NeoWorkDriverReceipt): string {
  const app = `${apps[driver.adapter] ?? driver.adapter}${driver.daemon ? ` on ${driver.daemon}` : ''}`;
  if (driver.status === 'needs_you') return `Needs you in ${app}`;
  if (driver.status === 'running') return `Running in ${app}`;
  if (driver.status === 'done') return `Finished in ${app}`;
  if (driver.status === 'failed' || driver.status === 'stopped') return `Stopped in ${app}`;
  return `Handed to ${app}`;
}

export function neoWorkDriverLink(driver: NeoWorkDriverReceipt | undefined): string | null {
  const link = driver?.link;
  if (!link) return null;
  return /^(\/(?![/\\])|codex:\/\/|claude:\/\/)/.test(link) ? link : null;
}
