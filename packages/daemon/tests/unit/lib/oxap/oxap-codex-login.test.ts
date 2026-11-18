import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  listeners: [] as Array<(message: { method: string; params: unknown }) => void>,
  calls: [] as Array<{ method: string; params: Record<string, unknown> }>,
  account: null as object | null,
  exits: [] as Array<() => void>,
  commands: [] as unknown[],
  failStart: false,
  rejectStart: undefined as ((error: Error) => void) | undefined,
}));

vi.mock('../../../../src/lib/drivers/codex-app-server.ts', () => ({
  startCodexBootstrapServer: async (
    _command: unknown,
    listener: (typeof fake.listeners)[number],
    onExit: () => void
  ) => {
    fake.listeners.push(listener);
    fake.exits.push(onExit);
    fake.commands.push(_command);
    return {
      call: async (method: string, params: Record<string, unknown>) => {
        fake.calls.push({ method, params });
        if (method === 'account/read') return { account: fake.account };
        if (method === 'account/login/start' && fake.failStart)
          return await new Promise((_resolve, reject) => {
            fake.rejectStart = reject;
          });
        if (method === 'account/login/start')
          return { loginId: 'login-1', verificationUrl: 'https://example.com', userCode: 'CODE' };
        return {};
      },
      close: async () => {},
    };
  },
}));

import { checkCodexLogin } from '../../../../src/lib/oxap/oxap-codex-login.ts';

function fixture() {
  const messages: Array<{
    sessionId: string;
    message: {
      type: string;
      uuid: string;
      isAuthenticating: boolean;
      error?: string;
      output: string[];
    };
  }> = [];
  const saveSDKMessage = vi.fn(async (sessionId, message) => {
    messages.push({ sessionId, message });
    return true;
  });
  const updateAuthStatusMessage = vi.fn(async (sessionId, message) => {
    messages.push({ sessionId, message });
    return true;
  });
  return {
    messages,
    db: { saveSDKMessage, updateAuthStatusMessage } as never,
    hub: { event: vi.fn() } as never,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  fake.calls.length = 0;
  fake.listeners.length = 0;
  fake.exits.length = 0;
  fake.commands.length = 0;
  fake.account = null;
  fake.failStart = false;
  fake.rejectStart = undefined;
});
afterEach(() => vi.useRealTimers());

describe('checkCodexLogin', () => {
  it('checks every open and shares one device login until its matching completion', async () => {
    const f = fixture();
    const one = checkCodexLogin('one', f.db, f.hub, '/synthetic/codex');
    const two = checkCodexLogin('two', f.db, f.hub, '/synthetic/codex');
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.filter((call) => call.method === 'account/read')).toHaveLength(2);
    expect(fake.calls.filter((call) => call.method === 'account/login/start')).toEqual([
      { method: 'account/login/start', params: { type: 'chatgptDeviceCode' } },
    ]);
    expect(f.messages).toHaveLength(2);
    expect(f.messages.map(({ message }) => message.output)).toEqual([
      ['Open https://example.com', 'Enter code CODE'],
      ['Open https://example.com', 'Enter code CODE'],
    ]);
    fake.listeners.forEach((listener) =>
      listener({ method: 'account/login/completed', params: { loginId: 'wrong', success: true } })
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(f.messages).toHaveLength(2);
    fake.listeners.forEach((listener) =>
      listener({ method: 'account/login/completed', params: { loginId: 'login-1', success: true } })
    );
    await Promise.all([one, two]);
    expect(f.messages).toHaveLength(4);
    expect(f.messages[2]?.message.isAuthenticating).toBe(false);
    expect(f.messages[2]?.message.uuid).toBe(
      f.messages.find((item) => item.sessionId === f.messages[2]?.sessionId)?.message.uuid
    );
  });

  it('shows start failures to every waiting chat', async () => {
    fake.failStart = true;
    const f = fixture();
    const result = (id: string) =>
      checkCodexLogin(id, f.db, f.hub, '/synthetic/codex').then(
        () => null,
        (error: Error) => error.message
      );
    const one = result('one');
    const two = result('two');
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.filter((call) => call.method === 'account/login/start')).toHaveLength(1);
    fake.rejectStart!(new Error('Device login unavailable'));
    expect(await Promise.all([one, two])).toEqual([
      'Codex is not signed in. Sign in, then send again.',
      'Codex is not signed in. Sign in, then send again.',
    ]);
    expect(
      f.messages.map(({ sessionId, message }) => ({
        sessionId,
        authenticating: message.isAuthenticating,
        error: message.error,
      }))
    ).toEqual([
      { sessionId: 'one', authenticating: false, error: 'Device login unavailable' },
      { sessionId: 'two', authenticating: false, error: 'Device login unavailable' },
    ]);
  });

  it('shows the server error and refuses the open when login fails', async () => {
    const f = fixture();
    const result = checkCodexLogin('one', f.db, f.hub, '/synthetic/codex').then(
      () => null,
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(0);
    fake.listeners.forEach((listener) =>
      listener({
        method: 'account/login/completed',
        params: { loginId: 'login-1', success: false, error: 'Device login refused' },
      })
    );
    expect(await result).toBe('Codex is not signed in. Sign in, then send again.');
    expect(f.messages.at(-1)?.message.error).toBe('Device login refused');
    expect(f.messages.at(-1)?.message.uuid).toBe(f.messages[0]?.message.uuid);
  });

  it('reports a crashed app-server and permits a fresh login', async () => {
    const f = fixture();
    const result = checkCodexLogin('one', f.db, f.hub, '/synthetic/codex').then(
      () => null,
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(0);
    fake.exits[0]!();
    expect(await result).toBe('Codex is not signed in. Sign in, then send again.');
    expect(f.messages.at(-1)?.message.error).toBe('Codex app-server exited during sign-in');
    const retry = checkCodexLogin('two', f.db, f.hub, '/synthetic/codex');
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.filter((call) => call.method === 'account/login/start')).toHaveLength(2);
    fake.listeners[1]!({
      method: 'account/login/completed',
      params: { loginId: 'login-1', success: true },
    });
    await retry;
  });

  it('cancels a pending login after fifteen minutes and reports failure', async () => {
    const f = fixture();
    const result = checkCodexLogin('one', f.db, f.hub, '/synthetic/codex').then(
      () => null,
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(await result).toBe('Codex is not signed in. Sign in, then send again.');
    expect(fake.calls.filter((call) => call.method === 'account/login/cancel')).toEqual([
      { method: 'account/login/cancel', params: { loginId: 'login-1' } },
    ]);
    expect(f.messages.at(-1)?.message.error).toBe(
      'Codex is not signed in. Sign in, then send again.'
    );
  });

  it('passes a signed-in account without starting a login', async () => {
    fake.account = { type: 'chatgpt' };
    const f = fixture();
    await checkCodexLogin('one', f.db, f.hub, '/synthetic/codex');
    expect(fake.commands).toEqual(['/synthetic/codex']);
    expect(fake.calls.map((call) => call.method)).toEqual(['account/read']);
    expect(f.messages).toEqual([]);
  });
});
