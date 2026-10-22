import { workerEngine } from '@hyperneo/shared/types/worker-identity';
export function neoSessionLink(
  link: string | null | undefined,
  daemon: string | null | undefined
): string | null {
  if (!link || [...link].some((char) => char <= ' ' || char === '\\')) return null;
  if (/^(codex|claude|ghapp):\/\//.test(link)) return link;
  return !daemon && /^\/(?!\/)/.test(link) ? link : null;
}

export const neoAppLabel = workerEngine;

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
