export function neoSessionLink(
  link: string | null | undefined,
  daemon: string | null | undefined
): string | null {
  if (!link || [...link].some((char) => char <= ' ' || char === '\\')) return null;
  if (/^(codex|claude|ghapp):\/\//.test(link)) return link;
  return !daemon && /^\/(?!\/)/.test(link) ? link : null;
}

const shortApps: Record<string, string> = {
  hyperneo: 'HyperNeo',
  space: 'Space',
  'codex-desktop': 'Codex',
  'claude-desktop': 'Claude Code',
  'copilot-cli': 'GitHub Copilot',
  opencode: 'OpenCode',
};

export const neoAppLabel = (adapter: string): string => shortApps[adapter] ?? adapter;

export type NeoSessionKind = 'claude' | 'codex' | 'copilot' | 'hyperneo';

const adapterKinds: Record<string, NeoSessionKind> = {
  'claude-desktop': 'claude',
  'codex-desktop': 'codex',
  'copilot-cli': 'copilot',
  hyperneo: 'hyperneo',
  space: 'hyperneo',
};

export function neoSessionKind(
  adapter: string | null | undefined,
  link: string | null | undefined
): NeoSessionKind | null {
  if (adapter && adapterKinds[adapter]) return adapterKinds[adapter];
  if (!link) return null;
  if (/^claude:\/\//.test(link) || /^https:\/\/claude\.ai\//.test(link)) return 'claude';
  if (/^codex:\/\//.test(link)) return 'codex';
  if (/^ghapp:\/\//.test(link)) return 'copilot';
  if (/^\/session\//.test(link)) return 'hyperneo';
  return null;
}
