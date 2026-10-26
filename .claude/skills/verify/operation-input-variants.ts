import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDaemonApp } from '../../../packages/daemon/src/app.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';
import fixtures from '../../../packages/daemon/tests/unit/1-core/operations/fixtures/refused-inputs.json';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mkdirSync(join(run, 'evidence'), { recursive: true });
const app = await createDaemonApp({ config: getConfig({ port: 9376, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
const evidence: unknown[] = [];
try {
  await app.spaceRuntimeService.ready();
  const handler = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: 'synthetic-neo', role: 'neo' }));
  for (const fixture of fixtures) {
    const canonical = await handler({ name: fixture.operation, input: fixture.canonical });
    const variant = await handler({ name: fixture.operation, input: fixture.input });
    evidence.push({ operation: fixture.operation, canonical, variant });
    assert.notEqual(canonical.isError, true, JSON.stringify(canonical));
    assert.deepEqual(variant, canonical);
  }
  for (const [name, canonicalInput, variantInput] of [
    ['neo.question.get', { questionId: '123' }, { questionId: 123 }],
    ['work.find', { limit: 2 }, { limit: '2' }],
  ] as const) {
    const canonical = await handler({ name, input: canonicalInput });
    const variant = await handler({ name, input: variantInput });
    evidence.push({ name, canonical, variant });
    assert.notEqual(canonical.isError, true, JSON.stringify(canonical));
    assert.deepEqual(variant, canonical);
  }
  const conflict = await handler({ name: 'neo.question.get', input: { id: 'a', questionId: 'b' } });
  evidence.push({ conflict });
  assert.equal(conflict.isError, true);
  assert.match(conflict.content[0].text, /Conflicting/);
  const invalid = await handler({ name: 'neo.coding.write.plan', input: { repo: 'invalid', targets: [] } });
  evidence.push({ invalid });
  assert.equal(invalid.isError, true);
  console.log('PASS: real isolated daemon MCP accepts observed aliases, rejects conflicts and invalid repo/empty candidates.');
} finally {
  writeFileSync(join(run, 'evidence/observed.json'), JSON.stringify(evidence, null, 2));
  await app.cleanup();
}

