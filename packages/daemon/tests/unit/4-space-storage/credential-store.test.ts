import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from '../../../src/storage/sqlite-compat';
import { DatabaseCredentialStore } from '../../../src/lib/credentials/credential-store';

describe('DatabaseCredentialStore', () => {
  let db: Database;
  let store: DatabaseCredentialStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new DatabaseCredentialStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it('round-trips a credential', async () => {
    await store.set('test-service', 'test-account', 'secret-value');
    const got = await store.get('test-service', 'test-account');
    expect(got).toBe('secret-value');
  });

  it('returns null for missing credential', async () => {
    const got = await store.get('test-service', 'missing');
    expect(got).toBeNull();
  });

  it('deletes a credential', async () => {
    await store.set('test-service', 'test-account', 'secret');
    await store.delete('test-service', 'test-account');
    const got = await store.get('test-service', 'test-account');
    expect(got).toBeNull();
  });

  it('updates an existing credential', async () => {
    await store.set('svc', 'acct', 'v1');
    await store.set('svc', 'acct', 'v2');
    const got = await store.get('svc', 'acct');
    expect(got).toBe('v2');
  });
});
