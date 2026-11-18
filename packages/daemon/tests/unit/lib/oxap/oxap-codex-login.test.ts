import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({
  listeners: [] as Array<(message: { method: string; params: unknown }) => void>,
  calls: [] as Array<{ method: string; params: Record<string, unknown> }>,
  account: null as object | null,
}));

vi.mock('../../../../src/lib/drivers/codex-app-server.ts', () => ({
  startCodexBootstrapServer: async (
    _command: unknown,
    listener: (typeof fake.listeners)[number]
  ) => {
    fake.listeners.push(listener);
    return {
      call: async (method: string, params: Record<string, unknown>) => {
        fake.calls.push({ method, params });
        if (method === 'account/read') return { account: fake.account };
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
  fake.account = null;
});
afterEach(() => vi.useRealTimers());

describe('checkCodexLogin', () => {
  it('checks every open and shares one device login until its matching completion', async () => {
    const f = fixture();
    const one = checkCodexLogin('one', f.db, f.hub);
    const two = checkCodexLogin('two', f.db, f.hub);
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

  it('shows the server error and refuses the open when login fails', async () => {
    const f = fixture();
    const result = checkCodexLogin('one', f.db, f.hub).then(
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

  it('cancels a pending login after fifteen minutes and reports failure', async () => {
    const f = fixture();
    const result = checkCodexLogin('one', f.db, f.hub).then(
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
    await checkCodexLogin('one', f.db, f.hub);
    expect(fake.calls.map((call) => call.method)).toEqual(['account/read']);
    expect(f.messages).toEqual([]);
  });
});
