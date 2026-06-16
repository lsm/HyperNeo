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
  'macOS Keychain is locked or unavailable. Run `security unlock-keychain` ' +
  '(prompts for your login password), launch NeoKai from Desktop/Terminal with a ' +
  'GUI session, or configure credentials via environment variables.';

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

const KEYCHAIN_FALLBACK_MESSAGE =
  'macOS Keychain is locked or unavailable; using local encrypted file storage. ' +
  'Run `security unlock-keychain` (prompts for your login password) or restart ' +
  'NeoKai from a GUI session to restore Keychain persistence.';

/**
 * macOS production credential store wrapper. Prefers Keychain for secure
 * persistence. When the Keychain is locked or unavailable (daemon running
 * in screen / SSH / launchd without a GUI security session), the wrapper
 * tries to recover via the macOS GUI unlock dialog and then falls back to
 * the encrypted `DatabaseCredentialStore` so credential writes still
 * succeed. Reads tolerate a locked Keychain silently so env/settings
 * discovery can keep providers usable.
 *
 * `fallback`, `unlockers`, and `ttyCheck` are optional so unit tests can
 * pin behaviour without spawning real `security` invocations or touching
 * the real `process.stdout.isTTY`.
 *
 * Note on weaker isolation: the encrypted fallback file lives at
 * `~/.neokai/credentials.db` with its AES key at
 * `~/.neokai/.provider-credential-key` (0600). Any same-user process can
 * read both — this is weaker than the Keychain, which mitigates local
 * attackers via Secure Enclave / ACLs. The fallback exists because the
 * Keychain is unreachable from non-GUI security sessions and bricking
 * credential writes in screen / SSH / launchd is worse than the
 * weaker-isolation tradeoff. See `ProvidersSettings.tsx` banner for the
 * user-facing disclosure.
 */
export class KeychainStatusCredentialStore implements CredentialStore {
  private keychainWarned = false;
  private keychainAvailable = true;
  private usingFallback = false;
  private unlockAttempted = false;
  private statusChangeCallback: (() => void) | null = null;
  private readonly logger = new Logger('KeychainStatusCredentialStore');

  constructor(
    private readonly keychain: CredentialStore,
    private readonly fallback?: CredentialStore,
    private readonly unlockers: Array<() => Promise<boolean>> = [],
    /**
     * Returns `true` when the daemon has a controlling TTY (interactive
     * launch). Used by the default unlocker to decide whether triggering
     * the macOS GUI password dialog is appropriate — non-interactive
     * daemons (launchd, containerised, bun test runner) would block
     * forever on a dialog no one can see. Overridable for tests.
     */
    private readonly ttyCheck: () => boolean = () => process.stdout.isTTY === true
  ) {}

  setStatusChangeCallback(callback: () => void): void {
    this.statusChangeCallback = callback;
  }

  async get(service: string, account: string): Promise<string | null> {
    // Always try the Keychain first when it's reachable. This lets the
    // daemon pick up an external `security unlock-keychain` without a
    // restart, and means the Keychain stays authoritative whenever it's
    // available — even if we previously wrote a fallback copy.
    try {
      const result = await this.keychain.get(service, account);
      this.markKeychainAvailable();
      if (result !== null) return result;
      // Keychain reachable but miss — fall through to fallback in case the
      // value was written while the Keychain was previously unavailable.
    } catch (error) {
      if (!(error instanceof KeychainUnavailableError)) throw error;
      // Reads stay silent on 36 so env-var/settings discovery keeps working.
      this.markKeychainUnavailable();
    }
    if (this.fallback) return await this.fallback.get(service, account);
    return null;
  }

  async set(service: string, account: string, data: string): Promise<void> {
    const outcome = await this.runWithUnlockRetry(() => this.keychain.set(service, account, data));
    if (outcome === 'ok') {
      this.markKeychainAvailable();
      // Deliberately do NOT delete the fallback copy here. Concurrent
      // writers outside `withProviderLock` (daemon startup at app.ts:98,102,
      // OAuth refresh scheduler at oauth-refresh-scheduler.ts:80) could
      // route a write to the fallback between our primary success and a
      // cleanup delete, losing a freshly-written refresh token. Stale
      // fallback copies are harmless: `get()` prefers the Keychain
      // whenever it's reachable, so the fallback only matters when the
      // Keychain is genuinely unavailable.
      return;
    }
    await this.runWithFallback(
      () => this.fallback?.set(service, account, data),
      `set(${service}:${account})`
    );
  }

  async delete(service: string, account: string): Promise<void> {
    const outcome = await this.runWithUnlockRetry(() => this.keychain.delete(service, account));
    if (outcome === 'ok') {
      this.markKeychainAvailable();
      // Delete from both stores for tidiness; a delete racing with a
      // concurrent write would lose the new write either way (deleting is
      // the intent), so no regression vs the original keychain-only model.
      await this.fallback?.delete(service, account).catch(() => {});
      return;
    }
    await this.runWithFallback(
      () => this.fallback?.delete(service, account),
      `delete(${service}:${account})`
    );
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

  /**
   * Runs an operation against the primary Keychain store. On
   * `KeychainUnavailableError` triggers the configured unlockers once per
   * daemon session, then retries the operation a single time. Returns
   * `'ok'` on success or `'fallback'` when the operation could not
   * complete against the Keychain.
   */
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
    if (this.fallback) {
      this.markUsingFallback();
      await op();
      return;
    }
    this.markKeychainUnavailable();
    throw new KeychainUnavailableError(`${KEYCHAIN_UNAVAILABLE_MESSAGE} (blocked: ${label})`);
  }

  private markKeychainUnavailable(): void {
    const wasAvailable = this.keychainAvailable && !this.usingFallback;
    this.keychainAvailable = false;
    if (wasAvailable) this.statusChangeCallback?.();
    if (this.keychainWarned) return;
    this.keychainWarned = true;
    this.logger.warn(KEYCHAIN_UNAVAILABLE_MESSAGE);
  }

  private markUsingFallback(): void {
    const wasAvailable = this.keychainAvailable && !this.usingFallback;
    this.usingFallback = true;
    this.keychainAvailable = false;
    if (wasAvailable) this.statusChangeCallback?.();
    if (this.keychainWarned) return;
    this.keychainWarned = true;
    this.logger.warn(KEYCHAIN_FALLBACK_MESSAGE);
  }

  private markKeychainAvailable(): void {
    const wasUnavailable = !this.keychainAvailable || this.usingFallback;
    this.keychainAvailable = true;
    this.usingFallback = false;
    // Reset the one-shot unlock latch: if the Keychain later re-locks
    // (sleep, `security lock-keychain`, keychain timeout), the next write
    // should attempt interactive unlock again rather than routing blindly
    // to the fallback. Without this, the daemon is stuck on the weaker
    // fallback store until process restart.
    this.unlockAttempted = false;
    if (wasUnavailable) this.statusChangeCallback?.();
  }
}

/**
 * Builds the default unlocker list with the given TTY gate. Extracted so
 * `createCredentialStore` can hand in the production `process.stdout.isTTY`
 * check while tests construct their own instances with a stubbed gate.
 */
function buildDefaultUnlockers(ttyCheck: () => boolean): Array<() => Promise<boolean>> {
  return [
    async () => {
      if (!ttyCheck()) return false;
      return tryUnlockKeychainViaGUI();
    },
  ];
}

/**
 * Default interactive unlock strategy: trigger the macOS GUI password
 * dialog. We deliberately do NOT prompt on stdin/TTY because that path
 * risks hanging non-interactive daemons (launchd, test runners, CI) when
 * no one is around to type. We also gate on the injected `ttyCheck`
 * (production: `process.stdout.isTTY === true`) so background processes
 * (launchd, containerised daemons, bun test runners) skip the unlock
 * attempt entirely and fall straight through to the encrypted file
 * fallback instead of blocking on a dialog the user may never see.
 *
 * The GUI dialog either pops on the user's desktop (they type, keychain
 * unlocks, retry succeeds) or fails fast with `errSecInteractionNotAllowed`
 * when there's no Aqua session attached, in which case we fall through to
 * the encrypted file store.
 */

async function tryUnlockKeychainViaGUI(): Promise<boolean> {
  try {
    // No `-p`: macOS pops a dialog on the user's desktop. Call resolves
    // when the user submits or cancels. Fails fast with code 36 when no
    // Aqua session is attached (SSH, screen without GUI, launchd).
    await execFileAsync('security', ['unlock-keychain']);
    return true;
  } catch {
    return false;
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
    // macOS Keychain is preferred for secure storage. When it's locked or
    // running in a headless security session (screen, SSH, launchd), writes
    // fail with `errSecInteractionNotAllowed` (exit 36). The wrapper catches
    // that, tries to recover via the macOS GUI unlock dialog (no TTY prompt
    // — that would hang non-interactive daemons like launchd or test
    // runners waiting on stdin), and finally falls back to the encrypted
    // SQLite store so the daemon still works in screen/SSH without forcing
    // the user to restart from a GUI session.
    const ttyCheck = () => process.stdout.isTTY === true;
    return new KeychainStatusCredentialStore(
      new KeychainCredentialStore(),
      new DatabaseCredentialStore(db),
      buildDefaultUnlockers(ttyCheck),
      ttyCheck
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
