import { describe, expect, test } from 'bun:test';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { RemoteDaemonRegistry } from '../../../../src/lib/remote-daemons/registry';
import { createAttachDaemonOperation } from '../../../../src/lib/remote-daemons/attach-operation';
import {
  createDetachDaemonOperation,
  createListDaemonsOperation,
  createProbeDaemonOperation,
} from '../../../../src/lib/remote-daemons/manage-operations';
import type { OperationCaller } from '../../../../src/lib/operations/registry';

const HUMAN: OperationCaller = { source: 'rpc' };
const AGENT: OperationCaller = {
  source: 'mcp',
  sessionId: 'agent-on-a',
  spaceId: 'space-a',
  role: 'ad_hoc_member',
};

function daemonCatalog() {
  const daemons = new RemoteDaemonRegistry();
  const registry = createOperationRegistry([
    createAttachDaemonOperation(daemons),
    createProbeDaemonOperation(daemons),
    createListDaemonsOperation(daemons),
    createDetachDaemonOperation(daemons),
  ]);
  return {
    daemons,
    call: (name: string, input: unknown, caller: OperationCaller) =>
      invokeOperation(registry, name, input, caller),
  };
}

describe('probing a remote daemon URL', () => {
  test('dials the supplied URL without attaching it', async () => {
    const { daemons, call } = daemonCatalog();
    const probed: string[] = [];
    daemons.probe = async (url) => {
      probed.push(url);
    };

    expect(await call('daemon.probe', { url: 'ws://remote.test/ws' }, HUMAN)).toEqual({
      kind: 'completed',
      value: { kind: 'reachable', url: 'ws://remote.test/ws' },
    });
    expect(probed).toEqual(['ws://remote.test/ws']);
    expect(await call('daemon.list', {}, HUMAN)).toEqual({
      kind: 'completed',
      value: { kind: 'listed', daemons: [] },
    });
  });

  test('returns the connection reason without attaching an unreachable URL', async () => {
    const { daemons, call } = daemonCatalog();
    daemons.probe = async () => {
      throw new Error('Timed out connecting after 5000ms');
    };

    expect(await call('daemon.probe', { url: 'ws://remote.test/ws' }, HUMAN)).toEqual({
      kind: 'completed',
      value: {
        kind: 'unreachable',
        url: 'ws://remote.test/ws',
        reason: 'Timed out connecting after 5000ms',
      },
    });
  });

  test('refuses an agent caller before dialing the URL', async () => {
    const { daemons, call } = daemonCatalog();
    let probed = false;
    daemons.probe = async () => {
      probed = true;
    };

    expect(await call('daemon.probe', { url: 'ws://remote.test/ws' }, AGENT)).toMatchObject({
      kind: 'completed',
      value: { kind: 'rejected', reason: expect.stringContaining('restricted to the RPC door') },
    });
    expect(probed).toBe(false);
  });
});

describe('listing and detaching attached remote daemons', () => {
  test('lists every daemon a human attached, with the address prefix it answers to', async () => {
    const { call } = daemonCatalog();

    await call('daemon.attach', { daemonId: 'b', url: 'ws://127.0.0.1:9/ws' }, HUMAN);
    await call('daemon.attach', { daemonId: 'c', url: 'wss://elsewhere.test/ws' }, HUMAN);

    expect(await call('daemon.list', {}, HUMAN)).toEqual({
      kind: 'completed',
      value: {
        kind: 'listed',
        daemons: [
          {
            daemonId: 'b',
            url: 'ws://127.0.0.1:9/ws',
            addressExample: 'daemon:b::session:<sessionId>',
          },
          {
            daemonId: 'c',
            url: 'wss://elsewhere.test/ws',
            addressExample: 'daemon:c::session:<sessionId>',
          },
        ],
      },
    });
  });

  test('reports an empty list before anything is attached', async () => {
    const { call } = daemonCatalog();

    expect(await call('daemon.list', {}, HUMAN)).toEqual({
      kind: 'completed',
      value: { kind: 'listed', daemons: [] },
    });
  });

  test('detaching drops the daemon from the list and from the registry', async () => {
    const { daemons, call } = daemonCatalog();

    await call('daemon.attach', { daemonId: 'b', url: 'ws://127.0.0.1:9/ws' }, HUMAN);

    expect(await call('daemon.detach', { daemonId: 'b' }, HUMAN)).toEqual({
      kind: 'completed',
      value: { kind: 'detached', daemonId: 'b' },
    });
    expect(await call('daemon.list', {}, HUMAN)).toEqual({
      kind: 'completed',
      value: { kind: 'listed', daemons: [] },
    });
    await expect(daemons.invoke('b', 'message.send', {})).rejects.toThrow('No attached daemon: b');
  });

  test('detaching a daemon that was never attached says so instead of failing', async () => {
    const { call } = daemonCatalog();

    expect(await call('daemon.detach', { daemonId: 'ghost' }, HUMAN)).toEqual({
      kind: 'completed',
      value: { kind: 'not_attached', daemonId: 'ghost' },
    });
  });
});

describe('the RPC-only gate on remote daemon management', () => {
  test('refuses to enumerate attached daemons for an agent caller', async () => {
    const { call } = daemonCatalog();

    await call('daemon.attach', { daemonId: 'b', url: 'ws://127.0.0.1:9/ws' }, HUMAN);

    expect(await call('daemon.list', {}, AGENT)).toMatchObject({
      kind: 'completed',
      value: {
        kind: 'rejected',
        reason: expect.stringContaining('restricted to the RPC door'),
      },
    });
  });

  test('refuses to detach for an agent caller, leaving the attachment in place', async () => {
    const { call } = daemonCatalog();

    await call('daemon.attach', { daemonId: 'b', url: 'ws://127.0.0.1:9/ws' }, HUMAN);

    expect(await call('daemon.detach', { daemonId: 'b' }, AGENT)).toMatchObject({
      kind: 'completed',
      value: {
        kind: 'rejected',
        reason: expect.stringContaining('restricted to the RPC door'),
      },
    });
    expect(await call('daemon.list', {}, HUMAN)).toMatchObject({
      kind: 'completed',
      value: { kind: 'listed', daemons: [{ daemonId: 'b' }] },
    });
  });

  test('refuses to attach for an agent caller, so nothing appears in the list', async () => {
    const { call } = daemonCatalog();

    expect(
      await call('daemon.attach', { daemonId: 'b', url: 'ws://127.0.0.1:9/ws' }, AGENT)
    ).toMatchObject({
      kind: 'completed',
      value: {
        kind: 'rejected',
        reason: expect.stringContaining('restricted to the RPC door'),
      },
    });
    expect(await call('daemon.list', {}, HUMAN)).toEqual({
      kind: 'completed',
      value: { kind: 'listed', daemons: [] },
    });
  });
});
