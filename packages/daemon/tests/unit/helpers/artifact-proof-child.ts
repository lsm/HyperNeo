import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export function runArtifactProofChild(
  file: string,
  root: string,
  args: readonly string[] = []
): void {
  try {
    execFileSync('bun', [file, ...args, root], {
      env: {
        PATH: process.env.PATH,
        HOME: join(root, 'home'),
        TMPDIR: root,
        NODE_ENV: 'test',
        HYPERNEO_DATA_DIR: join(root, 'data'),
        LOG_LEVEL: 'warn',
      },
      timeout: 30000,
      stdio: 'pipe',
    });
  } catch (error) {
    let phases = 'unavailable (child did not record a phase)';
    try {
      phases = readFileSync(join(root, 'evidence/artifact-proof-phases.json'), 'utf8');
    } catch {}
    const child = error as Error & { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      `${String(error)}\nArtifact proof phases: ${phases}\nstdout: ${child.stdout?.toString() ?? ''}\nstderr: ${child.stderr?.toString() ?? ''}`,
      { cause: error }
    );
  }
}
