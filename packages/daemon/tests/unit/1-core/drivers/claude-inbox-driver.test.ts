import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClaudeInboxDriver } from '../../../../src/lib/drivers/claude-inbox-driver';
import type {
  ClaudeInboxEvent,
  ClaudeInboxSubmission,
} from '../../../../src/lib/drivers/claude-inbox';

const sessionId = randomUUID();
const context = {
  from: 'session:origin',
  caller: { source: 'internal' as const, role: 'neo' as const },
};
type Deps = Parameters<typeof createClaudeInboxDriver>[0];

describe('Claude inbox driver runtime', () => {
  let dir: string;
  let deps: Deps;
  let driver: ReturnType<typeof createClaudeInboxDriver>;
  let emits: Array<(event: ClaudeInboxEvent) => void>;
  let writes: ClaudeInboxSubmission[];
  let handoffs: Parameters<Deps['handoff']>[0][];
  let errors: unknown[];
  let closes: number;
  let opens: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-inbox-driver-'));
    await writeFile(
      join(dir, '456.json'),
      JSON.stringify({
        sessionId,
        pid: 456,
        procStart: 'Thu Oct 15 15:18:31 2026',
        entrypoint: 'cli',
        version: '2.1.295',
        messagingSocketPath: '/tmp/cc-socks/456.sock',
      })
    );
    emits = [];
    writes = [];
    handoffs = [];
    errors = [];
    closes = 0;
    opens = 0;
    deps = {
      registrationsDir: dir,
      liveSessions: async () => [{ sessionId, pid: 456, status: 'busy', owner: 'cli' }],
      hasSession: (id) => id === 'origin',
      handoff: async (args) => {
        handoffs.push(args);
        return { kind: 'enqueued', id: 'entry' };
      },
      onError: (error) => void errors.push(error),
      open: async (_target, emit) => {
        opens++;
        emits.push(emit);
        return {
          path: '/tmp/fake.sock',
          write: async (input) => {
            writes.push(input);
            return { written: true };
          },
          close: async () => void closes++,
        };
      },
    };
    driver = createClaudeInboxDriver(deps);
  });
  afterEach(async () => {
    await driver.close();
    await rm(dir, { recursive: true, force: true });
  });

  const reply = (): ClaudeInboxEvent => ({
    kind: 'reply',
    sessionId,
    messageId: randomUUID(),
    from: 'uds:/tmp/cc-socks/456.sock',
    content: '<cross-session-message from-name="peer">answer</cross-session-message>',
  });

  test('direct writes remain unconfirmed and keep a reply route after sending', async () => {
    const text = 'exact text\n"调查"';
    const result = await driver.send(sessionId, text, context);
    expect(result).toMatchObject({ ok: true, value: { delivered: false, unconfirmed: true } });
    expect(writes).toHaveLength(1);
    expect(writes[0].text).toBe(text);
    expect(writes[0].inputId).toBe(writes[0].messageId);
    expect(result).toMatchObject({
      value: { receipt: { executionId: sessionId, inputId: writes[0].inputId } },
    });
    expect(closes).toBe(0);
    const event = reply();
    emits[0](event);
    await driver.close();
    expect(handoffs).toEqual([
      {
        to: context.from,
        origin: `driver:claude-code:${sessionId}`,
        messageUuid: event.messageId,
        message: {
          type: 'user',
          inputKind: 'system',
          parent_tool_use_id: null,
          message: { role: 'user', content: event.content },
        },
      },
    ]);
    expect(errors).toEqual([]);
    expect(closes).toBe(1);
    await expect(driver.send(sessionId, text, context)).rejects.toThrow('closed');
  });

  test('receipt facts use separate identities and never become a human approval', async () => {
    await driver.send(sessionId, 'question', context);
    const event: ClaudeInboxEvent = {
      kind: 'receipt',
      sessionId,
      messageId: writes[0].messageId,
      status: 'held',
    };
    emits[0](event);
    await driver.close();
    expect(handoffs[0].message.inputKind).toBe('system');
    expect(handoffs[0].origin).toBe(`driver:claude-code:${sessionId}`);
    expect(handoffs[0].messageUuid).not.toBe(event.messageId);
    expect(handoffs[0].message.message.content).toContain(JSON.stringify(event));
  });

  test.each(['desktop', 'unknown', 'missing'] as const)(
    'refuses %s owners without opening an inbox',
    async (owner) => {
      deps.liveSessions = async () =>
        owner === 'missing' ? [] : [{ sessionId, pid: 456, status: 'busy', owner }];
      expect(await driver.send(sessionId, 'text', context)).toMatchObject({
        ok: false,
        reason: owner === 'desktop' ? 'unsupported' : 'unreachable',
      });
      expect(opens).toBe(0);
    }
  );

  test('revalidates the reply destination when a later reply arrives', async () => {
    await driver.send(sessionId, 'text', context);
    deps.hasSession = () => false;
    emits[0](reply());
    await driver.close();
    expect(handoffs).toEqual([]);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('unavailable');
  });

  test('shutdown drains mailbox persistence and surfaces a rejected reply', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    deps.handoff = async () => {
      await pending;
      return { kind: 'rejected', reason: 'mailbox unavailable' };
    };
    await driver.send(sessionId, 'text', context);
    emits[0](reply());
    const closed = driver.close();
    release();
    await closed;
    expect(errors.map(String)).toEqual(['Error: mailbox unavailable']);
    expect(closes).toBe(1);
  });
});
