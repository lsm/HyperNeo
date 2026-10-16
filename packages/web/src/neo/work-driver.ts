export function neoSessionLink(
  link: string | null | undefined,
  daemon: string | null | undefined
): string | null {
  if (!link || [...link].some((char) => char <= ' ' || char === '\\')) return null;
  if (/^(codex|claude|ghapp):\/\//.test(link)) return link;
  return !daemon && /^\/(?!\/)/.test(link) ? link : null;
}

const shortApps: Record<string, string> = {
  'hyperneo-sessions': 'HyperNeo',
  'hyperneo-spaces': 'Space',
  'codex-desktop': 'Codex',
  'claude-desktop': 'Claude Code',
  'copilot-cli': 'GitHub Copilot',
  opencode: 'OpenCode',
};

const logos: Record<string, string> = {
  'claude-desktop': 'anthropic',
  'codex-desktop': 'anthropic-codex',
};

export const neoAppLabel = (adapter: string): string => shortApps[adapter] ?? adapter;

export const neoAppLogo = (adapter: string | null | undefined): string | undefined =>
  adapter ? logos[adapter] : undefined;
