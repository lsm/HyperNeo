import { expect, test } from 'bun:test';
import { resolveLocalPipeline } from './pipeline-route-resolver.ts';

const imports = `
  import superpipe from 'superpipe';
  import { defineOperation } from './registry.ts';
`;
const runner = `const run = superpipe({})('demo.read').input('input').endAsync('input');`;

test.each([
  [runner, 'run'],
  [runner, '() => run()'],
  [`${runner} const alias = run;`, 'alias'],
  [`${runner} const helper = () => run();`, '() => helper()'],
  [`${runner} const helper = async () => { return await run(); };`, 'helper'],
])('resolves an unconditional local pipeline through %s', (declarations, execute) => {
  const source = `${imports} ${declarations} defineOperation({ name: 'demo.read', execute: ${execute} });`;
  expect(resolveLocalPipeline(source, 'demo.read')).toEqual({ kind: 'named', name: 'demo.read' });
});

test.each([
  [runner, '() => condition && run()'],
  [runner, '() => { if (condition) return run(); return null; }'],
  [runner, '() => run'],
  [runner, '() => queue(() => run())'],
  [`${runner} let handler = run;`, 'handler'],
  [`${runner} const handler = (run) => run();`, 'handler'],
  [`${runner} const handler = () => handler();`, 'handler'],
  [`${runner} const factory = () => run;`, 'factory()'],
  [`import { handler } from './external.ts';`, 'handler'],
  [`const run = superpipe({})(name).end();`, 'run'],
])('leaves ambiguous local routes unknown through %s', (declarations, execute) => {
  const source = `${imports} ${declarations} defineOperation({ name: 'demo.read', execute: ${execute} });`;
  expect(resolveLocalPipeline(source, 'demo.read')).toEqual({ kind: 'unknown' });
});

test('does not count a shadowed superpipe import as a pipeline', () => {
  const source = `${imports}
    function setup(superpipe) {
      const run = superpipe({})('demo.read').end();
      return defineOperation({ name: 'demo.read', execute: run });
    }
  `;
  expect(resolveLocalPipeline(source, 'demo.read')).toEqual({ kind: 'unknown' });
});

test('leaves duplicate operation definitions unknown', () => {
  const source = `${imports} ${runner}
    defineOperation({ name: 'demo.read', execute: run });
    defineOperation({ name: 'demo.read', execute: run });
  `;
  expect(resolveLocalPipeline(source, 'demo.read')).toEqual({ kind: 'unknown' });
});

test('returns the actual pipeline name for a mismatched operation', () => {
  const source = `${imports} ${runner} defineOperation({ name: 'demo.other', execute: run });`;
  expect(resolveLocalPipeline(source, 'demo.other')).toEqual({ kind: 'named', name: 'demo.read' });
});
