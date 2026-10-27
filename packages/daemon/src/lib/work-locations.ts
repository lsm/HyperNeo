import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { getDataDir } from './data-dir.ts';

interface WorkerWorkLocations {
  worktrees: string;
  evidence: string;
  builds: string;
  scratch: string;
  cache: string;
  ghConfig: string;
}

export function workerWorkLocations(root: string): WorkerWorkLocations {
  const dataDir = getDataDir();
  const key = `hn-${createHash('sha256').update(root).digest('hex').slice(0, 12)}`;
  const scratch = join(dataDir, 'work', 'scratch', key);
  return {
    worktrees: join(dataDir, 'worktrees'),
    evidence: join(dataDir, 'work', 'evidence', key),
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
    HYPERNEO_EVIDENCE: locations.evidence,
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
    `- Verification evidence: ${locations.evidence} (HYPERNEO_EVIDENCE)`,
    `- Build output: ${locations.builds} (HYPERNEO_BUILDS)`,
    `- Scratch: ${locations.scratch} (used for TMPDIR only when sandboxing is on)`,
    'Create output directories as needed. Existing worktrees stay in place.',
  ].join('\n');
}
