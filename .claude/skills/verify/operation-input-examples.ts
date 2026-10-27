import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import fixtures from '../../../packages/daemon/tests/unit/1-core/operations/fixtures/refused-validation-errors.json';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const rows: unknown[] = [];
try {
  await app.spaceRuntimeService.ready();
  const registry = app.sessionManager.getOperationRegistry();
  const handler = createOperationMcpHandler(registry, () => ({ sessionId: 'synthetic-neo', role: 'neo' }));
  for (const fixture of fixtures) {
    const reply = await handler({ name: fixture.operation, input: fixture.input });
    rows.push({ fixture, reply });
    assert.equal(reply.isError, true, fixture.operation);
    const error = JSON.parse(reply.content[0].text);
    assert.equal(error.code, 'invalid_input');
    const parts = error.message.split('\nExample input: ');
    assert.equal(parts.length, 2);
    const example = JSON.parse(parts[1]);
    assert((await registry.get(fixture.operation)!.inputSchema.safeParseAsync(example)).success);
    if (fixture.operation === 'neo.todo.add') assert.match(error.message, /needs a target/);
  }
  console.log('PASS: real isolated daemon MCP refuses invalid inputs with exactly one schema-valid example, retaining the missing-target error.');
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(rows, null, 2));
  await app.cleanup();
}
