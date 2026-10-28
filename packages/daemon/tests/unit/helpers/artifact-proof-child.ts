import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export function runArtifactProofChild(file: string, root: string): void {
  execFileSync('bun', [file, root], {
    env: {
      PATH: process.env.PATH,
      HOME: join(root, 'home'),
      TMPDIR: root,
      NODE_ENV: 'test',
      HYPERNEO_DATA_DIR: join(root, 'data'),
    },
    timeout: 30000,
    stdio: 'pipe',
  });
}
