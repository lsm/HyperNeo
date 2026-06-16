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
export const KEYCHAIN_UNAVAILABLE_MESSAGE =
  'macOS Keychain is locked or unavailable. Run `security unlock-keychain`, ' +
  'launch NeoKai from Desktop/Terminal with a GUI session, or configure credentials via environment variables.';

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
        reject(wrapped);
      } else {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    });
  });
}

/**
 * Tagged error thrown by `KeychainCredentialStore` operations when the macOS
 * Keychain is locked or has no GUI session (`errSecInteractionNotAllowed`,
 * exit code 36). `KeychainStatusCredentialStore` catches this to surface
 * system status and preserve env/settings fallback behavior for reads.
 */
export class KeychainUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeychainUnavailableError';
  }
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
      if (isKeychainUnavailable(error)) {
        throw new KeychainUnavailableError(extractKeychainMessage(error));
      }
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
        } else if (code === 36 || stderr.includes('User interaction is not allowed')) {
          // Keychain locked / no GUI session. Reject so callers fail with
          // actionable guidance rather than silently dropping credentials.
          reject(
            new KeychainUnavailableError(
              `security add-generic-password failed (exit ${code}): ${stderr.trim()}`
            )
          );
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
      if (isKeychainUnavailable(error)) {
        throw new KeychainUnavailableError(extractKeychainMessage(error));
      }
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
 * macOS production credential store wrapper. Persistence stays Keychain-only:
 * no SQLite fallback for secrets. Reads tolerate a locked/unavailable Keychain
 * by returning null so env/settings discovery can still make providers usable;
 * writes/deletes rethrow a tagged error so RPC handlers can show actionable UX.
 */
export class KeychainStatusCredentialStore implements CredentialStore {
  private keychainWarned = false;
  private keychainAvailable = true;
  private statusChangeCallback: (() => void) | null = null;
  private readonly logger = new Logger('KeychainStatusCredentialStore');

  constructor(private readonly keychain: CredentialStore) {}

  setStatusChangeCallback(callback: () => void): void {
    this.statusChangeCallback = callback;
  }

  async get(service: string, account: string): Promise<string | null> {
    try {
      const result = await this.keychain.get(service, account);
      this.markKeychainAvailable();
      return result;
    } catch (error) {
      if (!(error instanceof KeychainUnavailableError)) throw error;
      this.markKeychainUnavailable();
      return null;
    }
  }

  async set(service: string, account: string, data: string): Promise<void> {
    try {
      await this.keychain.set(service, account, data);
      this.markKeychainAvailable();
    } catch (error) {
      if (!(error instanceof KeychainUnavailableError)) throw error;
      this.markKeychainUnavailable();
      throw new KeychainUnavailableError(KEYCHAIN_UNAVAILABLE_MESSAGE);
    }
  }

  async delete(service: string, account: string): Promise<void> {
    try {
      await this.keychain.delete(service, account);
      this.markKeychainAvailable();
    } catch (error) {
      if (!(error instanceof KeychainUnavailableError)) throw error;
      this.markKeychainUnavailable();
      throw new KeychainUnavailableError(KEYCHAIN_UNAVAILABLE_MESSAGE);
    }
  }

  async listServices(prefix: string): Promise<string[]> {
    try {
      const services = await this.keychain.listServices(prefix);
      this.markKeychainAvailable();
      return services;
    } catch (error) {
      if (!(error instanceof KeychainUnavailableError)) throw error;
      this.markKeychainUnavailable();
      return [];
    }
  }

  getStatus(): CredentialStoreStatus {
    if (this.keychainAvailable) {
      return { backend: 'keychain', keychainAvailable: true };
    }
    return {
      backend: 'keychain-unavailable',
      keychainAvailable: false,
      warning: KEYCHAIN_UNAVAILABLE_MESSAGE,
    };
  }

  private markKeychainUnavailable(): void {
    const wasAvailable = this.keychainAvailable;
    this.keychainAvailable = false;
    if (wasAvailable) this.statusChangeCallback?.();
    if (this.keychainWarned) return;
    this.keychainWarned = true;
    this.logger.warn(KEYCHAIN_UNAVAILABLE_MESSAGE);
  }

  private markKeychainAvailable(): void {
    const wasUnavailable = !this.keychainAvailable;
    this.keychainAvailable = true;
    if (wasUnavailable) this.statusChangeCallback?.();
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
    return new KeychainStatusCredentialStore(new KeychainCredentialStore());
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
 * launches with no GUI session. Treat as "unavailable" so reads can fall back
 * to env/settings discovery and writes can fail with actionable guidance.
 */
function isKeychainUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const err = error as Error & { code?: number; stderr?: string };
  return err.code === 36 || err.stderr?.includes('User interaction is not allowed') === true;
}

function extractKeychainMessage(error: unknown): string {
  if (!(error instanceof Error)) return 'macOS Keychain unavailable';
  const err = error as Error & { stderr?: string };
  return err.stderr?.trim() || error.message || 'macOS Keychain unavailable';
}

interface CredentialRow {
  encrypted_data: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
}
