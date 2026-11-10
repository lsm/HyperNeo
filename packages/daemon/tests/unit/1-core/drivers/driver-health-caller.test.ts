import { afterEach, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { DriverHealth } from '@hyperneo/shared/types/settings';
import { Database } from '../../../../src/storage/sqlite-compat.ts';
import { createDriverHealthRuntime } from '../../../../src/lib/drivers/driver-health-runtime.ts';
import type { FamilyOperationContext } from '../../../../src/lib/rpc-handlers/family-operations/context.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { createOperationMcpHandler } from '../../../../src/lib/operations/mcp-adapter.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';

vi.mock('../../../../src/lib/drivers/driver-health-probes.ts', () => ({
  LOCAL_HEALTH_DRIVERS: ['hyperneo'],
  createDriverHealthProbe: () => async () => ({
    status: 'ok',
    reason: 'Readable.',
    clientVersions: { daemon: '1.0.0' },
  }),
}));
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(
    "CREATE TABLE neo_session_bindings(session_id TEXT, concern_id TEXT, kind TEXT); INSERT INTO neo_session_bindings VALUES ('synthetic-neo', NULL, 'neo')"
  );
  const stored: Record<string, DriverHealth> = {
    hyperneo: {
      status: 'ok',
      reason: 'Readable.',
      clientVersions: { daemon: '1.0.0' },
      checkedAt: 1,
      unverifiedVersion: true,
    },
  };
  const context = {
    deps: {
      db: {
        getDatabase: () => db,
        gateway: {
          call: async (_op: unknown, method: string, id: string, health: DriverHealth) => {
            if (method === 'readDriverHealth') return structuredClone(stored);
            if (method === 'driverHealth') {
              stored[id] = structuredClone(health);
              return;
            }
            throw new Error('Unexpected writer call');
          },
        },
      },
      jobProcessor: { register: () => {} },
    },
  } as unknown as FamilyOperationContext;
  const registry = createOperationRegistry([
    createDriverHealthRuntime(context, () => []).operation,
  ]);
  return { registry, stored };
}
const input = {
  action: 'verified',
  adapter: 'hyperneo',
  journey: 'synthetic-passed-journey',
  clientVersions: { daemon: '1.0.0' },
};

test.each([
  'workflow_worker',
  'direct_task_worker',
  'long_term_agent',
  'universal_read',
  undefined,
  'neo',
] as const)(
  'direct MCP invocation by unbound %s cannot forge driver verification',
  async (role) => {
    const f = fixture();
    const before = structuredClone(f.stored);
    const invoke = createOperationMcpHandler(f.registry, () => ({
      sessionId: 'synthetic-worker',
      ...(role ? { role } : {}),
    }));
    const result = await invoke({
      name: 'work.health',
      input: { ...input, role: 'neo', sessionId: 'synthetic-neo', principal: 'local' },
    });
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      ok: false,
      reason: 'human_or_neo_only',
    });
    expect(f.stored).toEqual(before);
  }
);

test('a bound Neo can record the matching tested client version through MCP', async () => {
  const f = fixture();
  const invoke = createOperationMcpHandler(f.registry, () => ({
    sessionId: 'synthetic-neo',
    role: 'neo',
  }));
  expect(JSON.parse((await invoke({ name: 'work.health', input })).content[0].text)).toMatchObject({
    ok: true,
  });
  expect(f.stored.hyperneo).toMatchObject({
    verifiedVersions: { daemon: '1.0.0' },
    unverifiedVersion: false,
  });
});

test('local human RPC remains allowed while an untrusted RPC caller is refused', async () => {
  const f = fixture();
  const denied = await invokeOperation(f.registry, 'work.health', input, { source: 'rpc' });
  expect(denied).toMatchObject({
    kind: 'completed',
    value: { ok: false, reason: 'human_or_neo_only' },
  });
  expect(f.stored.hyperneo.unverifiedVersion).toBe(true);
  const allowed = await invokeOperation(f.registry, 'work.health', input, {
    source: 'rpc',
    principal: 'local',
  });
  expect(allowed).toMatchObject({ kind: 'completed', value: { ok: true } });
  expect(f.stored.hyperneo.unverifiedVersion).toBe(false);
});
