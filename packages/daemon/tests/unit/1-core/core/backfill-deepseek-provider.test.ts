import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { unlinkSync } from 'node:fs';
import {
  backfillDeepSeekProvider,
  gateProviderImport,
  gateDeepSeekKey,
  gateDeepSeekImport,
  migrateProvidersIfNeeded,
} from '../../../../src/lib/credential-discovery';
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

  it('does not restore a deleted provider after restarting with the same env key', async () => {
    process.env.DEEPSEEK_API_KEY = 'deepseek-key';
    const credentials = {
      getCredentials: mock(async () => null),
      storeApiKey: mock(async () => {}),
      storeOAuthTokens: mock(async () => {}),
    };
    await migrateProvidersIfNeeded(db, credentials);
    await backfillDeepSeekProvider(db, credentials);
    for (const provider of db.providers.listProviders()) db.providers.deleteProvider(provider.id);
    db.close();
    db = new Database(dbPath);
    await db.initialize(createReactiveDatabase(db));
    credentials.storeApiKey.mockClear();

    await migrateProvidersIfNeeded(db, credentials);
    await backfillDeepSeekProvider(db, credentials);

    expect(db.providers.getProviderByProviderId('deepseek')).toBeNull();
    expect(credentials.storeApiKey).not.toHaveBeenCalled();
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

  it('allows an explicitly re-added provider to import a missing credential', async () => {
    process.env.DEEPSEEK_API_KEY = 'deepseek-key';
    const credentials = {
      getCredentials: mock(async () => null),
      storeApiKey: mock(async () => {}),
    };
    await backfillDeepSeekProvider(db, credentials);
    db.providers.deleteProvider(db.providers.getProviderByProviderId('deepseek')!.id);
    db.providers.createProvider({
      providerId: 'deepseek',
      displayName: 'Re-added',
      kind: 'built_in',
      authType: 'api_key',
    });
    credentials.storeApiKey.mockClear();
    await backfillDeepSeekProvider(db, credentials);
    expect(credentials.storeApiKey).toHaveBeenCalledWith('deepseek', 'deepseek-key');
    expect(db.providers.getProviderByProviderId('deepseek')?.displayName).toBe('Re-added');
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

describe('provider startup import gates', () => {
  it.each([true, false])('gateProviderImport handles completed=%s', (completed) => {
    expect(gateProviderImport(completed)).toEqual(
      completed ? { reason: 'already_imported' } : { value: true }
    );
  });

  it.each([undefined, '', 'key'])('gateDeepSeekKey handles key=%s', (key) => {
    expect(gateDeepSeekKey(key)).toEqual(key ? { value: { apiKey: key } } : { reason: 'no_key' });
  });

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])('gateDeepSeekImport handles present=%s completed=%s', (present, completed) => {
    expect(gateDeepSeekImport({ apiKey: 'key' }, { present, completed })).toEqual(
      completed && !present ? { reason: 'previously_imported' } : { value: { apiKey: 'key' } }
    );
  });
});
