/**
 * Provider auth lifecycle regression matrix
 *
 * Walks the full auth lifecycle on AnthropicToCodexBridgeProvider — the Codex
 * bridge, which is the regression target and uniquely supports BOTH auth modes
 * natively:
 *   - OAuth   (ChatGPT PKCE → ~/.hyperneo/auth.json["openai"])
 *   - API key (imported key or OPENAI_API_KEY env)
 *
 * Lifecycle stages (task #755):
 *   1. login               — setCredentials() (the post-OAuth-callback path)
 *   2. authenticated call  — getModels() probes the correct upstream
 *   3. logout              — provider.logout() clears the in-memory cache
 *   4. credential removal  — auth.json["openai"] removed from disk
 *   5. stale token cleanup — refreshToken() definitive vs transient (OAuth);
 *                            no-op for API key (no token to refresh)
 *   6. failed credential   — probe 401 surfaces a rejection error
 *   7. re-add after removal — fresh login restores auth with no stale leak
 *
 * Why a matrix (vs the per-scenario tests in
 * anthropic-to-codex-bridge-provider.test.ts): the sibling suite tests each
 * stage in isolation. This suite COMPOSES the stages — driving
 * login → call → logout → stale-cleanup → re-add on one instance — to pin the
 * cross-stage state-machine transitions that broke ("stale-token and
 * removal/re-add flows"). The composed walks at the bottom are the
 * highest-signal cases.
 *
 * Fetch seams: probeUpstream() uses the injected fetchImpl, but
 * refreshCodexToken() calls the module-level global fetch. Probe stages use
 * the injected impl; refresh stages spy on globalThis.fetch.
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProviderCredentials } from '@hyperneo/shared/provider';
import { AnthropicToCodexBridgeProvider } from '../../../../src/lib/providers/anthropic-to-codex-bridge-provider';

// ---------------------------------------------------------------------------
// Constants & fixtures
// ---------------------------------------------------------------------------

const OAUTH_PROBE_URL = 'https://chatgpt.com/backend-api/codex/responses';
const API_KEY_PROBE_URL = 'https://api.openai.com/v1/responses';

type Mode = 'oauth' | 'api_key';

const MODES: Array<{ mode: Mode; label: string }> = [
  { mode: 'oauth', label: 'OAuth (ChatGPT PKCE)' },
  { mode: 'api_key', label: 'API key' },
];

function probeUrlFor(mode: Mode): string {
  return mode === 'oauth' ? OAUTH_PROBE_URL : API_KEY_PROBE_URL;
}

/**
 * Credentials handed to setCredentials() — the post-OAuth-callback login path.
 * `variant` distinguishes a re-added credential from the original: the probe
 * cache (`verifyCredentials`) keys on `bridgeAuthCacheKey(auth)` (account id for
 * OAuth, sha256 of the key for API key), so re-adding a *different* credential
 * forces a genuine second upstream probe rather than hitting the 30s cache.
 */
function loginCredsFor(mode: Mode, variant: 1 | 2 = 1): ProviderCredentials {
  const accessToken = variant === 1 ? 'oauth-access-matrix' : 'oauth-access-readded';
  const refreshToken = variant === 1 ? 'oauth-refresh-matrix' : 'oauth-refresh-readded';
  const accountId = variant === 1 ? 'acct-matrix' : 'acct-readded';
  const apiKey = variant === 1 ? 'sk-matrix-key' : 'sk-readded-key';
  if (mode === 'oauth') {
    return {
      type: 'oauth',
      accessToken,
      refreshToken,
      expiresAt: Date.now() + 3_600_000,
      raw: { accountId },
    };
  }
  return { type: 'api_key', apiKey };
}

/** On-disk openai entry shape for ~/.hyperneo/auth.json (persisted creds). */
function diskCredsFor(mode: Mode): Record<string, unknown> {
  if (mode === 'oauth') {
    return {
      type: 'oauth',
      access: 'oauth-access-matrix',
      refresh: 'oauth-refresh-matrix',
      expires: Date.now() + 3_600_000,
      accountId: 'acct-matrix',
    };
  }
  return { type: 'api_key', access: 'sk-matrix-key' };
}

/** Write ~/.hyperneo/auth.json with an openai entry. */
function writeAuthFile(dir: string, creds: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ openai: creds }), { mode: 0o600 });
}

/** Read the openai entry from an auth.json dir, or undefined if absent. */
function readAuthOpenai(dir: string): Record<string, unknown> | undefined {
  try {
    const data = JSON.parse(readFileSync(path.join(dir, 'auth.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    return data.openai as Record<string, unknown> | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether ~/.hyperneo/auth.json exists in `dir`. Used for removal assertions
 * where `readAuthOpenai()` returning `undefined` must mean the file was cleanly
 * unlinked, not truncated/corrupted (which a swallowed-parse check would hide).
 */
function authFileExists(dir: string): boolean {
  try {
    readFileSync(path.join(dir, 'auth.json'));
    return true;
  } catch {
    return false;
  }
}

/** 401 invalid_grant refresh response — definitive refresh failure. */
function invalidGrantResponse(): Response {
  return new Response('{"error":"invalid_grant"}', {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Controllable fetch for the injected fetchImpl. Returns queued responses in
 * order, then a default 200. Records every call.
 */
function createFetchImpl(): {
  impl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
  enqueue(resp: Response): void;
  setDefault(resp: Response): void;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queue: Response[] = [];
  let defaultResponse = new Response('{}', { status: 200 });
  const impl = mock(async (url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return queue.length > 0 ? (queue.shift() as Response) : defaultResponse;
  }) as unknown as typeof fetch;
  return {
    impl,
    calls,
    enqueue(resp: Response): void {
      queue.push(resp);
    },
    setDefault(resp: Response): void {
      defaultResponse = resp;
    },
  };
}

function makeProvider(
  env: Record<string, string | undefined>,
  authDir: string,
  codexAuthDir: string,
  fetchImpl: typeof fetch
): AnthropicToCodexBridgeProvider {
  return new AnthropicToCodexBridgeProvider(env, authDir, codexAuthDir, fetchImpl);
}

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

describe('Provider auth lifecycle regression matrix', () => {
  let fsSpies: ReturnType<typeof spyOn>[] = [];
  let providers: AnthropicToCodexBridgeProvider[] = [];
  let tmpRoot: string;

  beforeEach(() => {
    // Bridge the Bun/Linux async-fs race (same workaround as the sibling suite):
    // route async fs ops through sync counterparts so fixtures are visible to
    // the provider's loadCredentials()/saveCredentials()/logout().
    fsSpies = [
      spyOn(fs, 'readFile').mockImplementation(
        (
          filePath: Parameters<typeof fs.readFile>[0],
          options?: Parameters<typeof fs.readFile>[1]
        ) => {
          const encoding =
            typeof options === 'string'
              ? options
              : (options as { encoding?: BufferEncoding })?.encoding;
          return Promise.resolve(
            readFileSync(filePath as Parameters<typeof readFileSync>[0], encoding as BufferEncoding)
          );
        }
      ),
      spyOn(fs, 'writeFile').mockImplementation(
        (
          filePath: Parameters<typeof fs.writeFile>[0],
          data: Parameters<typeof fs.writeFile>[1],
          options?: Parameters<typeof fs.writeFile>[2]
        ) => {
          const mode =
            typeof options === 'object' ? (options as { mode?: number }).mode : undefined;
          writeFileSync(
            filePath as Parameters<typeof writeFileSync>[0],
            data as Parameters<typeof writeFileSync>[1],
            mode as Parameters<typeof writeFileSync>[2]
          );
          return Promise.resolve();
        }
      ),
      spyOn(fs, 'rename').mockImplementation(
        (oldPath: Parameters<typeof fs.rename>[0], newPath: Parameters<typeof fs.rename>[1]) => {
          renameSync(
            oldPath as Parameters<typeof renameSync>[0],
            newPath as Parameters<typeof renameSync>[1]
          );
          return Promise.resolve();
        }
      ),
      spyOn(fs, 'unlink').mockImplementation((filePath: Parameters<typeof fs.unlink>[0]) => {
        unlinkSync(filePath as Parameters<typeof unlinkSync>[0]);
        return Promise.resolve();
      }),
    ];
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-auth-matrix-'));
    providers = [];
  });

  afterEach(() => {
    for (const p of providers) p.stopAllBridgeServers();
    for (const spy of fsSpies) spy.mockRestore();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function newDirs(): { hyperneo: string; codex: string } {
    return {
      hyperneo: mkdtempSync(path.join(tmpRoot, 'neo-')),
      codex: mkdtempSync(path.join(tmpRoot, 'codex-')),
    };
  }

  function track(provider: AnthropicToCodexBridgeProvider): AnthropicToCodexBridgeProvider {
    providers.push(provider);
    return provider;
  }

  // -------------------------------------------------------------------------
  // Per-mode stage matrix
  // -------------------------------------------------------------------------

  describe.each(MODES)('$label auth mode', ({ mode }) => {
    it('login: setCredentials() flips availability on', async () => {
      const { hyperneo, codex } = newDirs();
      const provider = track(makeProvider({}, hyperneo, codex, createFetchImpl().impl));

      expect(await provider.isAvailable()).toBe(false); // unauthenticated before login

      provider.setCredentials(loginCredsFor(mode));

      expect(await provider.isAvailable()).toBe(true);
      const status = await provider.getAuthStatus();
      if (mode === 'oauth') {
        expect(status.isAuthenticated).toBe(true);
        expect(status.method).toBe('oauth');
      } else {
        // API-key auth powers API calls but is not a UI-authenticated session.
        expect(status.isAuthenticated).toBe(false);
      }
    });

    it('authenticated call: getModels() probes the correct upstream and returns the catalogue', async () => {
      const { hyperneo, codex } = newDirs();
      const fetcher = createFetchImpl();
      const provider = track(makeProvider({}, hyperneo, codex, fetcher.impl));
      provider.setCredentials(loginCredsFor(mode));

      const models = await provider.getModels();

      expect(models.length).toBeGreaterThan(0);
      expect(fetcher.calls).toHaveLength(1);
      expect(fetcher.calls[0].url).toBe(probeUrlFor(mode));
      const headers = new Headers(fetcher.calls[0].init.headers);
      expect(headers.get('authorization')).toBe(
        mode === 'oauth' ? 'Bearer oauth-access-matrix' : 'Bearer sk-matrix-key'
      );
      if (mode === 'oauth') {
        expect(headers.get('ChatGPT-Account-ID')).toBe('acct-matrix');
      }
    });

    it('logout: clears the in-memory cache so the provider reports unauthenticated', async () => {
      const { hyperneo, codex } = newDirs();
      const provider = track(makeProvider({}, hyperneo, codex, createFetchImpl().impl));
      provider.setCredentials(loginCredsFor(mode));
      expect(await provider.isAvailable()).toBe(true);

      await provider.logout();

      expect(await provider.isAvailable()).toBe(false);
      expect(await provider.getApiKey()).toBeUndefined();
      // Auth gate (getBridgeAuth) returns no auth → getModels short-circuits to []
      // without probing, so a stale cached probe can never fake "healthy".
      expect(await provider.getModels()).toEqual([]);
    });

    it('credential removal: removes the openai entry from auth.json on disk', async () => {
      const { hyperneo, codex } = newDirs();
      writeAuthFile(hyperneo, diskCredsFor(mode)); // start from persisted state
      const provider = track(makeProvider({}, hyperneo, codex, createFetchImpl().impl));
      expect(readAuthOpenai(hyperneo)).toBeDefined();

      await provider.logout();

      // The openai key is gone. Because openai was the only entry, logout()
      // unlinks auth.json entirely — assert the file is actually gone rather
      // than merely unreadable (a corrupted/truncated write would also make
      // readAuthOpenai() return undefined and falsely pass).
      expect(authFileExists(hyperneo)).toBe(false);
    });

    if (mode === 'oauth') {
      it('stale token cleanup: definitive refresh failure (401) clears credentials', async () => {
        const { hyperneo, codex } = newDirs();
        writeAuthFile(hyperneo, {
          type: 'oauth',
          access: 'stale-access',
          refresh: 'invalid-refresh',
          expires: Date.now() - 60_000,
          accountId: 'acct-matrix',
        });
        const provider = track(makeProvider({}, hyperneo, codex, createFetchImpl().impl));
        const refreshSpy = spyOn(globalThis, 'fetch').mockResolvedValue(invalidGrantResponse());
        try {
          expect(await provider.refreshToken()).toBe(false);
          expect(await provider.isAvailable()).toBe(false);
          expect(await provider.getApiKey()).toBeUndefined();
          expect(authFileExists(hyperneo)).toBe(false);
        } finally {
          refreshSpy.mockRestore();
        }
      });

      it('stale token cleanup: transient refresh failure (5xx) preserves credentials', async () => {
        const { hyperneo, codex } = newDirs();
        writeAuthFile(hyperneo, {
          type: 'oauth',
          access: 'valid-access',
          refresh: 'valid-refresh',
          expires: Date.now() + 3_600_000,
          accountId: 'acct-matrix',
        });
        const provider = track(makeProvider({}, hyperneo, codex, createFetchImpl().impl));
        const refreshSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response('{"error":"internal"}', {
            status: 503,
            headers: { 'Content-Type': 'application/json' },
          })
        );
        try {
          expect(await provider.refreshToken()).toBe(false);
          expect(await provider.isAvailable()).toBe(true);
          expect(await provider.getApiKey()).toBe('valid-access');
          // Credentials preserved intact on disk (not truncated/corrupted).
          const preserved = readAuthOpenai(hyperneo);
          expect(preserved).toBeDefined();
          expect(preserved?.access).toBe('valid-access');
        } finally {
          refreshSpy.mockRestore();
        }
      });
    } else {
      it('stale token cleanup: refreshToken is a no-op for API-key credentials (no token)', async () => {
        const { hyperneo, codex } = newDirs();
        const provider = track(makeProvider({}, hyperneo, codex, createFetchImpl().impl));
        provider.setCredentials(loginCredsFor('api_key'));

        expect(await provider.refreshToken()).toBe(false);
        // Credentials unchanged — API keys have no refresh lifecycle.
        expect(await provider.isAvailable()).toBe(true);
        expect(await provider.getApiKey()).toBe('sk-matrix-key');
      });
    }

    it('failed credential behavior: probe 401 surfaces a rejection error', async () => {
      const { hyperneo, codex } = newDirs();
      const fetcher = createFetchImpl();
      fetcher.setDefault(new Response('unauthorized', { status: 401 }));
      const provider = track(makeProvider({}, hyperneo, codex, fetcher.impl));
      provider.setCredentials(loginCredsFor(mode));

      await expect(provider.getModels()).rejects.toThrow('Codex credentials rejected (HTTP 401)');
    });

    it('re-add after removal: a fresh login restores auth after logout', async () => {
      const { hyperneo, codex } = newDirs();
      const fetcher = createFetchImpl();
      const provider = track(makeProvider({}, hyperneo, codex, fetcher.impl));
      provider.setCredentials(loginCredsFor(mode));
      expect(await provider.isAvailable()).toBe(true);
      await provider.logout();
      expect(await provider.isAvailable()).toBe(false);

      provider.setCredentials(loginCredsFor(mode)); // re-add

      expect(await provider.isAvailable()).toBe(true);
      // getModels returns the catalogue only when getBridgeAuth resolves auth —
      // a stale logged-out cache would instead return [].
      expect((await provider.getModels()).length).toBeGreaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Composed lifecycle walks — the regression class
  // -------------------------------------------------------------------------

  describe('composed lifecycle walk (cross-stage state transitions)', () => {
    it.each(
      MODES
    )('$label: login → authenticated call → logout → re-add → authenticated call', async ({
      mode,
    }) => {
      const { hyperneo, codex } = newDirs();
      const fetcher = createFetchImpl();
      const provider = track(makeProvider({}, hyperneo, codex, fetcher.impl));

      // login + authenticated call (probe 1)
      provider.setCredentials(loginCredsFor(mode, 1));
      expect(await provider.isAvailable()).toBe(true);
      expect((await provider.getModels()).length).toBeGreaterThan(0);
      expect(fetcher.calls[0].url).toBe(probeUrlFor(mode));

      // logout (removal)
      await provider.logout();
      expect(await provider.isAvailable()).toBe(false);
      expect(await provider.getModels()).toEqual([]);

      // re-add with a DISTINCT credential. verifyCredentials() caches a
      // successful probe for 30s keyed by bridgeAuthCacheKey(auth); re-adding
      // the same key/account would hit that cache and skip the upstream probe,
      // so a different credential is required to force a genuine second
      // authenticated request and make a stale-auth regression observable.
      provider.setCredentials(loginCredsFor(mode, 2));
      expect(await provider.isAvailable()).toBe(true);
      expect((await provider.getModels()).length).toBeGreaterThan(0);
      expect(fetcher.calls).toHaveLength(2);
      expect(fetcher.calls[1].url).toBe(probeUrlFor(mode));
      const readdedHeaders = new Headers(fetcher.calls[1].init.headers);
      expect(readdedHeaders.get('authorization')).toBe(
        mode === 'oauth' ? 'Bearer oauth-access-readded' : 'Bearer sk-readded-key'
      );
    });

    it('OAuth: stale-token-cleanup then removal then re-add restores auth (regression target)', async () => {
      // Headline bug class: a definitive refresh failure wipes creds; the user
      // must then be able to log back in cleanly with no stale-cache leak.
      const { hyperneo, codex } = newDirs();
      writeAuthFile(hyperneo, {
        type: 'oauth',
        access: 'stale-access',
        refresh: 'invalid-refresh',
        expires: Date.now() - 60_000,
        accountId: 'acct-matrix',
      });
      const fetcher = createFetchImpl();
      const provider = track(makeProvider({}, hyperneo, codex, fetcher.impl));

      // stale-token-cleanup: definitive refresh failure wipes creds + disk
      const refreshSpy = spyOn(globalThis, 'fetch').mockResolvedValue(invalidGrantResponse());
      try {
        expect(await provider.refreshToken()).toBe(false);
      } finally {
        refreshSpy.mockRestore();
      }

      expect(await provider.isAvailable()).toBe(false);
      expect(authFileExists(hyperneo)).toBe(false);

      // re-add via a fresh login (post-callback setCredentials path)
      provider.setCredentials(loginCredsFor('oauth'));
      expect(await provider.isAvailable()).toBe(true);
      expect((await provider.getModels()).length).toBeGreaterThan(0);
      expect(fetcher.calls[0].url).toBe(OAUTH_PROBE_URL);
    });

    it('OAuth: removal then re-add then stale-token-cleanup clears again (no zombie cache)', async () => {
      // A second lifecycle cycle must clear credentials just like the first —
      // no in-memory cache may resurrect a logged-out state across cycles.
      const { hyperneo, codex } = newDirs();
      const provider = track(makeProvider({}, hyperneo, codex, createFetchImpl().impl));

      provider.setCredentials(loginCredsFor('oauth'));
      await provider.logout();
      provider.setCredentials(loginCredsFor('oauth')); // re-add
      expect(await provider.isAvailable()).toBe(true);

      const refreshSpy = spyOn(globalThis, 'fetch').mockResolvedValue(invalidGrantResponse());
      try {
        expect(await provider.refreshToken()).toBe(false);
      } finally {
        refreshSpy.mockRestore();
      }

      expect(await provider.isAvailable()).toBe(false);
      expect(await provider.getApiKey()).toBeUndefined();
    });
  });
});
