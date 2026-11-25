import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCursorStart,
  cursorPermissionOutcome,
} from '../../../../src/lib/drivers/cursor-start.ts';

type Options = {
  onNotification: (frame: { method: string; params: unknown }) => void;
  onRequest: (frame: { id: number; method: string; params: unknown }) => void;
};
const peer = vi.hoisted(() => ({
  created: vi.fn(),
  respond: vi.fn(),
  request: vi.fn(),
  notify: vi.fn(),
  close: vi.fn(),
}));
vi.mock('../../../../src/lib/process-json-rpc.ts', async (original) => ({
  ...(await original<typeof import('../../../../src/lib/process-json-rpc.ts')>()),
  ProcessJsonRpcTransport: class {
    constructor(options: unknown) {
      peer.created(options);
    }
    sendRequest = peer.request;
    sendNotification = peer.notify;
    sendResponse = peer.respond;
    close = peer.close;
  },
}));

const ref = { adapter: 'cursor-cli', id: 'cursor-1' };
const handshake = { result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } };
const chunk = (text: string) => ({
  method: 'session/update',
  params: {
    sessionId: ref.id,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  },
});
const emit = (text: string) =>
  (peer.created.mock.lastCall![0] as Options).onNotification(chunk(text));

function useDriver() {
  const fixture = {} as { folder: string; driver: ReturnType<typeof createCursorStart> };
  beforeEach(() => {
    vi.resetAllMocks();
    fixture.folder = mkdtempSync(join(tmpdir(), 'cursor-start-test-'));
    fixture.driver = createCursorStart('cursor-agent', 'fixture', ref.adapter, async (id) =>
      id === ref.id ? fixture.folder : undefined
    );
  });

  afterEach(async () => {
    await fixture.driver.close();
    rmSync(fixture.folder, { recursive: true, force: true });
  });
  return fixture;
}

describe('createCursorStart.start', () => {
  const fixture = useDriver();

  it('starts a session and records the agent reply', async () => {
    let finish!: (value: unknown) => void;
    peer.request
      .mockResolvedValueOnce(handshake)
      .mockResolvedValueOnce({ result: { sessionId: ref.id } })
      .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    const started = await fixture.driver.start({
      place: { machine: 'fixture', folder: fixture.folder, name: 'Workspace' },
      title: 'Run',
      message: 'Hello',
    });
    expect(started).toMatchObject({ ok: true, value: { ref, status: 'running' } });
    expect(peer.created).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'cursor-agent',
        args: ['acp'],
        cwd: fixture.folder,
      })
    );
    expect(peer.request).toHaveBeenNthCalledWith(2, 'session/new', {
      cwd: fixture.folder,
      mcpServers: [],
    });

    emit('PO');
    emit('NG');
    finish({ result: { stopReason: 'end_turn' } });
    await vi.waitFor(async () =>
      expect(await fixture.driver.status(ref)).toMatchObject({
        ok: true,
        value: { status: 'done', lastReply: 'PONG' },
      })
    );
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it('tells the user to sign in when Cursor requires authentication', async () => {
    peer.request
      .mockResolvedValueOnce(handshake)
      .mockResolvedValueOnce({ error: { code: -32000, message: 'Authentication required' } });

    const started = await fixture.driver.start({
      place: { machine: 'fixture', folder: fixture.folder, name: 'Workspace' },
      title: 'Run',
      message: 'Hello',
    });
    expect(started).toMatchObject({ ok: false, reason: 'unreachable' });
    expect(!started.ok && started.detail).toContain('cursor-agent login');
    expect(peer.close).toHaveBeenCalledOnce();
  });
});

describe('createCursorStart.send', () => {
  const fixture = useDriver();

  it('loads an owned session and ignores replayed history', async () => {
    let finish!: (value: unknown) => void;
    peer.request
      .mockResolvedValueOnce(handshake)
      .mockImplementationOnce(async () => {
        emit('old reply');
        return { result: {} };
      })
      .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));

    const sent = await fixture.driver.send(ref, 'Next');
    expect(sent).toMatchObject({ ok: true, value: { unconfirmed: true } });
    expect(peer.request).toHaveBeenNthCalledWith(2, 'session/load', {
      cwd: fixture.folder,
      mcpServers: [],
      sessionId: ref.id,
    });

    emit('new reply');
    finish({ result: { stopReason: 'end_turn' } });
    const receipt = sent.ok ? sent.value.receipt : undefined;
    await vi.waitFor(async () =>
      expect(await fixture.driver.status(ref, undefined, receipt)).toMatchObject({
        ok: true,
        value: {
          lastReply: 'new reply',
          inputEvidence: { state: 'observed', exchange: [{ text: 'Next' }, { text: 'new reply' }] },
        },
      })
    );
  });

  it('does not allow a command announced only by replayed history', async () => {
    peer.request
      .mockResolvedValueOnce(handshake)
      .mockImplementationOnce(async () => {
        (peer.created.mock.lastCall![0] as Options).onNotification({
          method: 'session/update',
          params: {
            sessionId: ref.id,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'old-call',
              rawInput: { command: 'hyperneo send s-1 --from cursor-cli:cursor-1 Done' },
            },
          },
        });
        return { result: {} };
      })
      .mockReturnValueOnce(new Promise(() => {}));

    await fixture.driver.send(ref, 'Next');
    (peer.created.mock.lastCall![0] as Options).onRequest({
      id: 7,
      method: 'session/request_permission',
      params: {
        toolCall: { toolCallId: 'old-call', kind: 'execute' },
        options: [{ optionId: 'allow-once', kind: 'allow_once' }],
      },
    });
    expect(peer.respond).toHaveBeenCalledWith(7, { outcome: { outcome: 'cancelled' } });
  });

  it('refuses sessions HyperNeo did not start', async () => {
    expect(await fixture.driver.send({ ...ref, id: 'other' }, 'Hi')).toMatchObject({
      ok: false,
      reason: 'not_started_by_us',
    });
    expect(peer.created).not.toHaveBeenCalled();
  });
});

describe('createCursorStart.stop', () => {
  const fixture = useDriver();

  it('cancels the running prompt on stop', async () => {
    let finish!: (value: unknown) => void;
    peer.request
      .mockResolvedValueOnce(handshake)
      .mockResolvedValueOnce({ result: { sessionId: ref.id } })
      .mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await fixture.driver.start({
      place: { machine: 'fixture', folder: fixture.folder, name: 'Workspace' },
      title: 'Run',
      message: 'Hello',
    });

    const stopping = fixture.driver.stop(ref);
    expect(peer.notify).toHaveBeenCalledWith('session/cancel', { sessionId: ref.id });
    finish({ result: { stopReason: 'cancelled' } });
    expect(await stopping).toEqual({ ok: true, value: { stopped: true } });
  });
});

describe('cursorPermissionOutcome', () => {
  const ask = (options = [{ optionId: 'allow-once', kind: 'allow_once' }]) => ({
    toolCall: { toolCallId: 'call-1', kind: 'execute' },
    options: [{ optionId: 'allow-always', kind: 'allow_always' }, ...options],
  });
  const ran = (command: string) => new Map([['call-1', command]]);

  it('allows the hyperneo send reply command once', () => {
    expect(
      cursorPermissionOutcome(
        ask(),
        ran('hyperneo send s-1 --from cursor-cli:c-1 --kind done Done')
      )
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
  });

  it('cancels a command other than hyperneo send', () => {
    expect(cursorPermissionOutcome(ask(), ran('touch denied.txt'))).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });

  it('cancels a tool call that is not a shell command', () => {
    expect(
      cursorPermissionOutcome(
        { ...ask(), toolCall: { toolCallId: 'call-1', kind: 'edit' } },
        ran('hyperneo send s-1 hi')
      )
    ).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('cancels a tool call whose command was never announced', () => {
    expect(cursorPermissionOutcome(ask(), new Map())).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });

  it('cancels when no allow-once option is offered', () => {
    expect(cursorPermissionOutcome(ask([]), ran('hyperneo send s-1 hi'))).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });
});
