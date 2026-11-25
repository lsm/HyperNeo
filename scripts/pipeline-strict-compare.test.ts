import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { compareStrictPipelineSources } from './pipeline-strict-compare.ts';

const file = 'packages/demo/src/operations.ts';
const source = (execute: string) => `
  const run = superpipe({})('demo.read').end();
  defineOperation({ name: 'demo.read', execute: () => ${execute} });
`;
const sources = (text: string) => new Map([[file, text]]);

test('compareStrictPipelineSources uses strict verdicts on both sides', () => {
  const conditional = sources(source('condition && run()'));
  expect(compareStrictPipelineSources(conditional, conditional).changes).toEqual([]);
  const result = compareStrictPipelineSources(sources(source('run()')), conditional);
  expect(result.regressions).toEqual([
    { file, name: 'demo.read', before: 'named', after: 'unreadable' },
  ]);
  expect(compareStrictPipelineSources(conditional, sources(source('run()'))).regressions).toEqual(
    []
  );
});

test('strict comparison resolves imports using each side of the comparison', () => {
  const entry = `
    import { make } from './factory.ts';
    import { defineOperation } from './registry.ts';
    defineOperation({ name: 'demo.read', execute: make() });
  `;
  const head = sources(entry);
  const base = new Map(head).set(
    'packages/demo/src/factory.ts',
    `import pipeline from 'superpipe';
     export function make() { return pipeline({})('demo.read').end(); }`
  );
  expect(compareStrictPipelineSources(base, head).regressions).toEqual([
    { file, name: 'demo.read', before: 'named', after: 'unreadable' },
  ]);
});

test('strict comparison CLI reports regressions for two repositories', () => {
  const root = mkdtempSync(join(tmpdir(), 'pipeline-compare-'));
  try {
    const env = { HOME: root, PATH: process.env.PATH ?? '', NODE_ENV: 'test' };
    const paths = ['base', 'head'].map((name, index) => {
      const repo = join(root, name);
      mkdirSync(repo);
      expect(Bun.spawnSync(['git', 'init', '-q'], { cwd: repo, env }).exitCode).toBe(0);
      const target = join(repo, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source(index ? 'condition && run()' : 'run()'));
      return repo;
    });
    const run = Bun.spawnSync(
      [process.execPath, join(import.meta.dir, 'pipeline-strict-compare.ts'), ...paths],
      {
        cwd: root,
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    );
    expect(run.exitCode).toBe(1);
    const result = JSON.parse(run.stdout.toString());
    expect(result.regressions).toEqual([
      { file, name: 'demo.read', before: 'named', after: 'unreadable' },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
