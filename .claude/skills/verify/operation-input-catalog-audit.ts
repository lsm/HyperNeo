import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mock } from 'bun:test';
import { z } from '../../../packages/daemon/node_modules/zod/index.js';
import { operationInputExample } from '../../../packages/daemon/src/lib/operations/input-example.ts';
import { getConfig } from '../../../packages/daemon/src/config.ts';
import { createOperationMcpHandler } from '../../../packages/daemon/src/lib/operations/mcp-adapter.ts';

const run = resolve(process.argv[2]);
assert.equal(process.env.NODE_ENV, 'test');
assert.equal(process.env.HOME, join(run, 'home'));
assert.equal(process.env.HYPERNEO_DATA_DIR, join(run, 'data'));
mock.module('../../../packages/daemon/src/lib/runtime-server/index.ts', () => ({
  createHttpWsServer: async () => ({ hostname: '127.0.0.1', port: 0, stop() {} }),
}));
mock.module('../../../packages/daemon/src/lib/messaging/session-door.ts', () => ({
  sessionDoorPath: () => join(run, 'data/session-door.sock'),
  startSessionDoor: async () => ({ close: async () => {} }),
}));
const { createDaemonApp } = await import('../../../packages/daemon/src/app.ts');
const app = await createDaemonApp({ config: getConfig({ port: 0, host: '127.0.0.1', dbPath: join(run, 'data/daemon.db') }), verbose: false });
mkdirSync(join(run, 'evidence'), { recursive: true });
try {
  const rows = [];
  const handler = createOperationMcpHandler(() => app.sessionManager.getOperationRegistry(), () => ({ sessionId: 'synthetic', role: 'neo' }));
  for (const operation of app.sessionManager.getOperationRegistry().entries) {
    const suffix = await operationInputExample(operation.inputSchema);
    const valid = suffix !== '' && (await operation.inputSchema.safeParseAsync(JSON.parse(suffix.split('\nExample input: ')[1]))).success;
    let refused = null;
    if (!(await operation.inputSchema.safeParseAsync({})).success) {
      const reply = await handler({ name: operation.name, input: {} });
      refused = JSON.parse(reply.content[0].text);
      assert.equal(reply.isError, true);
      assert.equal(refused.code, 'invalid_input');
      assert(refused.message.endsWith(suffix) && suffix !== '', operation.name);
    }
    rows.push({ name: operation.name, valid, example: suffix,
      refused,
      ...(!valid ? { schema: z.toJSONSchema(operation.inputSchema, { io: 'input', unrepresentable: 'any' }) } : {}),
    });
  }
  writeFileSync(join(run, 'evidence/catalog.json'), JSON.stringify({ kind: 'schema_audit', daemonProof: false, operations: rows }, null, 2));
  const missing = rows.filter(row => !row.valid);
  console.log(JSON.stringify({ schemas: rows.length, missing: missing.map(row => row.name) }));
  assert.equal(missing.length, 0, 'Schema audit only; socket transports are replaced and this is not daemon proof.');
} finally { await app.cleanup(); }
