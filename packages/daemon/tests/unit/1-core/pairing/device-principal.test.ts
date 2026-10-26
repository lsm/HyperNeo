import { describe, expect, test } from 'bun:test';
import { ErrorCode, MessageHubHandlerError, type CallContext } from '@hyperneo/shared';
import { z } from 'zod';
import { createOperationRpcHandler } from '../../../../src/lib/operations/rpc-adapter.ts';
import {
  createOperationRegistry,
  defineOperation,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import type { UpgradeIdentity } from '../../../../src/lib/pairing/upgrade-auth.ts';

const context: CallContext = {
  messageId: 'request-1',
  sessionId: 'global',
  method: 'operation.invoke',
  timestamp: 'now',
  clientId: 'socket-1',
};

const echo = (name: string) =>
  defineOperation({
    name,
    description: name,
    inputSchema: z.object({}),
    resultSchema: z.object({ principal: z.string().optional(), kind: z.string().optional() }),
    execute: async (_input, caller: OperationCaller) => ({
      principal: caller.principal,
      kind: caller.device?.kind,
    }),
  });

function connectedAs(device: UpgradeIdentity | null) {
  const handler = createOperationRpcHandler(
    createOperationRegistry(
      [
        'client.list',
        'neo.snapshot',
        'neo.ask.read',
        'session.archive',
        'message.send',
        'work.status',
      ].map(echo)
    ),
    (call) => (call.clientId === 'socket-1' && device ? { device } : {})
  );
  return (name: string) => handler({ name, input: {} }, context);
}

async function refused(pending: unknown) {
  const error = await Promise.resolve(pending).then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(MessageHubHandlerError);
  expect((error as MessageHubHandlerError).code).toBe(ErrorCode.HANDLER_ERROR);
  expect((error as Error).message).toContain('is not available to this caller');
}

describe('operation callers from paired devices', () => {
  test('an unpaired connection keeps calling everything as the local user, as today', async () => {
    const call = connectedAs(null);
    expect(await call('session.archive')).toEqual({ principal: 'local' });
    expect(await call('client.list')).toEqual({ principal: 'local' });
  });

  test('a paired human device calls everything as the local user and is known by its kind', async () => {
    const call = connectedAs({ deviceId: 'phone', kind: 'human' });
    expect(await call('session.archive')).toEqual({ principal: 'local', kind: 'human' });
  });

  test('a paired relay keeps the reads the push relay makes and nothing else', async () => {
    const call = connectedAs({ deviceId: 'relay', kind: 'relay' });
    expect(await call('neo.snapshot')).toEqual({ principal: 'local', kind: 'relay' });
    expect(await call('neo.ask.read')).toEqual({ principal: 'local', kind: 'relay' });
    expect(await call('client.list')).toEqual({ principal: 'local', kind: 'relay' });
    await refused(call('session.archive'));
  });

  test('a paired daemon keeps the calls daemons make on each other and nothing else', async () => {
    const call = connectedAs({ deviceId: 'imac', kind: 'daemon' });
    expect(await call('message.send')).toEqual({ principal: 'local', kind: 'daemon' });
    expect(await call('work.status')).toEqual({ principal: 'local', kind: 'daemon' });
    await refused(call('client.list'));
    await refused(call('session.archive'));
  });
});
