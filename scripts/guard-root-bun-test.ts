import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { cwd, env, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const currentDir = realpathSync(cwd());

if (currentDir === repoRoot && env.HYPERNEO_ALLOW_ROOT_TEST !== '1') {
  console.error("Error: This is a monorepo. Do not run 'bun test' from the root.");
  console.error('');
  console.error('For daemon unit shards: ./scripts/test-daemon.sh');
  console.error(
    'For targeted daemon tests: cd packages/daemon && bun test ./tests/unit/some-test.test.ts'
  );
  console.error('For web tests: cd packages/web && bunx vitest run');
  console.error('For e2e tests: make run-e2e TEST=tests/features/foo.e2e.ts');
  console.error('See CLAUDE.md for more details.');
  exit(1);
}
