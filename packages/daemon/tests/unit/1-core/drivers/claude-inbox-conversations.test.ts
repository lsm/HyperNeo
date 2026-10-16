import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createClaudeInboxConversations } from '../../../../src/lib/drivers/claude-inbox-conversations';
import type {
  ClaudeInboxEvent,
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
const reply = (): ClaudeInboxEvent => ({
  kind: 'reply',
  sessionId: target.sessionId,
  messageId: randomUUID(),
  from: `uds:${target.socketPath}`,
  content: 'answer',
});

describe('Claude inbox conversation lifetime', () => {
  let opened: Array<{
    target: ClaudeInboxTarget;
    emit: (event: ClaudeInboxEvent) => void;
    inbox: Inbox;
    writes: unknown[];
    closes: number;
  }>;
  let routed: Array<{ returnTo: string; event: ClaudeInboxEvent }>;
  let errors: unknown[];
  let manager: ReturnType<typeof createClaudeInboxConversations>;
  let open: typeof openClaudeInbox;

  beforeEach(() => {
    opened = [];
    routed = [];
    errors = [];
    open = async (target, emit) => {
      const record = { target, emit, writes: [] as unknown[], closes: 0, inbox: {} as Inbox };
      record.inbox = {
        path: `/tmp/fake-${opened.length}.sock`,
        write: async (submission) => {
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
      open,
      onEvent: (returnTo, event) => void routed.push({ returnTo, event }),
      onError: (error) => void errors.push(error),
      ...overrides,
    });
  }

  afterEach(async () => {
    await manager.close().catch(() => {});
  });

  test('concurrent writes share a listener which remains alive for later replies', async () => {
    const submissions = [input(), input()];
    await Promise.all(submissions.map((submission) => manager.write(target, origin, submission)));
    expect(opened).toHaveLength(1);
    expect(opened[0].writes).toEqual(submissions);
    expect(opened[0].closes).toBe(0);
    const event = reply();
    opened[0].emit(event);
    await manager.close();
    expect(routed).toEqual([{ returnTo: origin, event }]);
    expect(opened[0].closes).toBe(1);
  });

  test('different originating conversations retain their own reply destination', async () => {
    await manager.write(target, 'session:first', input());
    await manager.write(target, 'session:second', input());
    const first = reply();
    const second = reply();
    opened[1].emit(second);
    opened[0].emit(first);
    await manager.close();
    expect(routed).toEqual([
      { returnTo: 'session:second', event: second },
      { returnTo: 'session:first', event: first },
    ]);
    expect(opened.map((record) => record.closes)).toEqual([1, 1]);
  });

  test('does not reuse a listener after the target process or registered endpoint changes', async () => {
    await manager.write(target, origin, input());
    await manager.write(
      { ...target, pid: 789, socketPath: '/tmp/cc-socks/789.sock' },
      origin,
      input()
    );
    expect(opened).toHaveLength(2);
    expect(opened.map((record) => record.target.pid)).toEqual([456, 789]);
  });

  test('a failed open can retry instead of poisoning the conversation cache', async () => {
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
    const ready = open(target, () => {});
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

  test('shutdown waits for accepted reply persistence after closing listeners', async () => {
    let finish!: () => void;
    let closed!: () => void;
    const persisted = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const listenerClosed = new Promise<void>((resolve) => {
      closed = resolve;
    });
    create({
      onEvent: () => persisted,
    });
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

  test('a failed close does not strand the other listeners', async () => {
    await manager.write(target, 'session:first', input());
    await manager.write(target, 'session:second', input());
    opened[0].inbox.close = async () => {
      throw new Error('close failed');
    };
    await expect(manager.close()).rejects.toThrow('shutdown failed');
    expect(opened[1].closes).toBe(1);
    await expect(manager.write(target, origin, input())).rejects.toThrow('closed');
  });

  test('does not open an inbox without a reply destination', async () => {
    await expect(manager.write(target, ' ', input())).rejects.toThrow('destination');
    expect(opened).toEqual([]);
  });
});
