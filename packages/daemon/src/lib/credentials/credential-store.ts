import { getDataDir } from '../data-dir';
import { Database } from 'bun:sqlite';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { platform } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CredentialStoreStatus } from '@hyperneo/shared/state-types';
import { Logger } from '../logger';

// Intentionally retained as 'neokai.provider': this is the OS-keychain service
// namespace (and DB credential key) under which existing installs already store
// encrypted provider credentials. Renaming it would orphan every stored credential
// unless paired with a keychain + DB migration, so it is held back for the
// external-rebrand PR alongside the GitHub repo URL and OAuth client identity.
const DEFAULT_SERVICE_PREFIX = 'neokai.provider';
const ENCRYPTION_KEY_ENV = 'HYPERNEO_PROVIDER_CREDENTIAL_KEY';
// Legacy env var name retained as a decryption fallback so installs that pinned a
// custom key via NEOKAI_PROVIDER_CREDENTIAL_KEY keep decrypting existing rows.
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
 *
 * A bounded timeout + SIGKILL is applied so a stalled `security` subprocess
 * (e.g. a Keychain auth dialog that never resolves) is terminated rather than
 * orphaned — Promise.race alone abandons the JS promise while the process lives.
 */
const CHILD_PROCESS_TIMEOUT_MS = 15_000;
function execFileAsync(
  cmd: string,
  args: string[],
  timeoutMs = CHILD_PROCESS_TIMEOUT_MS
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Call execFile with the (cmd, args, callback) signature so tests that mock
    // it remain compatible, then kill the child ourselves on timeout — a plain
    // Promise.race would abandon the JS promise while the `security` process
    // keeps running and accumulates orphans across requests.
    let child: ReturnType<typeof execFile> | undefined;
    child = execFile(cmd, args, (err, stdout, stderr) => {
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
      } catch {
        // Already exited — nothing to kill.
      }
      reject(
        new KeychainUnavailableError(`Credential store subprocess timed out after ${timeoutMs}ms`)
      );
    }, timeoutMs);
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
      let settled = false;
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

      // Bound the write so a stalled Keychain prompt cannot hold the shared
      // settings/custom-endpoints mutation lock indefinitely.
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Already exited — nothing to kill.
        }
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
  'HyperNeo from a GUI session to restore Keychain persistence.';

/**
 * macOS production credential store wrapper. Prefers Keychain for secure
 * persistence. When the Keychain is locked or unavailable (daemon running
 * in screen / SSH / launchd without a GUI security session), the wrapper
 * tries to recover via the macOS GUI unlock dialog and then falls back to
 * the encrypted `DatabaseCredentialStore` so credential writes still
 * succeed. Reads tolerate a locked Keychain silently so env/settings
 * discovery can keep providers usable.
 *
 * `fallback` and `unlockers` are optional so unit tests can pin behaviour
 * without spawning real `security` invocations. The TTY gate that
 * determines whether the default unlocker fires is owned by
 * `buildDefaultUnlockers(ttyCheck)` — tests exercise that factory
 * directly rather than going through this constructor.
 *
 * Note on weaker isolation: the encrypted fallback lives in a
 * `provider_credentials` table inside the daemon's main SQLite database
 * (path configurable via `DB_PATH`, defaults to
 * `~/.hyperneo/data/daemon.db`), with its AES key at
 * `~/.hyperneo/.provider-credential-key` (0600). Any same-user process can
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
  // Values written to the fallback while the Keychain was unavailable; they
  // supersede the stale Keychain entry until reconciled, so reads prefer them
  // and promote them to the Keychain once reachable again.
  private readonly pendingSupersede = new Map<string, string>();
  // Per-key lock to serialize supersede promotion (in get) with mutations
  // (set/delete) so a concurrent rotation cannot be overwritten by a stale
  // promotion or recreate a deleted entry.
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
    // If a write superseded the Keychain entry while it was unavailable, prefer
    // that value and reconcile it to the Keychain so reads become authoritative
    // again (otherwise a stale Keychain entry would win once unlocked).
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
    // Keychain unavailable — write the fallback and remember this value
    // supersedes the stale Keychain entry until reconciled on a later read.
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
      // Primary delete succeeded — clear any fallback copy too so a
      // subsequent Keychain lock doesn't surface a stale credential.
      await this.fallback?.delete(service, account).catch(() => {});
      return;
    }
    // Keychain delete did not succeed (locked / no GUI session / unlock
    // attempt failed). Deleting only from the fallback would leave the
    // authoritative Keychain copy behind, and the next time the Keychain
    // becomes reachable `get()` would prefer it — provider appears
    // re-authenticated after the user explicitly logged out. Delete is
    // an irreversible operation against the authoritative store, so we
    // surface the failure rather than claim partial success. Callers
    // (providers.delete, auth.logout) propagate the error to the UI so
    // the user knows to unlock the Keychain and retry.
    this.markKeychainUnavailable();
    throw new KeychainUnavailableError(
      `${KEYCHAIN_UNAVAILABLE_MESSAGE} (blocked: delete(${service}:${account}))`
    );
  }

  /**
   * If the fallback store already has a value for `(service, account)`,
   * overwrite it with `data`. Used by `set()` on successful Keychain
   * writes to keep a previously-fallback-only entry from going stale
   * after a credential rotation. No-op when the fallback has no entry
   * (so we don't broaden the weaker-isolation surface for entries that
   * never needed the fallback). Best-effort: errors are swallowed
   * because the Keychain write already succeeded and is authoritative.
   */
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
    } catch {
      // Swallow — Keychain write succeeded, refresh is best-effort.
    }
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
    if (!this.fallback) {
      this.markKeychainUnavailable();
      throw new KeychainUnavailableError(`${KEYCHAIN_UNAVAILABLE_MESSAGE} (blocked: ${label})`);
    }
    // Run the fallback op FIRST, then mark state + fire the status
    // callback. Firing the callback before the write completes lets an
    // app-level subscriber (e.g. app.ts applyStoredProviderCredentials)
    // re-enter the store mid-flight and race with the in-progress write.
    // Ordering op-before-mark guarantees the write is durable by the
    // time any subscriber observes the `keychain-fallback` transition.
    await op();
    this.markUsingFallback();
  }

  /**
   * Compute the current backend label so mark* helpers can detect actual
   * transitions. The previous logic only fired the statusChangeCallback
   * when transitioning out of the fully-available state, which meant the
   * `keychain-unavailable` → `keychain-fallback` transition (a locked
   * Keychain read followed by a successful fallback write) was silent —
   * connected clients kept showing the yellow unavailable banner even
   * though writes were now succeeding via the fallback. Comparing the
   * backend label before and after fires the callback on every real
   * transition, including the unavailable→fallback recovery.
   */
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
    // Reset the one-shot unlock latch: if the Keychain later re-locks
    // (sleep, `security lock-keychain`, keychain timeout), the next write
    // should attempt interactive unlock again rather than routing blindly
    // to the fallback. Without this, the daemon is stuck on the weaker
    // fallback store until process restart.
    this.unlockAttempted = false;
    if (previousBackend !== this.currentBackend()) this.statusChangeCallback?.();
  }
}

/**
 * Builds the default unlocker list with the given TTY gate. Extracted so
 * `createCredentialStore` can hand in the production `process.stdout.isTTY`
 * check while tests can import this factory and exercise the real gate
 * against a mocked `spawnImpl` (rather than re-implementing the unlocker
 * inline, which wouldn't catch a future refactor dropping the gate here).
 *
 * `timeoutMs` is also injectable so tests can drive the kill-on-timeout
 * path without waiting the full 30s — pass `10` to exercise the
 * setTimeout + child.kill branch with a hung fake child.
 */
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

async function tryUnlockKeychainViaGUI(timeoutMs: number = 30_000): Promise<boolean> {
  // Cap the wait so a detached screen / SSH / tmux session where the GUI
  // dialog can't be seen (or where the user stepped away) does not block
  // a credential write indefinitely. The spike proved `security
  // unlock-keychain` fails fast with code 36 when there is genuinely no
  // Aqua session, so this timeout only fires in the rarer "Aqua session
  // exists but the user cannot interact with it" case.
  //
  // Uses spawn+kill rather than Promise.race+execFile so the timeout
  // actually cancels the child process. With Promise.race alone the
  // `security unlock-keychain` subprocess keeps running behind the hung
  // dialog and accumulates one stray process per credential write until
  // the user finally dismisses the dialog (or never). Kill on timeout
  // guarantees no stray processes; the dialog itself may linger on the
  // desktop but the daemon does not.
  return new Promise<boolean>((resolve) => {
    const child = spawn('security', ['unlock-keychain'], { stdio: 'ignore' });
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
      } catch {
        // Already exited — nothing to kill.
      }
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
