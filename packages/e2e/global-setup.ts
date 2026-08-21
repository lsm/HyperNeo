import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { existsSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';

import { e2eWorkspaceDir } from './test-env';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function globalSetup() {
  if (!process.env.PLAYWRIGHT_BASE_URL && !process.env.E2E_PORT) {
    let currentDir = __dirname;
    for (let i = 0; i < 5; i++) {
      const lockFile = join(currentDir, 'tmp', '.dev-server-running');
      if (existsSync(lockFile)) {
        const port = readFileSync(lockFile, 'utf-8').trim();
        console.error(`
ERROR: A development server appears to be running (lock file found).

To run E2E tests with an auto-started server on a random port, use:
  make run-e2e TEST=tests/your-test.e2e.ts

To run against your existing dev server, use:
  make self-test TEST=tests/your-test.e2e.ts     (for 'make self' on port 9983)

Or set PLAYWRIGHT_BASE_URL explicitly:
  PLAYWRIGHT_BASE_URL=http://localhost:${port || 'YOUR_PORT'} bunx playwright test tests/your-test.e2e.ts
`);
        process.exit(1);
      }
      const parentDir = dirname(currentDir);
      if (parentDir === currentDir) break;
      currentDir = parentDir;
    }
  }

  if (e2eWorkspaceDir && existsSync(e2eWorkspaceDir)) {
    console.log(`\n🔧 Initializing workspace as git repo: ${e2eWorkspaceDir}`);
    try {
      execSync('git init', { cwd: e2eWorkspaceDir, stdio: 'inherit' });
      execSync('git config user.email "e2e@hyperneo.test"', {
        cwd: e2eWorkspaceDir,
        stdio: 'inherit',
      });
      execSync('git config user.name "HyperNeo E2E"', { cwd: e2eWorkspaceDir, stdio: 'inherit' });
      execSync('git add -A && git commit -m "Initial commit for E2E testing"', {
        cwd: e2eWorkspaceDir,
        stdio: 'inherit',
        shell: '/bin/bash',
      });
      console.log('✅ Workspace initialized as git repo\n');
    } catch (error) {
      console.warn('⚠️  Failed to initialize git repo in workspace (continuing):', error);
    }

    try {
      const pkgJson = JSON.stringify({ name: 'e2e-test-workspace', version: '0.0.1' }, null, 2);
      writeFileSync(join(e2eWorkspaceDir, 'package.json'), pkgJson, 'utf-8');
      writeFileSync(join(e2eWorkspaceDir, 'README.md'), '# E2E Test Workspace\n', 'utf-8');
      console.log('✅ Created test files in workspace for FileIndex\n');
    } catch (error) {
      console.warn('⚠️  Failed to create test files in workspace (continuing):', error);
    }
  }

  if (process.env.CI) {
    console.log('\n🔵 CI environment detected - skipping worktree cleanup\n');
    return;
  }

  console.log('\n🧹 Pre-Test Cleanup (preventing nested worktrees)');
  console.log('================================================\n');

  try {
    const projectRoot = join(__dirname, '..', '..');
    const worktreesDir = join(projectRoot, '.worktrees');

    if (!existsSync(worktreesDir)) {
      console.log('✅ Clean state - no .worktrees directory\n');
      return;
    }

    const worktrees = readdirSync(worktreesDir);
    console.log(`⚠️  Found ${worktrees.length} existing worktree(s) - cleaning...`);

    execSync('git worktree prune', { cwd: projectRoot, stdio: 'inherit' });

    try {
      execSync('git branch --list "session/*" | xargs git branch -D 2>/dev/null || true', {
        cwd: projectRoot,
        shell: '/bin/bash',
        stdio: 'inherit',
      });
    } catch {}

    rmSync(worktreesDir, { recursive: true, force: true });

    console.log('✅ Pre-test cleanup complete\n');
  } catch (error) {
    console.warn('⚠️  Pre-test cleanup failed (continuing anyway):', error);
  }
}

export default globalSetup;
