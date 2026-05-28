import { Database } from 'bun:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { platform } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_SERVICE_PREFIX = 'neokai.provider';
const ENCRYPTION_KEY_ENV = 'NEOKAI_PROVIDER_CREDENTIAL_KEY';

export interface CredentialStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, data: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
  listServices(prefix: string): Promise<string[]>;
}

export class KeychainCredentialStore implements CredentialStore {
  async get(service: string, account: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('security', [
        'find-generic-password',
        '-s',
        service,
        '-a',
        account,
        '-w',
      ]);
      return stdout.replace(/\n$/, '');
    } catch (error) {
      if (isSecurityItemNotFound(error)) return null;
      throw error;
    }
  }

  async set(service: string, account: string, data: string): Promise<void> {
    await execFileAsync('security', [
      'add-generic-password',
      '-U',
      '-s',
      service,
      '-a',
      account,
      '-w',
      data,
    ]);
  }

  async delete(service: string, account: string): Promise<void> {
    try {
      await execFileAsync('security', ['delete-generic-password', '-s', service, '-a', account]);
    } catch (error) {
      if (isSecurityItemNotFound(error)) return;
      throw error;
    }
  }

  async listServices(prefix: string): Promise<string[]> {
    try {
      const { stdout } = await execFileAsync('security', ['dump-keychain']);
      const services = new Set<string>();
      for (const line of stdout.split('\n')) {
        const match = line.match(/"svce"<blob>="([^"]+)"/);
        if (match?.[1]?.startsWith(prefix)) services.add(match[1]);
      }
      return Array.from(services).sort();
    } catch {
      return [];
    }
  }
}

export class DatabaseCredentialStore implements CredentialStore {
  private readonly key: Buffer;

  constructor(
    private readonly db: Database,
    secret: string = process.env[ENCRYPTION_KEY_ENV] || defaultEncryptionSecret()
  ) {
    this.key = createHash('sha256').update(secret).digest();
    ensureProviderCredentialsTable(db);
  }

  async get(service: string, account: string): Promise<string | null> {
    const providerId = providerIdFrom(service, account);
    const row = this.db
      .query<CredentialRow, [string]>(
        'SELECT encrypted_data, iv, tag FROM provider_credentials WHERE provider_id = ?'
      )
      .get(providerId);
    if (!row) return null;

    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv));
    decipher.setAuthTag(Buffer.from(row.tag));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(row.encrypted_data)),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  async set(service: string, account: string, data: string): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(data, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    this.db
      .prepare(
        `INSERT INTO provider_credentials (provider_id, encrypted_data, iv, tag, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider_id) DO UPDATE SET
           encrypted_data = excluded.encrypted_data,
           iv = excluded.iv,
           tag = excluded.tag,
           updated_at = excluded.updated_at`
      )
      .run(providerIdFrom(service, account), encrypted, iv, tag, Date.now());
  }

  async delete(service: string, account: string): Promise<void> {
    this.db
      .prepare('DELETE FROM provider_credentials WHERE provider_id = ?')
      .run(providerIdFrom(service, account));
  }

  async listServices(prefix: string): Promise<string[]> {
    const rows = this.db
      .query<{ provider_id: string }, [string]>(
        'SELECT provider_id FROM provider_credentials WHERE provider_id LIKE ? ORDER BY provider_id ASC'
      )
      .all(`${escapeLike(prefix)}:%`);
    return rows.map((row) => row.provider_id.slice(0, row.provider_id.lastIndexOf(':')));
  }
}

export function createCredentialStore(db: Database): CredentialStore {
  if (platform() === 'darwin') return new KeychainCredentialStore();
  return new DatabaseCredentialStore(db);
}

export function credentialService(providerId: string): string {
  return `${DEFAULT_SERVICE_PREFIX}.${providerId}`;
}

function ensureProviderCredentialsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_credentials (
      provider_id TEXT PRIMARY KEY,
      encrypted_data BLOB NOT NULL,
      iv BLOB NOT NULL,
      tag BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

function providerIdFrom(service: string, account: string): string {
  return `${service}:${account}`;
}

function defaultEncryptionSecret(): string {
  return `${process.execPath}:${process.cwd()}`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function isSecurityItemNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const err = error as Error & { code?: number; stderr?: string };
  return err.code === 44 || err.stderr?.includes('could not be found') === true;
}

interface CredentialRow {
  encrypted_data: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}
