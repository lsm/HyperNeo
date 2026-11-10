import { afterEach, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const fixtures: string[] = [];

afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runTypecheck(failingCompiler?: string) {
  const directory = mkdtempSync(join(tmpdir(), 'hyperneo-typecheck-'));
  fixtures.push(directory);
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ type: 'module', scripts }));
  for (const compiler of ['typescript7', 'typescript']) {
    const bin = join(directory, 'node_modules', compiler, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, 'tsc'),
      `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.TYPECHECK_FIXTURE_TRACE, JSON.stringify({ compiler: '${compiler}', args: process.argv.slice(2) }) + '\\n');
process.exit(process.env.TYPECHECK_FIXTURE_FAIL === '${compiler}' ? 2 : 0);`
    );
  }
  const trace = join(directory, 'trace.jsonl');
  const result = spawnSync(process.execPath, ['run', 'typecheck'], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
      TYPECHECK_FIXTURE_TRACE: trace,
      TYPECHECK_FIXTURE_FAIL: failingCompiler ?? '',
    },
  });
  const calls = readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  return { ...result, calls };
}

it('runs the workspace compiler and the standard daemon compiler', () => {
  const result = runTypecheck();
  expect(result.status).toBe(0);
  expect(result.calls).toEqual([
    { compiler: 'typescript7', args: ['--build', '--noEmit'] },
    {
      compiler: 'typescript',
      args: ['--project', 'packages/daemon/tsconfig.json', '--noEmit'],
    },
  ]);
});

it('fails when only the standard daemon compiler rejects the source', () => {
  expect(runTypecheck('typescript').status).toBe(2);
});

it('stops when the workspace compiler rejects the source', () => {
  const result = runTypecheck('typescript7');
  expect(result.status).toBe(2);
  expect(result.calls).toHaveLength(1);
});
