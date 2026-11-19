import { expect, test, vi } from 'vitest';
import { createConnectionLifecycle } from '../../../../src/lib/connections/lifecycle.ts';
import type { ConnectionVault } from '../../../../src/lib/connections/vault.ts';

const account = {
  id: 'connection-1',
  provider: 'google' as const,
  accountId: 'account-1',
  email: 'one@example.test',
  scopes: [],
  health: 'healthy' as const,
};

function fixture() {
  const closed = new AbortController();
  const read = vi.fn(async () => [account]);
  const readVault = vi.fn(async () => ({ client: { clientId: 'saved-client' } }));
  const cancelLogin = vi.fn();
  const startLogin = vi.fn(async (_client: { clientId: string; clientSecret?: string }) => ({
    authorizeUrl: 'https://example.test/consent',
    result: new Promise<never>(() => {}),
    cancel: cancelLogin,
  }));
  const vault = {
    read: readVault,
    storageStatus: () => ({ backend: 'database', keychainAvailable: false }),
  } as unknown as ConnectionVault;
  const service = createConnectionLifecycle({
    read,
    save: async () => {},
    vault,
    provider: 'google',
    startLogin,
    closed: closed.signal,
  });
  return { service, closed, read, readVault, startLogin, cancelLogin };
}

test('connectPipeline refuses a closed lifecycle before reading accounts', async () => {
  const f = fixture();
  f.closed.abort();
  expect(await f.service.connectPipeline({ clientId: 'client' })).toEqual({
    state: 'failed',
    reason: 'cancelled',
  });
  expect(f.read).not.toHaveBeenCalled();
});

test('connectPipeline refuses an unknown connection before reading credentials', async () => {
  const f = fixture();
  expect(await f.service.connectPipeline({ connectionId: 'unknown' })).toEqual({
    state: 'failed',
    reason: 'unknown_connection',
  });
  expect(f.readVault).not.toHaveBeenCalled();
  expect(f.startLogin).not.toHaveBeenCalled();
});

test('connectPipeline uses saved client details and tracks the pending login', async () => {
  const f = fixture();
  const result = await f.service.connectPipeline({ connectionId: account.id });
  expect(f.readVault).toHaveBeenCalledWith(account);
  expect(f.startLogin).toHaveBeenCalledWith({ clientId: 'saved-client' });
  expect(result).toMatchObject({ state: 'pending', authorizeUrl: 'https://example.test/consent' });
  expect(f.service.status(result.loginId).state).toBe('pending');
});

test('connectPipeline refuses missing client details without starting consent', async () => {
  const f = fixture();
  expect(await f.service.connectPipeline({})).toEqual({
    state: 'failed',
    reason: 'client_not_configured',
  });
  expect(f.startLogin).not.toHaveBeenCalled();
});

test('connectPipeline serializes concurrent attempts', async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.startLogin.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    return {
      authorizeUrl: 'https://example.test/consent',
      result: new Promise<never>(() => {}),
      cancel: f.cancelLogin,
    };
  });
  const first = f.service.connectPipeline({ clientId: 'first' });
  await started.promise;
  const second = f.service.connectPipeline({ clientId: 'second' });
  expect(f.read).toHaveBeenCalledOnce();
  release.resolve();
  expect((await first).state).toBe('pending');
  expect((await second).state).toBe('pending');
  expect(f.read).toHaveBeenCalledTimes(2);
  expect(f.startLogin).toHaveBeenNthCalledWith(2, { clientId: 'second', clientSecret: undefined });
  expect(f.cancelLogin).toHaveBeenCalledOnce();
});

test('connectPipeline cancels a login that starts after shutdown', async () => {
  const f = fixture();
  const release = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  f.startLogin.mockImplementationOnce(async () => {
    started.resolve();
    await release.promise;
    return {
      authorizeUrl: 'https://example.test/consent',
      result: new Promise<never>(() => {}),
      cancel: f.cancelLogin,
    };
  });
  const pending = f.service.connectPipeline({ clientId: 'client' });
  await started.promise;
  f.closed.abort();
  release.resolve();
  expect(await pending).toEqual({ state: 'failed', reason: 'cancelled' });
  expect(f.cancelLogin).toHaveBeenCalledOnce();
  expect(f.service.status().state).toBe('missing');
});
