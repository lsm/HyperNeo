import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const startup = readFileSync(
  join(root, '.claude/skills/verify/compiled-worker-startup.ts'),
  'utf8'
);
const preflight = startup.match(/^    execFileSync\(join\(process\.env\.SystemRoot!.*$/m)?.[0];
assert(preflight, 'Must exercise the actual PowerShell preflight statement');
const source = join(run, 'slow-shell.ts');
writeFileSync(
  source,
  `
const lockIndex = process.argv.indexOf('--lock');
if (lockIndex !== -1) {
  require('node:fs').writeFileSync(process.argv[lockIndex + 1], 'ready');
  Bun.sleepSync(500);
} else {
  Bun.sleepSync(11_000);
}
`
);
const shell = join(run, 'System32/WindowsPowerShell/v1.0/powershell.exe');
execFileSync(process.execPath, ['build', '--compile', source, `--outfile=${shell}`], {
  env,
  stdio: 'pipe',
  timeout: 30_000,
});
const transpiler = new Bun.Transpiler({ loader: 'ts' });
const statement = reproduce ? preflight.replace('timeout: 30000', 'timeout: 10000') : preflight;
const probe = new Function(
  'execFileSync',
  'join',
  'process',
  'run',
  transpiler.transformSync(statement)
);
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
    const fixture = readFileSync(
      join(root, 'packages/daemon/tests/unit/lib/runtime-worker-url.test.ts'),
      'utf8'
    );
    const sdk = readFileSync(join(root, 'scripts/sdk-runtime-check.ts'), 'utf8');
    const cleanups = [
      ...fixture.matchAll(/^    rmSync\(run,.*$/gm),
      ...sdk.matchAll(/^    rmSync\(run,.*$/gm),
    ];
    assert.equal(cleanups.length, 3, 'Must exercise the fixture and both SDK cleanup statements');
    const results: Record<string, unknown>[] = [];
    evidence.cleanup = results;
    for (const [index, [cleanup]] of cleanups.entries()) {
      const cleanupStatement = reproduce
        ? cleanup.replace(', maxRetries: 5, retryDelay: 100', '')
        : cleanup;
      const directory = join(run, `locked-fixture-${index}`);
      const ready = join(run, `lock-ready-${index}`);
      mkdirSync(directory);
      const executable = join(directory, 'running.exe');
      copyFileSync(shell, executable);
      const locker = Bun.spawn([executable, '--lock', ready], {
        env,
        stdout: 'ignore',
        stderr: 'pipe',
      });
      const stderr = new Response(locker.stderr).text();
      try {
        const deadline = Date.now() + 10_000;
        while (!existsSync(ready) && locker.exitCode === null && Date.now() < deadline) {
          await Bun.sleep(10);
        }
        assert(existsSync(ready), 'Locker must execute its image before cleanup');
        assert.equal(locker.exitCode, null, 'Locker must still own its executable');
        let cleanupFailure: unknown;
        try {
          new Function('rmSync', 'run', cleanupStatement)(rmSync, directory);
        } catch (error) {
          cleanupFailure = error;
        }
        results.push({
          index,
          passed: cleanupFailure === undefined,
          remaining: existsSync(directory),
          code: (cleanupFailure as NodeJS.ErrnoException | undefined)?.code,
        });
        if (reproduce) {
          assert.match(
            (cleanupFailure as NodeJS.ErrnoException | undefined)?.code ?? '',
            /^(EBUSY|EPERM)$/
          );
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
    }
  } else {
    evidence.cleanup = { verified: false, reason: 'Windows directory locking requires Windows' };
  }
  evidence.passed = true;
} finally {
  writeFileSync(join(run, 'evidence/windows-resources.json'), JSON.stringify(evidence, null, 2));
  rmSync(join(run, 'System32'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  rmSync(source, { force: true });
}
console.log('PASS: compiled-smoke resource regression proof', JSON.stringify(evidence));
