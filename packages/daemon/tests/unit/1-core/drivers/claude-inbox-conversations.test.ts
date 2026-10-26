import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  type ClaudeInboxRoutes,
  createClaudeInboxConversations,
} from '../../../../src/lib/drivers/claude-inbox-conversations';
import type {
  ClaudeInboxEvent,
  ClaudeInboxFrameEvent,
  ClaudeInboxTarget,
  openClaudeInbox,
} from '../../../../src/lib/drivers/claude-inbox';

type Inbox = Awaited<ReturnType<typeof openClaudeInbox>>;
const target: ClaudeInboxTarget = {
  sessionId: randomUUID(),
  pid: 456,
  socketPath: '/tmp/cc-socks/456.sock',
  version: '2.1.295',
};
const origin = 'session:origin';
const input = () => ({ messageId: randomUUID(), inputId: randomUUID(), text: 'continue' });
const reply = (from = `uds:${target.socketPath}`): ClaudeInboxFrameEvent => ({
  kind: 'reply',
  messageId: randomUUID(),
  from,
  content: 'answer',
});
const named = (frame: ClaudeInboxFrameEvent, sessionId: string): ClaudeInboxEvent =>
  ({ ...frame, sessionId }) as ClaudeInboxEvent;
const senders = new Map<string, string>([[`uds:${target.socketPath}`, target.sessionId]]);

function memoryRoutes(): ClaudeInboxRoutes {
  const rows = new Map<string, { returnTo: string; dir: string }>();
  return {
    record: async (sessionId, returnTo, dir) => void rows.set(sessionId, { returnTo, dir }),
    returnTo: (sessionId) => rows.get(sessionId)?.returnTo ?? null,
    inboxDirs: () => [...new Set([...rows.values()].map((row) => row.dir))],
  };
}

describe('Claude inbox conversation lifetime', () => {
  let opened: Array<{
    directory: string;
    name: string;
    emit: (event: ClaudeInboxFrameEvent) => void;
    inbox: Inbox;
    writes: unknown[];
    closes: number;
  }>;
  let routed: Array<{ returnTo: string; event: ClaudeInboxEvent }>;
  let errors: unknown[];
  let routes: ClaudeInboxRoutes;
  let manager: ReturnType<typeof createClaudeInboxConversations>;
  let open: typeof openClaudeInbox;

  beforeEach(() => {
    opened = [];
    routed = [];
    errors = [];
    routes = memoryRoutes();
    open = async (directory, name, emit) => {
      const record = {
        directory,
        name,
        emit,
        writes: [] as unknown[],
        closes: 0,
        inbox: {} as Inbox,
      };
      record.inbox = {
        path: `${directory}/${name}.sock`,
        write: async (_target, submission) => {
          record.writes.push(submission);
          return { written: true };
        },
        close: async () => void record.closes++,
      };
      opened.push(record);
      return record.inbox;
    };
    create();
  });

  function create(overrides: Partial<Parameters<typeof createClaudeInboxConversations>[0]> = {}) {
    manager = createClaudeInboxConversations({
      name: 'abc123',
      routes,
      senderSession: async (from) => senders.get(from) ?? null,
      open,
      onEvent: (returnTo, event) => void routed.push({ returnTo, event }),
      onError: (error) => void errors.push(error),
      ...overrides,
    });
  }

  afterEach(async () => {
    await manager.close().catch(() => {});
  });

  test('every send shares one stable listener and replies route by session id', async () => {
    const other = {
      ...target,
      sessionId: randomUUID(),
      pid: 789,
      socketPath: '/tmp/cc-socks/789.sock',
    };
    await Promise.all([
      manager.write(target, origin, input()),
      manager.write(other, 'session:second', input()),
    ]);
    expect(opened.map(({ directory, name }) => ({ directory, name }))).toEqual([
      { directory: '/tmp/cc-socks', name: 'abc123' },
    ]);
    senders.set(`uds:${other.socketPath}`, other.sessionId);
    const first = reply();
    const second = reply(`uds:${other.socketPath}`);
    opened[0].emit(second);
    opened[0].emit(first);
    opened[0].emit(reply('uds:/tmp/cc-socks/1.sock'));
    await manager.close();
    expect(routed).toEqual([
      { returnTo: 'session:second', event: named(second, other.sessionId) },
      { returnTo: origin, event: named(first, target.sessionId) },
    ]);
    expect(opened[0].closes).toBe(1);
  });

  test('after a restart, listen reopens the same address and old routes still deliver', async () => {
    await manager.write(target, origin, input());
    await manager.close();
    create();
    await manager.listen();
    expect(opened.map(({ directory, name }) => `${directory}/${name}`)).toEqual([
      '/tmp/cc-socks/abc123',
      '/tmp/cc-socks/abc123',
    ]);
    const event = reply();
    opened[1].emit(event);
    await manager.close();
    expect(routed).toEqual([{ returnTo: origin, event: named(event, target.sessionId) }]);
  });

  test('a reply from a socket with no registered session goes nowhere', async () => {
    await manager.write(target, origin, input());
    opened[0].emit(reply('uds:/tmp/cc-socks/1.sock'));
    await manager.close();
    expect(routed).toEqual([]);
  });

  test('a target in another socket directory gets its own listener, and listen reopens both', async () => {
    const elsewhere = {
      ...target,
      sessionId: randomUUID(),
      socketPath: '/run/user/501/cc-socks/456.sock',
    };
    await manager.write(target, origin, input());
    await manager.write(elsewhere, origin, input());
    await manager.close();
    create();
    await manager.listen();
    expect(opened.map(({ directory }) => directory)).toEqual([
      '/tmp/cc-socks',
      '/run/user/501/cc-socks',
      '/tmp/cc-socks',
      '/run/user/501/cc-socks',
    ]);
  });

  test('listen opens nothing before any session was sent to', async () => {
    await manager.listen();
    expect(opened).toEqual([]);
  });

  test('a failed open can retry instead of poisoning the listener', async () => {
    let attempts = 0;
    create({
      open: async (...args) => {
        if (++attempts === 1) throw new Error('unavailable');
        return open(...args);
      },
    });
    await expect(manager.write(target, origin, input())).rejects.toThrow('unavailable');
    expect(await manager.write(target, origin, input())).toEqual({ written: true });
    expect(attempts).toBe(2);
    expect(opened).toHaveLength(1);
  });

  test('shutdown waits for a pending open and prevents its delayed send', async () => {
    let release!: (inbox: Inbox) => void;
    const ready = open('/tmp/cc-socks', 'abc123', () => {});
    create({
      open: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const rejected = expect(manager.write(target, origin, input())).rejects.toThrow('closed');
    const closing = manager.close();
    expect(manager.close()).toBe(closing);
    release(await ready);
    await rejected;
    await closing;
    expect(opened[0].writes).toEqual([]);
    expect(opened[0].closes).toBe(1);
    await expect(manager.write(target, origin, input())).rejects.toThrow('closed');
  });

  test('shutdown waits for accepted reply persistence after closing the listener', async () => {
    let finish!: () => void;
    let closed!: () => void;
    const persisted = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const listenerClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    create({ onEvent: () => persisted });
    await manager.write(target, origin, input());
    opened[0].inbox.close = async () => {
      closed();
    };
    opened[0].emit(reply());
    let finished = false;
    const closing = manager.close().then(() => {
      finished = true;
    });
    await listenerClosed;
    expect(finished).toBe(false);
    finish();
    await closing;
    expect(finished).toBe(true);
  });

  test('reports reply persistence failures without an unhandled rejection', async () => {
    create({
      onEvent: async () => {
        throw new Error('storage unavailable');
      },
    });
    await manager.write(target, origin, input());
    opened[0].emit(reply());
    await manager.close();
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('storage unavailable');
  });

  test('does not open an inbox without a reply destination', async () => {
    await expect(manager.write(target, ' ', input())).rejects.toThrow('destination');
    expect(opened).toEqual([]);
  });
});
