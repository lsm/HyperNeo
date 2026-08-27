import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

function runGate(cwd: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync('bun', [scriptPath], {
    cwd,
    env: { ...process.env, SPACE_TASK_HANDLER_TEST_BASE: 'origin/dev', ...env },
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

  it('passes when space-task-handlers.ts and handler tests are unchanged', () => {
    const cwd = createRepo();
    repos.push(cwd);

    writeProjectFile(cwd, 'README.md', 'docs\n');
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-m', 'docs']);

    const result = runGate(cwd);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('flags handler test regressions even when the handler file is unchanged', () => {
    const cwd = createRepo();
    repos.push(cwd);

    writeProjectFile(
      cwd,
      'packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts',
      "it.skip('covers create', async () => { await call('spaceTask.create', {}); });\n"
    );
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-m', 'skip handler test']);

    const result = runGate(cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('spaceTask.create');
  });

  it('skips local checks when the comparison ref is unavailable', () => {
    const cwd = createRepo();
    repos.push(cwd);

    git(cwd, ['branch', '-D', 'origin/dev']);

    const result = runGate(cwd, { CI: '' });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Skipping space task handler test gate for this local check.');
  });

  it('fails CI checks when the comparison ref is unavailable', () => {
    const cwd = createRepo();
    repos.push(cwd);

    git(cwd, ['branch', '-D', 'origin/dev']);

    const result = runGate(cwd, { CI: 'true' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unable to compare branch against origin/dev');
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

  it('flags handlers that only appear in descriptions or comments', () => {
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
      "describe('spaceTask.publish', () => {});\n// await call('spaceTask.publish', {});\n" +
        "it('covers create', async () => { await call('spaceTask.create', {}); });\n"
    );
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-m', 'mention handler']);

    const result = runGate(cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('spaceTask.publish');
  });

  it('flags handlers that are called only inside non-executed functions', () => {
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
      "it('covers create', async () => {\n" +
        "await call('spaceTask.create', {});\n" +
        'async function cover() {\n' +
        "await call('spaceTask.publish', {});\n" +
        '}\n' +
        '});\n'
    );
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-m', 'wrap handler call']);

    const result = runGate(cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('spaceTask.publish');
  });

  it('flags handlers that are called only in skipped tests', () => {
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
      "it('covers create', async () => { await call('spaceTask.create', {}); });\n" +
        "it.skip('covers publish', async () => { await call('spaceTask.publish', {}); });\n"
    );
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-m', 'skip handler test']);

    const result = runGate(cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('spaceTask.publish');
  });

  it('fails when the handler test file contains focused tests', () => {
    const cwd = createRepo();
    repos.push(cwd);

    writeProjectFile(
      cwd,
      'packages/daemon/src/lib/rpc-handlers/space-task-handlers.ts',
      "messageHub.onRequest('spaceTask.create', async () => {});\n"
    );
    writeProjectFile(
      cwd,
      'packages/daemon/tests/unit/2-handlers/rpc-handlers/space-task-handlers.test.ts',
      "it.only('covers create', async () => { await call('spaceTask.create', {}); });\n"
    );
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-m', 'focus handler test']);

    const result = runGate(cwd);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Focused tests are not allowed');
  });

  it('passes when each spaceTask handler is called in handler tests', () => {
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
      "it('covers create', async () => {\nconst result = await call('spaceTask.create', {});\n});\n" +
        "it('covers publish', async () => {\nawait expect(call('spaceTask.publish', {})).resolves.toBeDefined();\n});\n"
    );
    git(cwd, ['add', '.']);
    git(cwd, ['commit', '-m', 'add handler and test']);

    const result = runGate(cwd);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
