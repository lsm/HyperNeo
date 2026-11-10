import { basename } from 'node:path';
import type { Place } from '../drivers/types.ts';

export type NeoWorkerNameSource = (
  adapter: string,
  place?: Place
) => Promise<{
  place: Place;
  taken: readonly string[];
}>;

export function planNeoWorkerName(
  adapter: string,
  place: Place | undefined,
  taken: readonly string[]
) {
  const labels: Record<string, string> = {
    'codex-desktop': 'Codex',
    'claude-desktop': 'Claude Code',
    'claude-code': 'Claude Code',
    hyperneo: 'HyperNeo',
    space: 'HyperNeo',
    'copilot-cli': 'Copilot',
  };
  const repository = place?.repoName ?? place?.remotes?.[0];
  const project = basename(
    (repository ?? place?.folder ?? place?.name ?? 'work').replaceAll('\\', '/').replace(/\/+$/, '')
  )
    .replace(/\.git$/i, '')
    .toLowerCase();
  const prefix = `${labels[adapter] ?? adapter} ${project}`;
  const names = new Set(taken);
  let number = 1;
  while (names.has(`${prefix} ${number}`)) number++;
  return `${prefix} ${number}`;
}
