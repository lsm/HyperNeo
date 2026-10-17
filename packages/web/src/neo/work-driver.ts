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
