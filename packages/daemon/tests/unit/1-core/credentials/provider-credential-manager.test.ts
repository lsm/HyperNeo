import { describe, expect, it } from 'bun:test';
import { Database } from '../../../../src/storage/sqlite-compat';
import { ProviderCredentialManager } from '../../../../src/lib/credentials/provider-credential-manager';
import {
  DatabaseCredentialStore,
  type CredentialStore,
} from '../../../../src/lib/credentials/credential-store';

class MemoryCredentialStore implements CredentialStore {
  values = new Map<string, string>();

  async get(service: string, account: string): Promise<string | null> {
    return this.values.get(`${service}:${account}`) ?? null;
  }

  async set(service: string, account: string, data: string): Promise<void> {
    this.values.set(`${service}:${account}`, data);
  }

  async delete(service: string, account: string): Promise<void> {
    this.values.delete(`${service}:${account}`);
  }

  async listServices(prefix: string): Promise<string[]> {
    return Array.from(this.values.keys())
      .map((key) => key.slice(0, key.lastIndexOf(':')))
      .filter((service) => service.startsWith(prefix));
  }
}

function createDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE providers (
      id TEXT PRIMARY KEY,
      provider_id TEXT UNIQUE NOT NULL,
      auth_type TEXT NOT NULL DEFAULT 'none',
      health_status TEXT NOT NULL DEFAULT 'unknown',
      last_health_check_at INTEGER,
      updated_at INTEGER NOT NULL
    )
  `);
  db.query('INSERT INTO providers (id, provider_id, updated_at) VALUES (?, ?, ?)').run(
    'row-1',
    'glm',
    1
  );
  return db;
}

describe('ProviderCredentialManager', () => {
  it('stores API key and updates provider auth state', async () => {
    const db = createDb();
    const store = new MemoryCredentialStore();
    const manager = new ProviderCredentialManager(store, db);
    try {
      await manager.storeApiKey('glm', 'glm-secret');

      expect(await manager.getCredentials('glm')).toEqual({
        type: 'api_key',
        apiKey: 'glm-secret',
      });
      const row = db
        .query<{ auth_type: string; health_status: string }, []>(
          'SELECT auth_type, health_status FROM providers WHERE provider_id = ?'
        )
        .get('glm');
      expect(row).toEqual({ auth_type: 'api_key', health_status: 'healthy' });
    } finally {
      db.close();
    }
  });

  it('migrates first matching env key', async () => {
    const db = createDb();
    const store = new MemoryCredentialStore();
    const manager = new ProviderCredentialManager(store, db, { GLM_API_KEY: 'from-env' });
    try {
      expect(await manager.migrateFromEnv('glm')).toBe(true);
      expect(await manager.getCredentials('glm')).toEqual({ type: 'api_key', apiKey: 'from-env' });
    } finally {
      db.close();
    }
  });

  it('migrates Anthropic OAuth env key as OAuth credentials', async () => {
    const db = createDb();
    const store = new MemoryCredentialStore();
    const manager = new ProviderCredentialManager(store, db, {
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
    });
    try {
      expect(await manager.migrateFromEnv('anthropic')).toBe(true);
      expect(await manager.getCredentials('anthropic')).toEqual({
        type: 'oauth',
        accessToken: 'oauth-token',
      });
    } finally {
      db.close();
    }
  });

  it('detects provider environment credentials', () => {
    const db = createDb();
    const store = new MemoryCredentialStore();
    const manager = new ProviderCredentialManager(store, db, {
      GLM_API_KEY: 'from-env',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
    });
    try {
      expect(manager.hasEnvironmentCredentials('glm')).toBe(true);
      expect(manager.hasEnvironmentCredentials('anthropic')).toBe(true);
      expect(manager.hasEnvironmentCredentials('kimi')).toBe(false);
    } finally {
      db.close();
    }
  });

  it('normalizes OAuth expires_in to absolute expiresAt', async () => {
    const db = createDb();
    const store = new MemoryCredentialStore();
    const manager = new ProviderCredentialManager(store, db);
    const now = Date.now();
    try {
      await manager.storeOAuthTokens('glm', {
        access_token: 'oauth-token',
        refresh_token: 'refresh-token',
        expires_in: 60,
      });

      const credentials = await manager.getCredentials('glm');
      expect(credentials).toMatchObject({
        type: 'oauth',
        accessToken: 'oauth-token',
        refreshToken: 'refresh-token',
      });
      expect(
        credentials?.type === 'oauth' ? credentials.expiresAt : undefined
      ).toBeGreaterThanOrEqual(now + 60_000);
    } finally {
      db.close();
    }
  });

  it('lists provider ids from database credential store', async () => {
    const db = createDb();
    const store = new DatabaseCredentialStore(db, 'test-secret');
    const manager = new ProviderCredentialManager(store, db);
    try {
      await store.set('neokai.provider.glm', 'default', 'glm-secret');
      await store.set('neokai.provider.openrouter', 'default', 'openrouter-secret');

      expect(await manager.listCredentialProviderIds()).toEqual(['glm', 'openrouter']);
    } finally {
      db.close();
    }
  });

  it('removes credentials without changing auth_type', async () => {
    const db = createDb();
    const store = new MemoryCredentialStore();
    const manager = new ProviderCredentialManager(store, db);
    try {
      await manager.storeApiKey('glm', 'glm-secret');
      await manager.removeCredentials('glm');

      expect(await manager.getCredentials('glm')).toBeNull();
      const row = db
        .query<{ auth_type: string; health_status: string }, []>(
          'SELECT auth_type, health_status FROM providers WHERE provider_id = ?'
        )
        .get('glm');
      expect(row).toEqual({ auth_type: 'api_key', health_status: 'healthy' });
    } finally {
      db.close();
    }
  });
});
