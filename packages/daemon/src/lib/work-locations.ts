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
