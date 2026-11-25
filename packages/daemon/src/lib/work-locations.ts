import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getDataDir } from './data-dir.ts';

interface WorkerWorkLocations {
  worktrees: string;
  builds: string;
  scratch: string;
  cache: string;
  ghConfig: string;
}

const evidenceDir = () => join(getDataDir(), 'work', 'evidence');

export const todoEvidenceFile = (todoId: string) => join(evidenceDir(), todoId, 'result.md');

export const workerWorkKey = (root: string) =>
  `hn-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;

export function workerWorkLocations(root: string): WorkerWorkLocations {
  const dataDir = getDataDir();
  const key = workerWorkKey(root);
  const scratch = join(dataDir, 'work', 'scratch', key);
  return {
    worktrees: join(dataDir, 'worktrees'),
    builds: join(dataDir, 'work', 'builds', key),
    scratch,
    cache: join(scratch, 'cache'),
    ghConfig: join(dataDir, 'work', 'gh-config', key),
  };
}

export function workerWorkEnvironment(root: string) {
  const locations = workerWorkLocations(root);
  return {
    HYPERNEO_WORKTREES: locations.worktrees,
    HYPERNEO_BUILDS: locations.builds,
  };
}

export function workerWorkLocationsBrief(root: string) {
  const locations = workerWorkLocations(root);
  return [
    '## Runtime Location',
    '',
    `- Worktree: ${root}`,
    `- New worktrees: ${locations.worktrees} (HYPERNEO_WORKTREES)`,
    `- Build output: ${locations.builds} (HYPERNEO_BUILDS)`,
    `- Scratch: ${locations.scratch} (used for TMPDIR only when sandboxing is on)`,
    'Human-readable reports belong in ~/HyperNeo/<matter>/ or the configured user folder. Link the report by its full absolute path in the card or message.',
    'Create output directories as needed. Existing worktrees stay in place.',
    'Read card links with hyperneo read <link> using the issuing daemon data directory and its read-only agent credential.',
  ].join('\n');
}
