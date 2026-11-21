import { countPipelineRoutes } from '../../../scripts/system-map.ts';

const queue = `
  const run = superpipe({})('demo.maybe').end();
  let pending = Promise.resolve();
  const serialize = (action) => {
    const result = pending.then(action);
    pending = result.then(() => undefined, () => undefined);
    return result;
  };
`;

const cases = [
  [
    '(input) => make().go(input)',
    0,
    `${queue}
      const make = () => ({ go: (input) => serialize(() => run(input)) });`,
  ],
  [
    '() => make().go(sideEffect())',
    1,
    `${queue}
      const make = () => ({ go: (input) => serialize(() => run(input)) });`,
  ],

  [
    '() => make().go()',
    0,
    `const run = superpipe({})('demo.maybe').end();
     const make = () => { return { go: () => run() }; };`,
  ],
  [
    '() => make().go()',
    1,
    `const run = superpipe({})('demo.maybe').end();
     const make = () => { if (skip) return {}; return { go: () => run() }; };`,
  ],
  [`() => superpipe({})('demo.maybe').input(f as G).end()()`, 0],
  [`() => ((superpipe({})('demo.maybe') as Builder).input(f as G).end() as Runner)()`, 0],
  [`() => (superpipe({})('demo.maybe').input?.(f) as Builder).end()()`, 1],
  [`() => { log(); return superpipe({})('demo.maybe').end()(); }`, 0],
  [`() => { if (condition) return null; return superpipe({})('demo.maybe').end()(); }`, 1],
  ['() => serialize(() => run())', 0, queue],
  ['() => serialize(() => serialize(() => run()))', 1, queue],
] as const;

let failures = 0;
for (const [execute, expected, setup = ''] of cases) {
  const source = `import superpipe from 'superpipe';
    import { defineOperation } from './registry.ts';
    ${setup}
    defineOperation({ name: 'demo.maybe', execute: ${execute} });`;
  const result = countPipelineRoutes(new Map([['packages/demo/src/added.ts', source]]), true);
  console.log(`unreadable=${result.unreadable} expected=${expected}`);
  if (result.unreadable !== expected) failures++;
}
const directory = 'packages/daemon/src/storage/db-gateway';
const worker = new Map([
  [`${directory}/db-gateway-worker.ts`, `import { DB_OPS } from './db-ops.ts';
    const command = DB_OPS.get(name); if (!command) throw new Error('unknown');
    command.run(db, args, changes);`],
  [`${directory}/db-ops.ts`, `import { query } from './read.ts';
    export const DB_OPS = new Map([query].map((op) => [op.name, op]));`],
  [`${directory}/query.ts`, `import superpipe from 'superpipe';
    export const runQuery = superpipe({})('demo.read').end();`],
]);
const route = `${directory}/route.ts`;
const routeSource = `import { defineOperation } from './registry.ts';
  import { gatewayFor } from './db-gateway.ts'; import { query } from './read.ts';
  defineOperation({ name: 'demo.read', execute: (input) => gatewayFor(db).call(query, 'read', input) });`;
worker.set(route, routeSource);
for (const [argument, expected] of [['input', 0], ['sideEffect()', 1]] as const) {
  worker.set(`${directory}/read.ts`, `import { defineRepositoryOp } from './db-op.ts';
    import { runQuery } from './query.ts'; class Query { read(input) { return runQuery(${argument}); } }
    export const query = defineRepositoryOp('domain.query', 'read', Query, ['read']);`);
  const result = countPipelineRoutes(new Map([[route, routeSource]]), true, worker);
  console.log(`worker unreadable=${result.unreadable} expected=${expected}`);
  if (result.unreadable !== expected) failures++;
}
console.log(`inline cases=${cases.length} failures=${failures}`);
if (failures) process.exitCode = 1;
