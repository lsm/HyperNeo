import { expect, spyOn, test } from 'bun:test';
import { ProcessingStateManager } from '../../../../src/lib/agent/processing-state-manager.ts';
import { planSessionDoorCall } from '../../../../src/lib/messaging/session-door.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import {
  createRestartReservationOperation,
  planRestartReservation,
  RestartReservation,
  restartReservation,
} from '../../../../src/lib/system/restart-reservation.ts';
import {
  createTestDb,
  createTestInternalEventBus,
  createTestSession,
} from '../../../helpers/database.ts';

const clear = { neo: 'idle', streams: false, speech: false } as const;
const caller = {
  source: 'mcp',
  principal: 'session-door',
  sessionId: 'cli',
  device: { deviceId: 'fixture', kind: 'human' },
} as const;

test('only all-clear facts admit a restart', () => {
  expect(planRestartReservation(clear)).toEqual({ value: true });
  for (const facts of [
    { ...clear, neo: 'busy' },
    { ...clear, neo: 'unavailable' },
    { ...clear, streams: true },
    { ...clear, speech: true },
  ]) {
    expect(planRestartReservation(facts)).toHaveProperty('reason');
  }
});

test('reservation expires without extending on a repeated request', () => {
  const reservation = new RestartReservation();
  expect(reservation.reserve(() => clear, 100)).toEqual({
    ok: true,
    pid: process.pid,
    expiresAt: 15_100,
  });
  expect(reservation.reserve(() => clear, 200)).toEqual({ ok: false, reason: 'updating' });
  expect(reservation.remaining(15_100)).toBe(0);
  expect(reservation.reserve(() => clear, 15_100)).toHaveProperty('ok', true);
});

test('missing status fails closed and leaves no reservation', () => {
  const reservation = new RestartReservation();
  expect(
    reservation.reserve(() => {
      throw new Error('offline');
    })
  ).toEqual({ ok: false, reason: 'unavailable' });
  expect(reservation.remaining()).toBe(0);
});

test('reservation is available only through the paired local session door', async () => {
  let reads = 0;
  const reservation = new RestartReservation();
  const registry = createOperationRegistry([
    createRestartReservationOperation(() => {
      reads++;
      return clear;
    }, reservation),
  ]);
  for (const denied of [
    { ...caller, source: 'rpc' as const, principal: 'local' },
    { ...caller, principal: undefined },
    { ...caller, device: { deviceId: 'agent', kind: 'agent' as const } },
  ]) {
    const result = await invokeOperation(registry, 'system.restart.reserve', {}, denied);
    expect(
      result.kind === 'failed' ||
        (result.kind === 'completed' && (result.value as { ok: boolean }).ok === false)
    ).toBe(true);
  }
  expect(reads).toBe(0);
  expect(
    planSessionDoorCall({ sender: 'cli', name: 'system.restart.reserve', input: {} }, caller.device)
  ).toHaveProperty('value');
  expect(await invokeOperation(registry, 'system.restart.reserve', {}, caller)).toHaveProperty(
    'value.ok',
    true
  );
  expect(reads).toBe(1);
});

test('a Neo turn waits for expiration and retains its pending input', async () => {
  const db = await createTestDb();
  const events = await createTestInternalEventBus();
  const id = 'neo:10000000-0000-4000-8000-000000000001';
  await db.createSession(createTestSession(id));
  db.getDatabase()
    .prepare(
      "INSERT INTO neo_session_bindings(session_id, concern_id, kind) VALUES (?, NULL, 'neo')"
    )
    .run(id);
  const manager = new ProcessingStateManager(id, events, db);
  const held = spyOn(restartReservation, 'remaining').mockReturnValue(10);
  try {
    await manager.setQueued('pending-input');
    const pending = manager.setProcessing('pending-input');
    expect(manager.getState()).toMatchObject({ status: 'queued', messageId: 'pending-input' });
    held.mockReturnValue(0);
    await pending;
    expect(manager.getState()).toMatchObject({ status: 'processing', messageId: 'pending-input' });
  } finally {
    held.mockRestore();
    db.close();
  }
});

test('interrupting a deferred Neo turn preserves the interrupted state', async () => {
  const db = await createTestDb();
  const events = await createTestInternalEventBus();
  const id = 'neo:10000000-0000-4000-8000-000000000001';
  await db.createSession(createTestSession(id));
  db.getDatabase()
    .prepare(
      "INSERT INTO neo_session_bindings(session_id, concern_id, kind) VALUES (?, NULL, 'neo')"
    )
    .run(id);
  const manager = new ProcessingStateManager(id, events, db);
  const held = spyOn(restartReservation, 'remaining').mockReturnValue(10);
  try {
    await manager.setQueued('pending-input');
    const pending = manager.setProcessing('pending-input');
    await manager.setInterrupted();
    held.mockReturnValue(0);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(manager.getState().status).toBe('interrupted');
  } finally {
    held.mockRestore();
    db.close();
  }
});
