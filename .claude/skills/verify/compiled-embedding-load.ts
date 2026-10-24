import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compileArgs } from '../../../scripts/compiled-worker-entrypoints.ts';

const platform = process.platform === 'win32' ? 'windows' : process.platform;
const [directory, target = `bun-${platform}-${process.arch}`] = process.argv.slice(2);
assert(directory, 'usage: compiled-embedding-load.ts <fresh-run-dir> [bun-target]');
const run = resolve(directory);
assert(!existsSync(run), 'Use a fresh run directory');
for (const part of ['home', 'data', 'tmp', 'evidence']) mkdirSync(join(run, part), { recursive: true });
const binary = join(run, target.includes('windows') ? 'embedding-fixture.exe' : 'embedding-fixture');
execFileSync(process.execPath, [...compileArgs(target), `--outfile=${binary}`, 'packages/daemon/tests/unit/lib/compiled-embedding-fixture.ts'], { stdio: 'inherit' });
const rosetta = target === 'bun-darwin-x64' && process.platform === 'darwin' && process.arch === 'arm64';
const command = rosetta ? ['/usr/bin/arch', '-x86_64', binary] : [binary];
const result = spawnSync(command[0], [...command.slice(1), join(run, 'data/cache/transformers')], {
  encoding: 'utf8',
  timeout: 600000,
  env: {
    HOME: join(run, 'home'),
    USERPROFILE: join(run, 'home'),
    PATH: process.platform === 'win32' ? process.env.SystemRoot + '\\System32' : '/usr/bin:/bin:/usr/sbin',
    SystemRoot: process.env.SystemRoot,
    TEMP: join(run, 'tmp'),
    TMP: join(run, 'tmp'),
    TMPDIR: join(run, 'tmp'),
    HYPERNEO_DATA_DIR: join(run, 'data'),
    NODE_ENV: 'test',
  },
});
const evidence = { target, rosetta, status: result.status, stdout: result.stdout, stderr: result.stderr };
writeFileSync(join(run, 'evidence/compiled-embedding-load.json'), JSON.stringify(evidence, null, 2));
assert.equal(result.status, 0, `Compiled embedding load failed:\n${result.stderr}`);
const observed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
assert.equal(observed.dimensions, 384);
assert(Math.abs(observed.norm - 1) < 1e-3, `Embedding norm ${observed.norm}`);
console.log(`PASS: ${target} compiled binary downloads and loads the embedding runtime and model in a fresh data dir and returns a normalized 384-dimensional vector`);
