import { Database } from 'bun:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CredentialStoreStatus } from '@neokai/shared/state-types';
import { Logger } from '../logger';

const DEFAULT_SERVICE_PREFIX = 'neokai.provider';
const ENCRYPTION_KEY_ENV = 'NEOKAI_PROVIDER_CREDENTIAL_KEY';
const KEY_FILE_NAME = '.provider-credential-key';

export interface CredentialStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, data: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
  listServices(prefix: string): Promise<string[]>;
  /**
   * Optional health snapshot. Implementations that don't track health
   * (e.g. raw `DatabaseCredentialStore`) can omit this.
   */
  getStatus?(): CredentialStoreStatus;
}

/**
 * Promise wrapper around `execFile`. Defined as a function (not via `promisify`)
 * so tests using `mock.module('node:child_process')` can replace `execFile`
 * through the live ESM binding before this is first invoked.
 */
function execFileAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      if (err) {
        const wrapped = err as Error & { code?: number; stderr?: string };
        wrapped.stderr = stderr ?? wrapped.stderr ?? '';
        wrapped.code = typeof wrapped.code === 'number' ? wrapped.code : wrapped.code;
        reject(wrapped);
      } else {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    });
  });
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
      if (isKeychainUnavailable(error)) return null;
      throw error;
    }
  }

  async set(service: string, account: string, data: string): Promise<void> {
    // Pass the secret via -p to avoid the interactive retype prompt that
    // security opens on /dev/tty when using -w with no existing item.
    return new Promise((resolve, reject) => {
      const child = spawn('security', [
        'add-generic-password',
        '-U',
        '-s',
        service,
        '-a',
        account,
        '-p',
        data,
      ]);

      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else if (code === 36) {
          // Keychain locked / no GUI session — don't crash; caller (FallbackCredentialStore)
          // will persist to the DB store instead.
          resolve();
        } else {
          reject(
            new Error(`security add-generic-password failed (exit ${code}): ${stderr.trim()}`)
          );
        }
      });
    });
  }

  async delete(service: string, account: string): Promise<void> {
    try {
      await execFileAsync('security', ['delete-generic-password', '-s', service, '-a', account]);
    } catch (error) {
      if (isSecurityItemNotFound(error)) return;
      if (isKeychainUnavailable(error)) return;
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

/**
 * Wraps a primary store (Keychain) and falls back to a secondary store (Database)
 * when the primary is unavailable — e.g. macOS keychain locked (exit code 36,
 * `errSecInteractionNotAllowed`) under SSH / CI / background launches.
 *
 * Reads: try primary first; on missing item OR thrown error, fall through to fallback.
 * Writes: try primary; on throw, persist to fallback so the next read succeeds.
 * Deletes: best-effort on both stores.
 */
export class FallbackCredentialStore implements CredentialStore {
  private keychainWarned = false;
  private primaryAvailable = true;
  private readonly logger = new Logger('FallbackCredentialStore');

  constructor(
    private readonly primary: CredentialStore,
    private readonly fallback: CredentialStore
  ) {}

  async get(service: string, account: string): Promise<string | null> {
    try {
      const result = await this.primary.get(service, account);
      if (result !== null) return result;
      // Item not in primary — try fallback.
      return this.fallback.get(service, account);
    } catch {
      // Primary threw (locked/unavailable) — try fallback.
      this.markPrimaryUnavailable();
      return this.fallback.get(service, account);
    }
  }

  async set(service: string, account: string, data: string): Promise<void> {
    try {
      await this.primary.set(service, account, data);
    } catch {
      this.markPrimaryUnavailable();
      await this.fallback.set(service, account, data);
    }
  }

  async delete(service: string, account: string): Promise<void> {
    await Promise.allSettled([
      this.primary.delete(service, account),
      this.fallback.delete(service, account),
    ]);
  }

  async listServices(prefix: string): Promise<string[]> {
    const [primary, fallback] = await Promise.all([
      this.primary.listServices(prefix).catch(() => []),
      this.fallback.listServices(prefix),
    ]);
    return Array.from(new Set([...primary, ...fallback])).sort();
  }

  /**
   * Snapshot of credential store health. Used to surface a UI warning when the
   * macOS Keychain is locked / inaccessible.
   */
  getStatus(): CredentialStoreStatus {
    if (this.primaryAvailable) {
      return { backend: 'keychain', keychainAvailable: true };
    }
    return {
      backend: 'database-fallback',
      keychainAvailable: false,
      warning:
        'macOS Keychain unavailable — credentials stored in local encrypted DB. ' +
        'Run `security unlock-keychain` to restore Keychain access.',
    };
  }

  private markPrimaryUnavailable(): void {
    this.primaryAvailable = false;
    if (this.keychainWarned) return;
    this.keychainWarned = true;
    this.logger.warn(
      'macOS Keychain unavailable — using local encrypted credential store. ' +
        'Run `security unlock-keychain` to restore Keychain access.'
    );
  }
}

export class DatabaseCredentialStore implements CredentialStore {
  private _key: Buffer | undefined;

  constructor(
    private readonly db: Database,
    private readonly secret?: string
  ) {
    ensureProviderCredentialsTable(db);
  }

  private get key(): Buffer {
    if (!this._key) {
      const secret =
        this.secret ?? process.env[ENCRYPTION_KEY_ENV] ?? loadOrGenerateCredentialKey();
      this._key = createHash('sha256').update(secret).digest();
    }
    return this._key;
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
      .all(`${escapeLike(prefix)}%`);
    return rows.map((row) => row.provider_id.slice(0, row.provider_id.lastIndexOf(':')));
  }
}

export function createCredentialStore(db: Database): CredentialStore {
  if (process.env.NODE_ENV !== 'test' && platform() === 'darwin') {
    return new FallbackCredentialStore(
      new KeychainCredentialStore(),
      new DatabaseCredentialStore(db)
    );
  }
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

function loadOrGenerateCredentialKey(): string {
  const envKey = process.env[ENCRYPTION_KEY_ENV];
  if (envKey) return envKey;

  const keyPath = path.join(homedir(), '.neokai', KEY_FILE_NAME);
  try {
    const existing = fs.readFileSync(keyPath, 'utf-8').trim();
    if (existing) return existing;
  } catch {
    // File does not exist — generate a new key below.
  }

  const key = randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
  } catch (err) {
    throw new Error(
      `Failed to persist provider credential key to ${keyPath}. ` +
        'Set NEOKAI_PROVIDER_CREDENTIAL_KEY to provide a stable encryption key.',
      { cause: err }
    );
  }
  return key;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function isSecurityItemNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const err = error as Error & { code?: number; stderr?: string };
  return err.code === 44 || err.stderr?.includes('could not be found') === true;
}

/**
 * Detects `errSecInteractionNotAllowed` (exit code 36): the keychain exists but
 * the process can't prompt for unlock — happens under SSH, CI, or background
 * launches with no GUI session. Treat as "unavailable" so the caller can fall
 * back to the DB store instead of crashing.
 */
function isKeychainUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const err = error as Error & { code?: number; stderr?: string };
  return err.code === 36 || err.stderr?.includes('User interaction is not allowed') === true;
}

interface CredentialRow {
  encrypted_data: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}
