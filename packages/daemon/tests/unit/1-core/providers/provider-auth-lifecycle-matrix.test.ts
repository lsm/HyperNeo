import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { vi } from 'vitest';
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

const CODEX_COMPAT_CLIENT_VERSION = '0.148.0';

const fsPromiseMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  unlink: vi.fn(),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readFile: (...args: unknown[]) => fsPromiseMocks.readFile(...args),
    writeFile: (...args: unknown[]) => fsPromiseMocks.writeFile(...args),
    rename: (...args: unknown[]) => fsPromiseMocks.rename(...args),
    unlink: (...args: unknown[]) => fsPromiseMocks.unlink(...args),
  };
});

const OAUTH_PROBE_URL = `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_COMPAT_CLIENT_VERSION}`;
const API_KEY_PROBE_URL = `https://api.openai.com/v1/models?client_version=${CODEX_COMPAT_CLIENT_VERSION}`;

type Mode = 'oauth' | 'api_key';

const MODES: Array<{ mode: Mode; label: string }> = [
  { mode: 'oauth', label: 'OAuth (ChatGPT PKCE)' },
  { mode: 'api_key', label: 'API key' },
];

function probeUrlFor(mode: Mode): string {
  return mode === 'oauth' ? OAUTH_PROBE_URL : API_KEY_PROBE_URL;
}

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

function writeAuthFile(dir: string, creds: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ openai: creds }), { mode: 0o600 });
}

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

function authFileExists(dir: string): boolean {
  try {
    readFileSync(path.join(dir, 'auth.json'));
    return true;
  } catch {
    return false;
  }
}

function invalidGrantResponse(): Response {
  return new Response('{"error":"invalid_grant"}', {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

describe('Provider auth lifecycle regression matrix', () => {
  const fsSpies = [
    fsPromiseMocks.readFile,
    fsPromiseMocks.writeFile,
    fsPromiseMocks.rename,
    fsPromiseMocks.unlink,
  ];
  let providers: AnthropicToCodexBridgeProvider[] = [];
  let tmpRoot: string;

  beforeEach(() => {
    fsPromiseMocks.readFile.mockImplementation(
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
    );
    fsPromiseMocks.writeFile.mockImplementation(
      (
        filePath: Parameters<typeof fs.writeFile>[0],
        data: Parameters<typeof fs.writeFile>[1],
        options?: Parameters<typeof fs.writeFile>[2]
      ) => {
        const mode = typeof options === 'object' ? (options as { mode?: number }).mode : undefined;
        writeFileSync(
          filePath as Parameters<typeof writeFileSync>[0],
          data as Parameters<typeof writeFileSync>[1],
          mode as Parameters<typeof writeFileSync>[2]
        );
        return Promise.resolve();
      }
    );
    fsPromiseMocks.rename.mockImplementation(
      (oldPath: Parameters<typeof fs.rename>[0], newPath: Parameters<typeof fs.rename>[1]) => {
        renameSync(
          oldPath as Parameters<typeof renameSync>[0],
          newPath as Parameters<typeof renameSync>[1]
        );
        return Promise.resolve();
      }
    );
    fsPromiseMocks.unlink.mockImplementation((filePath: Parameters<typeof fs.unlink>[0]) => {
      unlinkSync(filePath as Parameters<typeof unlinkSync>[0]);
      return Promise.resolve();
    });
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-auth-matrix-'));
    providers = [];
  });

  afterEach(() => {
    for (const p of providers) p.stopAllBridgeServers();
    for (const spy of fsSpies) spy.mockReset();
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

  describe.each(MODES)('$label auth mode', ({ mode }) => {
    it('login: setCredentials() flips availability on', async () => {
      const { hyperneo, codex } = newDirs();
      const provider = track(makeProvider({}, hyperneo, codex, createFetchImpl().impl));

      expect(await provider.isAvailable()).toBe(false);

      provider.setCredentials(loginCredsFor(mode));

      expect(await provider.isAvailable()).toBe(true);
      const status = await provider.getAuthStatus();
      if (mode === 'oauth') {
        expect(status.isAuthenticated).toBe(true);
        expect(status.method).toBe('oauth');
      } else {
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
      expect(await provider.getModels()).toEqual([]);
    });

    it('credential removal: removes the openai entry from auth.json on disk', async () => {
      const { hyperneo, codex } = newDirs();
      writeAuthFile(hyperneo, diskCredsFor(mode));
      const provider = track(makeProvider({}, hyperneo, codex, createFetchImpl().impl));
      expect(readAuthOpenai(hyperneo)).toBeDefined();

      await provider.logout();

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
      const refreshSpy =
        mode === 'oauth'
          ? spyOn(globalThis, 'fetch').mockResolvedValue(invalidGrantResponse())
          : undefined;

      try {
        await expect(provider.getModels()).rejects.toThrow('Codex credentials rejected (HTTP 401)');
      } finally {
        refreshSpy?.mockRestore();
      }
    });

    it('re-add after removal: a fresh login restores auth after logout', async () => {
      const { hyperneo, codex } = newDirs();
      const fetcher = createFetchImpl();
      const provider = track(makeProvider({}, hyperneo, codex, fetcher.impl));
      provider.setCredentials(loginCredsFor(mode));
      expect(await provider.isAvailable()).toBe(true);
      await provider.logout();
      expect(await provider.isAvailable()).toBe(false);

      provider.setCredentials(loginCredsFor(mode));

      expect(await provider.isAvailable()).toBe(true);
      expect((await provider.getModels()).length).toBeGreaterThan(0);
    });
  });

  describe('composed lifecycle walk (cross-stage state transitions)', () => {
    it.each(
      MODES
    )('$label: login → authenticated call → logout → re-add → authenticated call', async ({
      mode,
    }) => {
      const { hyperneo, codex } = newDirs();
      const fetcher = createFetchImpl();
      const provider = track(makeProvider({}, hyperneo, codex, fetcher.impl));

      provider.setCredentials(loginCredsFor(mode, 1));
      expect(await provider.isAvailable()).toBe(true);
      expect((await provider.getModels()).length).toBeGreaterThan(0);
      expect(fetcher.calls[0].url).toBe(probeUrlFor(mode));

      await provider.logout();
      expect(await provider.isAvailable()).toBe(false);
      expect(await provider.getModels()).toEqual([]);

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

      const refreshSpy = spyOn(globalThis, 'fetch').mockResolvedValue(invalidGrantResponse());
      try {
        expect(await provider.refreshToken()).toBe(false);
      } finally {
        refreshSpy.mockRestore();
      }

      expect(await provider.isAvailable()).toBe(false);
      expect(authFileExists(hyperneo)).toBe(false);

      provider.setCredentials(loginCredsFor('oauth'));
      expect(await provider.isAvailable()).toBe(true);
      expect((await provider.getModels()).length).toBeGreaterThan(0);
      expect(fetcher.calls[0].url).toBe(OAUTH_PROBE_URL);
    });

    it('OAuth: removal then re-add then stale-token-cleanup clears again (no zombie cache)', async () => {
      const { hyperneo, codex } = newDirs();
      const provider = track(makeProvider({}, hyperneo, codex, createFetchImpl().impl));

      provider.setCredentials(loginCredsFor('oauth'));
      await provider.logout();
      provider.setCredentials(loginCredsFor('oauth'));
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
