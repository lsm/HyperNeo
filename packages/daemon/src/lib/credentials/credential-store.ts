import { getDataDir } from '../data-dir.ts';
import { Database } from '../../storage/sqlite-compat.ts';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { platform } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CredentialStoreStatus } from '@hyperneo/shared/state-types';
import { Logger } from '../logger.ts';
import { buildOsBaselineEnv } from '../spawn-env.ts';

const DEFAULT_SERVICE_PREFIX = 'neokai.provider';
const ENCRYPTION_KEY_ENV = 'HYPERNEO_PROVIDER_CREDENTIAL_KEY';
const LEGACY_ENCRYPTION_KEY_ENV = 'NEOKAI_PROVIDER_CREDENTIAL_KEY';
const KEY_FILE_NAME = '.provider-credential-key';
export const KEYCHAIN_UNAVAILABLE_MESSAGE =
  'macOS Keychain is locked or unavailable. Run `security unlock-keychain` ' +
  '(prompts for your login password), launch HyperNeo from Desktop/Terminal with a ' +
  'GUI session, or configure credentials via environment variables.';

export interface CredentialStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, data: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
  listServices(prefix: string): Promise<string[]>;
  getStatus?(): CredentialStoreStatus;
}

const CHILD_PROCESS_TIMEOUT_MS = 15_000;
function execFileAsync(
  cmd: string,
  args: string[],
  timeoutMs = CHILD_PROCESS_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof execFile> | undefined;
    child = execFile(cmd, args, { env: buildOsBaselineEnv() }, (err, stdout, stderr) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) {
        const wrapped = err as Error & { code?: number; stderr?: string };
        wrapped.stderr = stderr ?? wrapped.stderr ?? '';
        reject(wrapped);
      } else {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child?.kill('SIGKILL');
      } catch {}
      reject(
        new KeychainUnavailableError(`Credential store subprocess timed out after ${timeoutMs}ms`)
      );
    }, timeoutMs);
  });
}

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
    return new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(
        'security',
        ['add-generic-password', '-U', '-s', service, '-a', account, '-p', data],
        { env: buildOsBaselineEnv() }
      );

      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {}
        reject(
          new KeychainUnavailableError(
            `security add-generic-password timed out after ${CHILD_PROCESS_TIMEOUT_MS}ms`
          )
        );
      }, CHILD_PROCESS_TIMEOUT_MS);

      child.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve();
        } else if (code === 36 || stderr.includes('User interaction is not allowed')) {
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

const KEYCHAIN_FALLBACK_MESSAGE =
  'macOS Keychain is locked or unavailable; using local encrypted file storage. ' +
  'Run `security unlock-keychain` (prompts for your login password) or restart ' +
  'HyperNeo from a GUI session to restore Keychain persistence.';

export class KeychainStatusCredentialStore implements CredentialStore {
  private keychainWarned = false;
  private keychainAvailable = true;
  private usingFallback = false;
  private unlockAttempted = false;
  private statusChangeCallback: (() => void) | null = null;
  private readonly logger = new Logger('KeychainStatusCredentialStore');
  private readonly pendingSupersede = new Map<string, string>();
  private readonly keyLocks = new Map<string, Promise<unknown>>();
  constructor(
    private readonly keychain: CredentialStore,
    private readonly fallback?: CredentialStore,
    private readonly unlockers: Array<() => Promise<boolean>> = []
  ) {}

  private withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.keyLocks.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    this.keyLocks.set(
      key,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  setStatusChangeCallback(callback: () => void): void {
    this.statusChangeCallback = callback;
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.withKeyLock(`${service}:${account}`, () => this.getInternal(service, account));
  }

  private async getInternal(service: string, account: string): Promise<string | null> {
    const supersedeKey = `${service}:${account}`;
    const pending = this.pendingSupersede.get(supersedeKey);
    if (pending !== undefined) {
      try {
        await this.keychain.set(service, account, pending);
        this.markKeychainAvailable();
        this.pendingSupersede.delete(supersedeKey);
      } catch (error) {
        if (!(error instanceof KeychainUnavailableError)) throw error;
        this.markKeychainUnavailable();
      }
      return pending;
    }
    try {
      const result = await this.keychain.get(service, account);
      this.markKeychainAvailable();
      if (result !== null) return result;
    } catch (error) {
      if (!(error instanceof KeychainUnavailableError)) throw error;
      this.markKeychainUnavailable();
    }
    if (this.fallback) return await this.fallback.get(service, account);
    return null;
  }

  async set(service: string, account: string, data: string): Promise<void> {
    return this.withKeyLock(`${service}:${account}`, () =>
      this.setInternal(service, account, data)
    );
  }

  private async setInternal(service: string, account: string, data: string): Promise<void> {
    const supersedeKey = `${service}:${account}`;
    const outcome = await this.runWithUnlockRetry(() => this.keychain.set(service, account, data));
    if (outcome === 'ok') {
      this.markKeychainAvailable();
      this.pendingSupersede.delete(supersedeKey);
      await this.refreshFallbackIfPresent(service, account, data);
      return;
    }
    await this.runWithFallback(
      () => this.fallback?.set(service, account, data),
      `set(${service}:${account})`
    );
    this.pendingSupersede.set(supersedeKey, data);
  }

  async delete(service: string, account: string): Promise<void> {
    return this.withKeyLock(`${service}:${account}`, () => this.deleteInternal(service, account));
  }

  private async deleteInternal(service: string, account: string): Promise<void> {
    const outcome = await this.runWithUnlockRetry(() => this.keychain.delete(service, account));
    if (outcome === 'ok') {
      this.markKeychainAvailable();
      this.pendingSupersede.delete(`${service}:${account}`);
      await this.fallback?.delete(service, account).catch(() => {});
      return;
    }
    this.markKeychainUnavailable();
    throw new KeychainUnavailableError(
      `${KEYCHAIN_UNAVAILABLE_MESSAGE} (blocked: delete(${service}:${account}))`
    );
  }

  private async refreshFallbackIfPresent(
    service: string,
    account: string,
    data: string
  ): Promise<void> {
    if (!this.fallback) return;
    try {
      const existing = await this.fallback.get(service, account);
      if (existing === null) return;
      await this.fallback.set(service, account, data);
    } catch {}
  }

  async listServices(prefix: string): Promise<string[]> {
    try {
      const services = await this.keychain.listServices(prefix);
      this.markKeychainAvailable();
      if (this.fallback) {
        const fb = await this.fallback.listServices(prefix);
        return Array.from(new Set([...services, ...fb])).sort();
      }
      return services;
    } catch (error) {
      if (!(error instanceof KeychainUnavailableError)) throw error;
      this.markKeychainUnavailable();
      if (this.fallback) return await this.fallback.listServices(prefix);
      return [];
    }
  }

  getStatus(): CredentialStoreStatus {
    if (this.usingFallback) {
      return {
        backend: 'keychain-fallback',
        keychainAvailable: false,
        warning: KEYCHAIN_FALLBACK_MESSAGE,
      };
    }
    if (this.keychainAvailable) {
      return { backend: 'keychain', keychainAvailable: true };
    }
    return {
      backend: 'keychain-unavailable',
      keychainAvailable: false,
      warning: KEYCHAIN_UNAVAILABLE_MESSAGE,
    };
  }

  private async runWithUnlockRetry(op: () => Promise<void>): Promise<'ok' | 'fallback'> {
    try {
      await op();
      return 'ok';
    } catch (error) {
      if (!(error instanceof KeychainUnavailableError)) throw error;
    }
    if (!this.unlockAttempted && this.unlockers.length > 0) {
      this.unlockAttempted = true;
      for (const unlock of this.unlockers) {
        const ok = await Promise.resolve(unlock()).catch(() => false);
        if (!ok) continue;
        try {
          await op();
          return 'ok';
        } catch (error) {
          if (!(error instanceof KeychainUnavailableError)) throw error;
          break;
        }
      }
    }
    return 'fallback';
  }

  private async runWithFallback(
    op: () => Promise<unknown> | undefined,
    label: string
  ): Promise<void> {
    if (!this.fallback) {
      this.markKeychainUnavailable();
      throw new KeychainUnavailableError(`${KEYCHAIN_UNAVAILABLE_MESSAGE} (blocked: ${label})`);
    }
    await op();
    this.markUsingFallback();
  }

  private currentBackend(): CredentialStoreStatus['backend'] {
    if (this.usingFallback) return 'keychain-fallback';
    if (this.keychainAvailable) return 'keychain';
    return 'keychain-unavailable';
  }

  private markKeychainUnavailable(): void {
    const previousBackend = this.currentBackend();
    this.keychainAvailable = false;
    if (previousBackend !== this.currentBackend()) this.statusChangeCallback?.();
    if (this.keychainWarned) return;
    this.keychainWarned = true;
    this.logger.warn(KEYCHAIN_UNAVAILABLE_MESSAGE);
  }

  private markUsingFallback(): void {
    const previousBackend = this.currentBackend();
    this.usingFallback = true;
    this.keychainAvailable = false;
    if (previousBackend !== this.currentBackend()) this.statusChangeCallback?.();
    if (this.keychainWarned) return;
    this.keychainWarned = true;
    this.logger.warn(KEYCHAIN_FALLBACK_MESSAGE);
  }

  private markKeychainAvailable(): void {
    const previousBackend = this.currentBackend();
    this.keychainAvailable = true;
    this.usingFallback = false;
    this.unlockAttempted = false;
    if (previousBackend !== this.currentBackend()) this.statusChangeCallback?.();
  }
}

export function buildDefaultUnlockers(
  ttyCheck: () => boolean,
  timeoutMs: number = 30_000
): Array<() => Promise<boolean>> {
  return [
    async () => {
      if (!ttyCheck()) return false;
      return tryUnlockKeychainViaGUI(timeoutMs);
    },
  ];
}

async function tryUnlockKeychainViaGUI(timeoutMs: number = 30_000): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawn('security', ['unlock-keychain'], {
      stdio: 'ignore',
      env: buildOsBaselineEnv(),
    });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      finish(false);
    }, timeoutMs);
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
  });
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
        this.secret ??
        process.env[ENCRYPTION_KEY_ENV] ??
        process.env[LEGACY_ENCRYPTION_KEY_ENV] ??
        loadOrGenerateCredentialKey();
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
    const ttyCheck = () => process.stdout.isTTY === true;
    return new KeychainStatusCredentialStore(
      new KeychainCredentialStore(),
      new DatabaseCredentialStore(db),
      buildDefaultUnlockers(ttyCheck)
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
  const envKey = process.env[ENCRYPTION_KEY_ENV] ?? process.env[LEGACY_ENCRYPTION_KEY_ENV];
  if (envKey) return envKey;

  const keyPath = path.join(getDataDir(), KEY_FILE_NAME);
  try {
    const existing = fs.readFileSync(keyPath, 'utf-8').trim();
    if (existing) return existing;
  } catch {}

  const key = randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true });
    fs.writeFileSync(keyPath, key, { mode: 0o600 });
  } catch (err) {
    throw new Error(
      `Failed to persist provider credential key to ${keyPath}. ` +
        'Set HYPERNEO_PROVIDER_CREDENTIAL_KEY to provide a stable encryption key.',
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
