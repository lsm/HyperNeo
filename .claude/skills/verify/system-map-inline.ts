import { countPipelineRoutes } from '../../../scripts/system-map.ts';

const cases = [
  [`superpipe({})('demo.maybe').input(f as G).end()()`, 0],
  [`((superpipe({})('demo.maybe') as Builder).input(f as G).end() as Runner)()`, 0],
  [`(superpipe({})('demo.maybe').input?.(f) as Builder).end()()`, 1],
] as const;

let failures = 0;
for (const [expression, expected] of cases) {
  const source = `import superpipe from 'superpipe';
    defineOperation({ name: 'demo.maybe', execute: () => ${expression} });`;
  const result = countPipelineRoutes(new Map([['packages/demo/src/added.ts', source]]), true);
  console.log(`unreadable=${result.unreadable} expected=${expected}`);
  if (result.unreadable !== expected) failures++;
}
console.log(`inline cases=${cases.length} failures=${failures}`);
if (failures) process.exitCode = 1;
