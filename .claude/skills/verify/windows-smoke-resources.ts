import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const run = resolve(process.argv[2]);
const reproduce = process.argv.includes('--reproduce');
assert(!existsSync(run), 'Use a fresh run directory');
for (const part of ['home', 'tmp', 'evidence', 'System32/WindowsPowerShell/v1.0']) {
  mkdirSync(join(run, part), { recursive: true });
}
const env = {
  HOME: join(run, 'home'),
  USERPROFILE: join(run, 'home'),
  TEMP: join(run, 'tmp'),
  TMP: join(run, 'tmp'),
  TMPDIR: join(run, 'tmp'),
  SystemRoot: process.env.SystemRoot,
};
const startup = readFileSync(join(root, '.claude/skills/verify/compiled-worker-startup.ts'), 'utf8');
const preflight = startup.match(/^    execFileSync\(join\(process\.env\.SystemRoot!.*$/m)?.[0];
assert(preflight, 'Must exercise the actual PowerShell preflight statement');
const source = join(run, 'slow-shell.ts');
writeFileSync(source, 'Bun.sleepSync(11_000);\n');
const shell = join(run, 'System32/WindowsPowerShell/v1.0/powershell.exe');
execFileSync(process.execPath, ['build', '--compile', source, `--outfile=${shell}`], {
  env,
  stdio: 'pipe',
  timeout: 30_000,
});
const transpiler = new Bun.Transpiler({ loader: 'ts' });
const statement = reproduce ? preflight.replace('timeout: 30000', 'timeout: 10000') : preflight;
const probe = new Function('execFileSync', 'join', 'process', 'run', transpiler.transformSync(statement));
const evidence: Record<string, unknown> = { reproduce };
try {
  const started = Date.now();
  let failure: unknown;
  try {
    probe(execFileSync, join, { env: { SystemRoot: run } }, run);
  } catch (error) {
    failure = error;
  }
  evidence.preflight = { elapsedMs: Date.now() - started, passed: failure === undefined };
  if (reproduce) {
    assert.equal((failure as NodeJS.ErrnoException | undefined)?.code, 'ETIMEDOUT');
  } else {
    assert.ifError(failure);
  }
  if (process.platform === 'win32') {
    const fixture = readFileSync(join(root, 'packages/daemon/tests/unit/lib/runtime-worker-url.test.ts'), 'utf8');
    const cleanup = fixture.match(/^    rmSync\(run,.*$/m)?.[0];
    assert(cleanup, 'Must exercise the actual compiled-fixture cleanup statement');
    const cleanupStatement = reproduce
      ? cleanup.replace(', maxRetries: 5, retryDelay: 100', '')
      : cleanup;
    const directory = join(run, 'locked-fixture');
    const ready = join(run, 'lock-ready');
    mkdirSync(directory);
    const locker = Bun.spawn([
      process.execPath,
      '-e',
      'process.chdir(process.argv[1]); require("node:fs").writeFileSync(process.argv[2], "ready"); setTimeout(() => process.exit(0), 500);',
      directory,
      ready,
    ], { env, stdout: 'ignore', stderr: 'pipe' });
    const stderr = new Response(locker.stderr).text();
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(ready) && locker.exitCode === null && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      assert(existsSync(ready), 'Locker must acquire its directory before cleanup');
      let cleanupFailure: unknown;
      try {
        new Function('rmSync', 'run', cleanupStatement)(rmSync, directory);
      } catch (error) {
        cleanupFailure = error;
      }
      evidence.cleanup = { passed: cleanupFailure === undefined, remaining: existsSync(directory) };
      if (reproduce) {
        assert.equal((cleanupFailure as NodeJS.ErrnoException | undefined)?.code, 'EBUSY');
      } else {
        assert.ifError(cleanupFailure);
        assert(!existsSync(directory), 'Cleanup must remove the fixture after the handle closes');
      }
    } finally {
      locker.kill();
      await locker.exited;
      evidence.lockerStderr = await stderr;
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  } else {
    evidence.cleanup = { verified: false, reason: 'Windows directory locking requires Windows' };
  }
  evidence.passed = true;
} finally {
  writeFileSync(join(run, 'evidence/windows-resources.json'), JSON.stringify(evidence, null, 2));
  rmSync(shell, { force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(source, { force: true });
}
console.log('PASS: compiled-smoke resource regression proof', JSON.stringify(evidence));
