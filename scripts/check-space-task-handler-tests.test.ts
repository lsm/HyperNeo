import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const scriptPath = join(import.meta.dir, 'check-space-task-handler-tests.ts');

function git(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function writeProjectFile(cwd: string, path: string, contents: string) {
  const fullPath = join(cwd, path);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, contents);
}

function createRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'space-task-handler-gate-'));
  git(cwd, ['init', '-b', 'dev']);
  git(cwd, ['config', 'user.email', 'test@example.com']);
  git(cwd, ['config', 'user.name', 'Test User']);

  writeProjectFile(
    cwd,
    'packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts',
    "messageHub.onRequest('spaceTask.create', async () => {});\n"
  );
  writeProjectFile(
    cwd,
    'packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts',
    "await call('spaceTask.create', {});\n"
  );
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '-m', 'initial']);
  git(cwd, ['branch', 'origin/dev']);
  git(cwd, ['checkout', '-b', 'feature']);
  return cwd;
}

function runGate(cwd: string) {
  return spawnSync('bun', [scriptPath], {
    cwd,
    env: { ...process.env, SPACE_TASK_HANDLER_TEST_BASE: 'origin/dev' },
    encoding: 'utf8',
  });
}

describe('check-space-task-handler-tests', () => {
  const repos: string[] = [];

  beforeAll(() => {
    try {
      execFileSync('bun', ['--version'], { stdio: 'pipe' });
    } catch {
      throw new Error('bun is required for check-space-task-handler-tests tests');
    }
  });

  afterAll(() => {
    for (const repo of repos) rmSync(repo, { recursive: true, force: true });
  });

  it('passes when space-task-handlers.ts is unchanged', () => {
    const cwd = createRepo();
    repos.push(cwd);

    writeProjectFile(cwd, 'README.md', 'docs\n');
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-m', 'docs']);

    const result = runGate(cwd);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('flags new spaceTask handlers without tests', () => {
    const cwd = createRepo();
    repos.push(cwd);

    writeProjectFile(
      cwd,
      'packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts',
      "messageHub.onRequest('spaceTask.create', async () => {});\n" +
        "messageHub.onRequest('spaceTask.publish', async () => {});\n"
    );
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-m', 'add handler']);

    const result = runGate(cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('spaceTask.publish');
  });

  it('passes when each spaceTask handler appears in handler tests', () => {
    const cwd = createRepo();
    repos.push(cwd);

    writeProjectFile(
      cwd,
      'packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts',
      "messageHub.onRequest('spaceTask.create', async () => {});\n" +
        "messageHub.onRequest('spaceTask.publish', async () => {});\n"
    );
    writeProjectFile(
      cwd,
      'packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts',
      "await call('spaceTask.create', {});\nawait call('spaceTask.publish', {});\n"
    );
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-m', 'add handler and test']);

    const result = runGate(cwd);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
