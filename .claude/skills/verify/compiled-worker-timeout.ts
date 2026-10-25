import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');
const run = resolve(process.argv[2]);
const reproduce = process.argv.includes('--reproduce');
const daemon = join(root, 'packages/daemon');
const original = join(daemon, 'tests/unit/lib/runtime-worker-url.test.ts');
const fixture = join(daemon, `tests/unit/lib/runtime-worker-timeout-${process.pid}.test.ts`);
for (const dir of ['home', 'tmp', 'evidence']) mkdirSync(join(run, dir), { recursive: true });
const wrapper = "Bun.sleepSync(5500); const child=Bun.spawnSync([process.execPath,...process.argv.slice(1)],{stdout:'inherit',stderr:'inherit'}); process.exit(child.exitCode);";
const source = readFileSync(original, 'utf8');
const delayed = source.replace(
  "['build', '--compile',",
  `['-e', ${JSON.stringify(wrapper)}, 'build', '--compile',`
);
assert(delayed !== source, 'must inject delay into the actual compiler child');
const configured = reproduce
  ? delayed.replace(/\}, 50_000\);\s*$/, '}, 5000);\n')
  : delayed;
if (reproduce) assert(configured !== delayed, 'must restore the explicit 5-second limit');
writeFileSync(fixture, configured);
try {
  const result = spawnSync(
    process.execPath,
    ['test', '--preload=./tests/unit/setup.ts', fixture],
    {
      cwd: daemon,
      encoding: 'utf8',
      timeout: 120000,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        HOME: join(run, 'home'),
        USERPROFILE: join(run, 'home'),
        TEMP: join(run, 'tmp'),
        TMP: join(run, 'tmp'),
        TMPDIR: join(run, 'tmp'),
        NODE_ENV: 'test',
      },
    }
  );
  const output = result.stdout + result.stderr;
  const label = reproduce ? 'five-second-limit' : 'compile-budget';
  writeFileSync(join(run, `evidence/${label}.log`), output);
  process.stdout.write(output);
  assert.ifError(result.error);
  if (reproduce) {
    assert.notEqual(result.status, 0, '5-second limit must fail with a 5.5-second compiler delay');
    assert.match(output, /timed out after 5000ms/);
    console.log('PASS: reproduced the 5-second test timeout with injected compiler delay');
  } else {
    assert.equal(result.status, 0, 'the same delayed compile and worker assertions must pass');
    console.log('PASS: delayed compilation and both worker assertions fit the explicit budget');
  }
} finally {
  rmSync(fixture, { force: true });
}
