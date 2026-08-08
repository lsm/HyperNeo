import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { unlinkSync } from 'node:fs';
import { backfillDeepSeekProvider } from '../../../../src/lib/credential-discovery';
import { Database } from '../../../../src/storage';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';

describe('backfillDeepSeekProvider', () => {
  let db: Database;
  let dbPath: string;
  const originalKey = process.env.DEEPSEEK_API_KEY;

  beforeEach(async () => {
    dbPath = `/tmp/test-deepseek-backfill-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
    db = new Database(dbPath);
    await db.initialize(createReactiveDatabase(db));
  });

  afterEach(() => {
    db.close();
    try {
      unlinkSync(dbPath);
    } catch {}
    if (originalKey === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = originalKey;
  });

  it('adds DeepSeek and imports its env key into an existing provider database', async () => {
    db.providers.createProvider({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      kind: 'built_in',
      authType: 'api_key',
    });
    process.env.DEEPSEEK_API_KEY = 'deepseek-key';
    const storeApiKey = mock(async () => {});
    const getCredentials = mock(async () => null);

    await backfillDeepSeekProvider(db, { getCredentials, storeApiKey });

    expect(db.providers.getProviderByProviderId('deepseek')?.displayName).toBe('DeepSeek');
    expect(storeApiKey).toHaveBeenCalledWith('deepseek', 'deepseek-key');
  });

  it('preserves an existing row and stored credential', async () => {
    db.providers.createProvider({
      providerId: 'deepseek',
      displayName: 'My DeepSeek',
      kind: 'built_in',
      authType: 'api_key',
    });
    process.env.DEEPSEEK_API_KEY = 'deepseek-key';
    const storeApiKey = mock(async () => {});
    const getCredentials = mock(async () => ({ type: 'api_key' as const, apiKey: 'stored-key' }));

    await backfillDeepSeekProvider(db, { getCredentials, storeApiKey });

    expect(db.providers.getProviderByProviderId('deepseek')?.displayName).toBe('My DeepSeek');
    expect(storeApiKey).not.toHaveBeenCalled();
  });

  it('retries a missing credential import for an existing backfilled row', async () => {
    db.providers.createProvider({
      providerId: 'deepseek',
      displayName: 'DeepSeek',
      kind: 'built_in',
      authType: 'api_key',
    });
    process.env.DEEPSEEK_API_KEY = 'deepseek-key';
    const storeApiKey = mock(async () => {});
    const getCredentials = mock(async () => null);

    await backfillDeepSeekProvider(db, { getCredentials, storeApiKey });

    expect(storeApiKey).toHaveBeenCalledWith('deepseek', 'deepseek-key');
  });

  it('does nothing without a DeepSeek environment key', async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const storeApiKey = mock(async () => {});
    const getCredentials = mock(async () => null);

    await backfillDeepSeekProvider(db, { getCredentials, storeApiKey });

    expect(db.providers.getProviderByProviderId('deepseek')).toBeNull();
    expect(storeApiKey).not.toHaveBeenCalled();
  });
});
