import { afterEach, expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { createDesktopTargetBroker } from '../../../../src/lib/desktop/target-broker.ts';

let server: Server | null = null;
let root = '';
afterEach(() => {
  server?.close();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function desktop(reply: (request: Record<string, unknown>) => unknown) {
  root = mkdtempSync('/tmp/broker-');
  mkdirSync(join(root, 'desktop'));
  const requests: Record<string, unknown>[] = [];
  server = createServer((socket) =>
    socket.once('data', (chunk) => {
      const request = JSON.parse(chunk.toString());
      requests.push(request);
      socket.end(JSON.stringify(reply(request)) + '\n');
    })
  );
  await new Promise<void>((resolve) => server!.listen(join(root, 'desktop/control.sock'), resolve));
  return { broker: createDesktopTargetBroker(root), requests };
}

test('createDesktopTargetBroker maps a verified target and sends the call id', async () => {
  const { broker, requests } = await desktop((request) => ({
    ok: true,
    result: {
      call_id: request.callId,
      value: {
        bundle_id: 'com.apple.sleep',
        class: 'pointer',
        instance: { pid: 42 },
        window_id: 7,
      },
    },
  }));
  expect(
    await broker(
      { worker_id: 'worker-a' },
      'type_text',
      { pid: 42, text: 'x'.repeat(20000) },
      'call-1'
    )
  ).toEqual({
    value: { app_id: 'com.apple.sleep', class: 'pointer', pid: 42, window_id: 7 },
  });
  expect(requests).toEqual([
    {
      action: 'resolve',
      worker: 'worker-a',
      tool: 'type_text',
      arguments: { pid: 42 },
      callId: 'call-1',
    },
  ]);
});

test('createDesktopTargetBroker passes typed refusals through', async () => {
  const { broker } = await desktop((request) => ({
    ok: true,
    result: {
      call_id: request.callId,
      reason: 'target_mismatch',
      class: 'pointer',
      bundle_id: 'com.apple.finder',
    },
  }));
  expect(await broker({ worker_id: 'worker-a' }, 'click', { pid: 42 }, 'call-2')).toEqual({
    reason: 'target_mismatch',
    class: 'pointer',
    app_id: 'com.apple.finder',
  });
});

test('createDesktopTargetBroker passes a missing grant through as its own refusal', async () => {
  const { broker } = await desktop((request) => ({
    ok: true,
    result: {
      call_id: request.callId,
      reason: 'app_action_not_authorized',
      class: 'keyboard',
      bundle_id: 'com.apple.finder',
    },
  }));
  expect(await broker({ worker_id: 'worker-a' }, 'type_text', { pid: 42 }, 'call-5')).toEqual({
    reason: 'app_action_not_authorized',
    class: 'keyboard',
    app_id: 'com.apple.finder',
  });
});

test('createDesktopTargetBroker refuses another call id or a failed reply', async () => {
  const { broker } = await desktop((request) =>
    request.tool === 'click'
      ? { ok: true, result: { call_id: 'other', reason: 'tool_not_allowed' } }
      : { ok: false, error: 'boom' }
  );
  expect(await broker({ worker_id: 'worker-a' }, 'click', {}, 'call-3')).toBeNull();
  expect(await broker({ worker_id: 'worker-a' }, 'zoom', {}, 'call-4')).toBeNull();
});

test('createDesktopTargetBroker returns null without Desktop', async () => {
  root = mkdtempSync('/tmp/broker-');
  expect(await createDesktopTargetBroker(root)({ worker_id: 'w' }, 'click', {}, 'c')).toBeNull();
});
