import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DatabaseCredentialStore } from '../../../../src/lib/credentials/credential-store';

function createStore(): { db: Database; store: DatabaseCredentialStore } {
  const db = new Database(':memory:');
  return { db, store: new DatabaseCredentialStore(db, 'test-secret') };
}

describe('DatabaseCredentialStore', () => {
  it('round-trips encrypted credentials', async () => {
    const { db, store } = createStore();
    try {
      await store.set('neokai.provider.test', 'default', 'secret-data');

      expect(await store.get('neokai.provider.test', 'default')).toBe('secret-data');
      const row = db
        .query<{ encrypted_data: Uint8Array }, []>(
          'SELECT encrypted_data FROM provider_credentials WHERE provider_id = ?'
        )
        .get('neokai.provider.test:default');
      expect(Buffer.from(row!.encrypted_data).toString('utf8')).not.toBe('secret-data');
    } finally {
      db.close();
    }
  });

  it('deletes credentials idempotently', async () => {
    const { db, store } = createStore();
    try {
      await store.set('neokai.provider.test', 'default', 'secret-data');
      await store.delete('neokai.provider.test', 'default');
      await store.delete('neokai.provider.test', 'default');

      expect(await store.get('neokai.provider.test', 'default')).toBeNull();
    } finally {
      db.close();
    }
  });
});
