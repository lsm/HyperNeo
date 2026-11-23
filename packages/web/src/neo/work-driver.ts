import { workerEngine } from '@hyperneo/shared/types/worker-identity';
import { t } from '../lib/i18n/index.ts';
import { openNativeSessionLink } from '../lib/runtime-capabilities.ts';
import { toast } from '../lib/toast.ts';

export function isNativeSessionLink(link: string): boolean {
  return /^(codex|claude|ghapp):\/\//.test(link);
}

export function handoffNativeSessionLink(link: string): boolean {
  if (!isNativeSessionLink(link)) return false;
  const handoff = openNativeSessionLink(link);
  if (!handoff) return false;
  void handoff.catch(() => toast.error(t('session.openExternalFailed')));
  return true;
}

export function neoSessionLink(
  link: string | null | undefined,
  daemon: string | null | undefined
): string | null {
  if (!link || [...link].some((char) => char <= ' ' || char === '\\')) return null;
  if (isNativeSessionLink(link)) return link;
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
