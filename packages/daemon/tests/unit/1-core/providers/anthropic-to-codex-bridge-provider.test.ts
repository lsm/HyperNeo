/**
 * Unit tests for AnthropicToCodexBridgeProvider
 *
 * Covers:
 *  - getAuthStatus(): HyperNeo OAuth only (env vars → unauthenticated), file-based auth, missing credentials, missing binary
 *  - getApiKey(): full discovery chain (env → ~/.hyperneo/auth.json → ~/.codex/auth.json)
 *  - importFromCodexAuth(): one-time migration scenarios (API key, OAuth with/without refresh)
 *  - buildSdkConfig(): Responses bridge server reuse and auth refresh
 */

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import * as fs from 'fs/promises';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'path';
import * as os from 'os';
import type { ProviderCredentials } from '@hyperneo/shared/provider';
import { AnthropicToCodexBridgeProvider } from '../../../../src/lib/providers/anthropic-to-codex-bridge-provider';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a provider instance pointing at isolated temp auth dirs. */
function makeProvider(
  env: Record<string, string | undefined> = {},
  authDir?: string,
  codexAuthDir?: string,
  fetchImpl: typeof fetch = mock(
    async () => new Response('{}', { status: 200 })
  ) as unknown as typeof fetch
): AnthropicToCodexBridgeProvider {
  return new AnthropicToCodexBridgeProvider(env, authDir, codexAuthDir, fetchImpl);
}

/**
 * Write a HyperNeo auth.json with an openai entry to a temp dir.
 *
 * Uses synchronous I/O to ensure the file is fully written before the
 * provider reads it — Bun 1.3.10 on Linux may resolve async writes before
 * data is durable, causing immediate subsequent reads to fail.
 */
function writeHyperNeoAuth(dir: string, credentials: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ openai: credentials }), {
    mode: 0o600,
  });
}

/**
 * Write a ~/.codex/auth.json format file to a temp dir.
 *
 * Uses synchronous I/O for the same reason as writeHyperNeoAuth.
 */
function writeCodexAuth(
  dir: string,
  data: {
    OPENAI_API_KEY?: string | null;
    tokens?: {
      access_token?: string;
      refresh_token?: string;
      account_id?: string;
      id_token?: string | Record<string, unknown>;
    };
  }
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(data), { mode: 0o600 });
}

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

// ---------------------------------------------------------------------------
// getAuthStatus() — auth gate
// ---------------------------------------------------------------------------

describe('AnthropicToCodexBridgeProvider', () => {
  let provider: AnthropicToCodexBridgeProvider;
  let fsSpies: ReturnType<typeof spyOn>[];

  /**
   * Workaround for Bun 1.3.11 on Linux CI: `fs/promises.readFile` may not
   * see files written by `node:fs.writeFileSync` in rapid succession (likely a
   * kernel page-cache race on ext4).  Bridge all async fs operations through
   * their sync counterparts so that test fixtures are reliably visible to the
   * provider's internal `loadCredentials()` / `importFromCodexAuth()` methods.
   */
  beforeEach(() => {
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
  });

  afterEach(() => {
    provider?.stopAllBridgeServers();
    fsSpies.forEach((spy) => spy.mockRestore());
  });

  describe('capabilities', () => {
    beforeEach(() => {
      provider = makeProvider({}, undefined, undefined);
    });

    it('reports the maximum Codex context window', () => {
      expect(provider.capabilities.maxContextWindow).toBe(1050000);
    });

    it('advertises thinking when the Responses adapter is active', () => {
      expect(provider.capabilities.extendedThinking).toBe(true);
      expect(provider.capabilities.thinkingModes).toBe('granular');
    });
  });

  describe('getAuthStatus()', () => {
    let emptyDir: string;

    beforeEach(() => {
      // Use isolated empty dirs so file-based auth doesn't interfere
      emptyDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-auth-test-'));
    });

    afterEach(() => {
      rmSync(emptyDir, { recursive: true, force: true });
    });

    it('returns isAuthenticated=false when no credentials', async () => {
      provider = makeProvider({}, emptyDir, emptyDir);
      const result = await provider.getAuthStatus();
      expect(result.isAuthenticated).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('returns isAuthenticated=false when only OPENAI_API_KEY env var is set (env vars are daemon/test only)', async () => {
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, emptyDir, emptyDir);
      const result = await provider.getAuthStatus();
      expect(result.isAuthenticated).toBe(false);
    });

    it('returns isAuthenticated=false with descriptive error when env vars are empty', async () => {
      provider = makeProvider({ OPENAI_API_KEY: '' }, emptyDir, emptyDir);
      const result = await provider.getAuthStatus();
      expect(result.isAuthenticated).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('returns isAuthenticated=true with HyperNeo OAuth credentials even when codex is missing in Responses adapter mode', async () => {
      const hyperneoDir = path.join(emptyDir, 'hyperneo');
      const codexDir = path.join(emptyDir, 'codex');
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'oauth-access-token',
        refresh: 'oauth-refresh-token',
        expires: Date.now() + 3600_000,
      });
      provider = makeProvider({}, hyperneoDir, codexDir);
      const result = await provider.getAuthStatus();
      expect(result.isAuthenticated).toBe(true);
      expect(result.method).toBe('oauth');
    });

    it('returns isAuthenticated=true when HyperNeo OAuth credentials in auth.json and codex found', async () => {
      const hyperneoDir = path.join(emptyDir, 'hyperneo');
      const codexDir = path.join(emptyDir, 'codex');
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'oauth-access-token',
        refresh: 'oauth-refresh-token',
        expires: Date.now() + 3600_000,
        accountId: 'user_abc123',
      });
      provider = makeProvider({}, hyperneoDir, codexDir);
      const result = await provider.getAuthStatus();
      expect(result.isAuthenticated).toBe(true);
      expect(result.method).toBe('oauth');
    });

    it('returns isAuthenticated=false for api_key type in auth.json (not HyperNeo OAuth)', async () => {
      const hyperneoDir = path.join(emptyDir, 'hyperneo');
      const codexDir = path.join(emptyDir, 'codex');
      writeHyperNeoAuth(hyperneoDir, { type: 'api_key', access: 'sk-imported-key' });
      provider = makeProvider({}, hyperneoDir, codexDir);
      const result = await provider.getAuthStatus();
      expect(result.isAuthenticated).toBe(false);
    });

    it('sets needsRefresh when HyperNeo OAuth token is expired', async () => {
      const hyperneoDir = path.join(emptyDir, 'hyperneo');
      const codexDir = path.join(emptyDir, 'codex');
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'oauth-access-token',
        refresh: 'oauth-refresh-token',
        // expires 1 minute ago (past the 5-min buffer)
        expires: Date.now() - 60_000,
      });
      provider = makeProvider({}, hyperneoDir, codexDir);
      const result = await provider.getAuthStatus();
      expect(result.isAuthenticated).toBe(true);
      expect(result.needsRefresh).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // getApiKey() — credential discovery chain
  // -------------------------------------------------------------------------

  describe('getApiKey() credential discovery chain', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-codex-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('Priority 1: returns OPENAI_API_KEY env var immediately', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');
      writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'hyperneo-token' });
      writeCodexAuth(codexDir, { tokens: { access_token: 'codex-token' } });

      provider = makeProvider({ OPENAI_API_KEY: 'env-api-key' }, hyperneoDir, codexDir);
      expect(await provider.getApiKey()).toBe('env-api-key');
    });

    it('Priority 3: returns access token from ~/.hyperneo/auth.json when no env var', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');
      writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'hyperneo-access-token' });
      writeCodexAuth(codexDir, { tokens: { access_token: 'should-not-be-used' } });

      provider = makeProvider({}, hyperneoDir, codexDir);
      expect(await provider.getApiKey()).toBe('hyperneo-access-token');
    });

    it('loads provider-owned credentials from disk before row replay checks', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'fresh-disk-token',
        refresh: 'fresh-refresh-token',
        expires: Date.now() + 3600_000,
      });

      provider = makeProvider({}, hyperneoDir, codexDir);
      expect(await provider.getCredentials()).toMatchObject({
        type: 'oauth',
        accessToken: 'fresh-disk-token',
        refreshToken: 'fresh-refresh-token',
      });
    });

    it('imports ~/.codex/auth.json into provider-owned credentials when no hyperneo auth exists', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo'); // no file written
      const codexDir = path.join(tmpDir, 'codex');
      writeCodexAuth(codexDir, { OPENAI_API_KEY: 'codex-imported-key' });

      provider = makeProvider({}, hyperneoDir, codexDir);
      const credentials = await provider.getCredentials();
      expect(credentials).toEqual({ type: 'api_key', apiKey: 'codex-imported-key' });
    });

    it('Priority 4a: returns OPENAI_API_KEY from ~/.codex/auth.json when no higher source', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo'); // no file written
      const codexDir = path.join(tmpDir, 'codex');
      writeCodexAuth(codexDir, { OPENAI_API_KEY: 'codex-file-api-key' });

      provider = makeProvider({}, hyperneoDir, codexDir);
      expect(await provider.getApiKey()).toBe('codex-file-api-key');
    });

    it('Priority 4b: returns access_token from ~/.codex/auth.json when OPENAI_API_KEY is null', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo'); // no file written
      const codexDir = path.join(tmpDir, 'codex');
      writeCodexAuth(codexDir, {
        OPENAI_API_KEY: null,
        tokens: { access_token: 'codex-oauth-token' },
      });

      provider = makeProvider({}, hyperneoDir, codexDir);
      expect(await provider.getApiKey()).toBe('codex-oauth-token');
    });

    it('returns undefined when all sources are absent', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo'); // no file
      const codexDir = path.join(tmpDir, 'codex'); // no file

      provider = makeProvider({}, hyperneoDir, codexDir);
      expect(await provider.getApiKey()).toBeUndefined();
    });

    it('empty-string env var falls through to file-based auth', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');
      writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'hyperneo-fallback-token' });

      // OPENAI_API_KEY='' is falsy — should not block file-based lookup
      provider = makeProvider({ OPENAI_API_KEY: '' }, hyperneoDir, codexDir);
      expect(await provider.getApiKey()).toBe('hyperneo-fallback-token');
    });

    it('env var takes priority over both auth files', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');
      writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'hyperneo-token' });
      writeCodexAuth(codexDir, {
        OPENAI_API_KEY: 'codex-api-key',
        tokens: { access_token: 'codex-bearer' },
      });

      provider = makeProvider({ OPENAI_API_KEY: 'env-wins' }, hyperneoDir, codexDir);
      expect(await provider.getApiKey()).toBe('env-wins');
    });
  });

  // -------------------------------------------------------------------------
  // buildSdkConfig() — workspace isolation
  // -------------------------------------------------------------------------

  describe('buildSdkConfig() bridge server routing', () => {
    beforeEach(() => {
      provider = makeProvider({ OPENAI_API_KEY: 'sk-placeholder' }, undefined, undefined);
    });

    it('shares the Responses bridge server across workspace paths with the same auth', () => {
      const cfgA = provider.buildSdkConfig('gpt-5.3-codex', { workspacePath: '/tmp/workspace-a' });
      const cfgB = provider.buildSdkConfig('gpt-5.3-codex', { workspacePath: '/tmp/workspace-b' });

      const urlA = cfgA.envVars.ANTHROPIC_BASE_URL as string;
      const urlB = cfgB.envVars.ANTHROPIC_BASE_URL as string;
      expect(urlA).toBe(urlB);
      expect(new URL(urlA).port).toBe(new URL(urlB).port);
    });

    it('reuses the same bridge server for the same workspace path', () => {
      const cfg1 = provider.buildSdkConfig('gpt-5.3-codex', {
        workspacePath: '/tmp/workspace-reuse',
      });
      const cfg2 = provider.buildSdkConfig('gpt-5.3-codex', {
        workspacePath: '/tmp/workspace-reuse',
      });
      expect(cfg1.envVars.ANTHROPIC_BASE_URL).toBe(cfg2.envVars.ANTHROPIC_BASE_URL);
    });

    it('recreates a Responses bridge that was started before auth was available', async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-build-cfg-auth-late-'));
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const p = makeProvider({}, hyperneoDir, path.join(tmpDir, 'codex'));
      try {
        const cfgWithoutAuth = p.buildSdkConfig('gpt-5.3-codex', {
          workspacePath: '/tmp/workspace-auth-late',
        });

        writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'file-token-now-available' });
        await p.getApiKey();

        const cfgWithAuth = p.buildSdkConfig('gpt-5.3-codex', {
          workspacePath: '/tmp/workspace-auth-late',
        });

        expect(cfgWithAuth.envVars.ANTHROPIC_BASE_URL).not.toBe(
          cfgWithoutAuth.envVars.ANTHROPIC_BASE_URL
        );
      } finally {
        p.stopAllBridgeServers();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('reuses the same bridge server after OAuth token refresh', async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-build-cfg-refresh-'));
      try {
        const hyperneoDir = path.join(tmpDir, 'hyperneo');
        const accessToken1 = makeJwt({
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct_refresh' },
          jti: 'token-1',
        });
        writeHyperNeoAuth(hyperneoDir, {
          type: 'oauth',
          access: accessToken1,
          refresh: 'refresh-token-1',
        });
        const p = makeProvider({}, hyperneoDir, path.join(tmpDir, 'codex'));
        await p.getApiKey();

        const cfg1 = p.buildSdkConfig('gpt-5.3-codex', { workspacePath: '/tmp/ws-refresh' });
        const port1 = new URL(cfg1.envVars.ANTHROPIC_BASE_URL as string).port;

        // Simulate token rotation while preserving account identity.
        const accessToken2 = makeJwt({
          'https://api.openai.com/auth': { chatgpt_account_id: 'acct_refresh' },
          jti: 'token-2',
        });
        p.setCredentials({
          type: 'oauth',
          accessToken: accessToken2,
          refreshToken: 'refresh-token-2',
          expiresAt: Date.now() + 3600_000,
          raw: { accountId: 'acct_refresh' },
        } as ProviderCredentials);

        const cfg2 = p.buildSdkConfig('gpt-5.3-codex', { workspacePath: '/tmp/ws-refresh' });
        const port2 = new URL(cfg2.envVars.ANTHROPIC_BASE_URL as string).port;

        expect(port2).toBe(port1);

        // The original port must still be reachable: the bridge was not killed.
        const resp = await fetch(`${cfg1.envVars.ANTHROPIC_BASE_URL}/v1/models`);
        expect(resp.status).toBe(200);

        const servers = (p as unknown as { bridgeServers: Map<string, unknown> }).bridgeServers;
        expect(servers.size).toBe(1);

        p.stopAllBridgeServers();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('recreates a Responses bridge when resolved auth changes', async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-build-cfg-auth-change-'));
      const originalFetch = globalThis.fetch;
      const env: Record<string, string | undefined> = { OPENAI_API_KEY: 'sk-first' };
      let fetchSpy: ReturnType<typeof spyOn> | undefined;
      let p: AnthropicToCodexBridgeProvider | undefined;
      try {
        const hyperneoDir = path.join(tmpDir, 'hyperneo');
        p = makeProvider(env, hyperneoDir, path.join(tmpDir, 'codex'));
        const capturedRequests: Array<{
          url: string;
          authorization: string | null;
          accountId: string | null;
        }> = [];
        fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
          (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const url = String(input);
            if (url.startsWith('http://127.0.0.1:')) {
              return originalFetch(input, init);
            }
            const headers = new Headers(init?.headers);
            capturedRequests.push({
              url,
              authorization: headers.get('authorization'),
              accountId: headers.get('chatgpt-account-id'),
            });
            return Promise.resolve(
              new Response(
                'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":0},"output":[]}}\n\n',
                { headers: { 'Content-Type': 'text/event-stream' } }
              )
            );
          }
        );
        const body = JSON.stringify({
          model: 'gpt-5.3-codex',
          max_tokens: 128,
          messages: [{ role: 'user', content: 'hi' }],
        });
        const fetchLocal = async (baseUrl: unknown): Promise<number> => {
          try {
            const resp = await originalFetch(`${baseUrl}/v1/messages`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body,
            });
            await resp.text();
            return resp.status;
          } catch {
            return 0;
          }
        };

        const firstCfg = p.buildSdkConfig('gpt-5.3-codex', {
          workspacePath: '/tmp/workspace-auth-change',
        });
        const firstBaseUrl = firstCfg.envVars.ANTHROPIC_BASE_URL;
        await fetchLocal(firstBaseUrl);

        env.OPENAI_API_KEY = 'sk-second';
        const secondCfg = p.buildSdkConfig('gpt-5.3-codex', {
          workspacePath: '/tmp/workspace-auth-change',
        });
        const secondBaseUrl = secondCfg.envVars.ANTHROPIC_BASE_URL;
        await fetchLocal(secondBaseUrl);
        expect(await fetchLocal(firstBaseUrl)).toBe(0);

        env.OPENAI_API_KEY = undefined;
        writeHyperNeoAuth(hyperneoDir, {
          type: 'oauth',
          access: 'oauth-token',
          accountId: 'acct_new',
        });
        await p.getApiKey();
        const oauthCfg = p.buildSdkConfig('gpt-5.3-codex', {
          workspacePath: '/tmp/workspace-auth-change',
        });
        const oauthBaseUrl = oauthCfg.envVars.ANTHROPIC_BASE_URL;
        await fetchLocal(oauthBaseUrl);
        expect(await fetchLocal(secondBaseUrl)).toBe(0);

        expect(capturedRequests).toMatchObject([
          {
            url: 'https://api.openai.com/v1/responses',
            authorization: 'Bearer sk-first',
            accountId: null,
          },
          {
            url: 'https://api.openai.com/v1/responses',
            authorization: 'Bearer sk-second',
            accountId: null,
          },
          {
            url: 'https://chatgpt.com/backend-api/codex/responses',
            authorization: 'Bearer oauth-token',
            accountId: 'acct_new',
          },
        ]);
      } finally {
        p?.stopAllBridgeServers();
        fetchSpy?.mockRestore();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('returns isAnthropicCompatible=true and clears OAuth token precedence', () => {
      const cfg = provider.buildSdkConfig('gpt-5.3-codex', { workspacePath: '/tmp/ws-compat' });
      expect(cfg.isAnthropicCompatible).toBe(true);
      expect(cfg.envVars.ANTHROPIC_API_KEY).toBe('codex-bridge-default');
      expect(cfg.envVars.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
      expect(cfg.envVars.ANTHROPIC_BASE_URL).toMatch(
        /^http:\/\/127\.0\.0\.1:\d+\/_hyperneo\/session\/default$/
      );
    });

    it('buildSdkConfig() uses cached API key resolved by prior getApiKey() call', async () => {
      // Set up a provider with only file-based auth (no env var)
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-build-cfg-test-'));
      try {
        const hyperneoDir = path.join(tmpDir, 'hyperneo');
        writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'file-based-token' });
        const p = makeProvider({}, hyperneoDir, path.join(tmpDir, 'codex'));
        // Warm the cache as isAvailable() / getAuthStatus() would in QueryRunner
        await p.getApiKey();
        // buildSdkConfig() is synchronous but should use the cached key
        const cfg = p.buildSdkConfig('gpt-5.3-codex', { workspacePath: '/tmp/file-auth-ws' });
        expect(cfg.isAnthropicCompatible).toBe(true);
        expect(cfg.envVars.ANTHROPIC_BASE_URL).toMatch(
          /^http:\/\/127\.0\.0\.1:\d+\/_hyperneo\/session\/default$/
        );
        p.stopAllBridgeServers();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('buildSdkConfig() uses cached key even when OPENAI_API_KEY is empty string', async () => {
      // Empty-string env var must not block the cached file-based key
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-build-cfg-empty-'));
      try {
        const hyperneoDir = path.join(tmpDir, 'hyperneo');
        writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'file-token-not-empty' });
        const p = makeProvider({ OPENAI_API_KEY: '' }, hyperneoDir, path.join(tmpDir, 'codex'));
        await p.getApiKey(); // populates cachedApiKey
        const cfg = p.buildSdkConfig('gpt-5.3-codex', { workspacePath: '/tmp/empty-env-ws' });
        expect(cfg.isAnthropicCompatible).toBe(true);
        expect(cfg.envVars.ANTHROPIC_BASE_URL).toMatch(
          /^http:\/\/127\.0\.0\.1:\d+\/_hyperneo\/session\/default$/
        );
        p.stopAllBridgeServers();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('passes FedRAMP OAuth routing through the Responses bridge auth', async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-build-cfg-fedramp-'));
      const originalFetch = globalThis.fetch;
      let fetchSpy: ReturnType<typeof spyOn> | undefined;
      try {
        const accessToken = makeJwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct_fed',
            chatgpt_plan_type: 'enterprise',
            is_fedramp_account: true,
          },
        });
        const hyperneoDir = path.join(tmpDir, 'hyperneo');
        writeHyperNeoAuth(hyperneoDir, {
          type: 'oauth',
          access: accessToken,
          refresh: 'oauth-refresh-token',
        });
        const p = makeProvider({}, hyperneoDir, path.join(tmpDir, 'codex'));
        await p.getApiKey();

        let capturedHeaders: Headers | undefined;
        fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
          (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const url = String(input);
            if (url.startsWith('http://127.0.0.1:')) {
              return originalFetch(input, init);
            }
            capturedHeaders = new Headers(init?.headers);
            return Promise.resolve(
              new Response(
                'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":0},"output":[]}}\n\n',
                { headers: { 'Content-Type': 'text/event-stream' } }
              )
            );
          }
        );
        const cfg = p.buildSdkConfig('gpt-5.3-codex', { workspacePath: '/tmp/fedramp-ws' });

        const resp = await originalFetch(`${cfg.envVars.ANTHROPIC_BASE_URL}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-5.3-codex',
            max_tokens: 128,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });
        await resp.text();

        expect(capturedHeaders?.get('chatgpt-account-id')).toBe('acct_fed');
        expect(capturedHeaders?.get('x-openai-fedramp')).toBe('true');
        p.stopAllBridgeServers();
      } finally {
        fetchSpy?.mockRestore();
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('sets ANTHROPIC_DEFAULT_*_MODEL env vars to real Codex model IDs', () => {
      // Following the GLM/Kimi pattern, we use real Codex model IDs directly.
      // The SDK reads context window from /v1/models metadata (preferContextWindowMetadata: true)
      // instead of its hardcoded database, avoiding token counting mismatch.
      const cfg = provider.buildSdkConfig('gpt-5.6-terra', { workspacePath: '/tmp/ws-model' });
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.6-terra');
      expect(cfg.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gpt-5.6-luna');
      expect(cfg.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gpt-5.6-sol');
      expect(cfg.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1050000');
    });

    it('routes GPT-5.6 Sol using real Codex ID with context metadata', async () => {
      const cfg = provider.buildSdkConfig('gpt-5.6-sol', { workspacePath: '/tmp/ws-gpt-56-sol' });
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.6-sol');
      expect(cfg.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gpt-5.6-sol');

      const models = await provider.getModels();
      const sol = models.find((model) => model.id === 'gpt-5.6-sol');
      expect(sol?.contextWindow).toBe(1_050_000);
      expect(sol?.preferContextWindowMetadata).toBe(true);
      expect(sol?.sdkModelIds).toContain('gpt-5.6-sol');
    });

    it('resolves model alias to real Codex ID in ANTHROPIC_DEFAULT_SONNET_MODEL', () => {
      const cfg = provider.buildSdkConfig('codex', { workspacePath: '/tmp/ws-alias' });
      // 'codex' is an alias for 'gpt-5.3-codex', now uses real Codex ID
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.3-codex');
    });

    it('keeps the SDK sonnet tier on Luna for mini Codex sessions', () => {
      const cfg = provider.buildSdkConfig('codex-mini', { workspacePath: '/tmp/ws-mini' });
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.6-luna');
      expect(cfg.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gpt-5.6-luna');
      expect(cfg.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1050000');
    });

    it('keeps cross-tier fallback registrations isolated by SDK alias', async () => {
      const originalFetch = globalThis.fetch;
      let fetchSpy: ReturnType<typeof spyOn> | undefined;
      const capturedModels: string[] = [];
      try {
        fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(
          (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            const url = String(input);
            if (url.startsWith('http://127.0.0.1:')) {
              return originalFetch(input, init);
            }
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            capturedModels.push(String(body.model));
            return Promise.resolve(
              new Response(
                'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":0},"output":[]}}\n\n',
                { headers: { 'Content-Type': 'text/event-stream' } }
              )
            );
          }
        );

        const lunaSession = { sessionId: 'luna-with-frontier-fallback', workspacePath: '/tmp/ws' };
        const lunaPrimary = provider.buildSdkConfig('gpt-5.6-luna', lunaSession);
        provider.buildSdkConfig('gpt-5.6-sol', lunaSession);
        await originalFetch(`${lunaPrimary.envVars.ANTHROPIC_BASE_URL}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-5.6-luna',
            max_tokens: 128,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });

        const frontierSession = {
          sessionId: 'frontier-with-luna-fallback',
          workspacePath: '/tmp/ws',
        };
        const frontierPrimary = provider.buildSdkConfig('gpt-5.6-sol', frontierSession);
        provider.buildSdkConfig('gpt-5.6-luna', frontierSession);
        await originalFetch(`${frontierPrimary.envVars.ANTHROPIC_BASE_URL}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-5.6-sol',
            max_tokens: 128,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });

        expect(capturedModels).toEqual(['gpt-5.6-luna', 'gpt-5.6-sol']);
      } finally {
        fetchSpy?.mockRestore();
      }
    });

    it('resolves codex-latest alias to real Codex ID', () => {
      const cfg = provider.buildSdkConfig('codex-latest', { workspacePath: '/tmp/ws-latest' });
      // 'codex-latest' is an alias for 'gpt-5.6-sol', now uses real Codex ID
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.6-sol');
    });

    it('resolves gpt-5.4 alias to real Codex ID', () => {
      const cfg = provider.buildSdkConfig('codex-5.4', { workspacePath: '/tmp/ws-54' });
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.4');
    });

    it('throws for unknown model IDs instead of silently falling back', () => {
      expect(() =>
        provider.buildSdkConfig('unknown-model', { workspacePath: '/tmp/ws-unk' })
      ).toThrow('Unknown Codex model: unknown-model');
    });

    it('uses real Codex model IDs in ANTHROPIC_DEFAULT_*_MODEL env vars', () => {
      // Following GLM/Kimi pattern: use real Codex IDs, context window from metadata
      const cfg = provider.buildSdkConfig('gpt-5.3-codex', {
        workspacePath: '/tmp/ws-no-leak',
      });
      expect(cfg.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toMatch(/^gpt-/);
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toMatch(/^gpt-/);
      expect(cfg.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toMatch(/^gpt-/);
    });

    it('advertises real Codex context windows in bridge models list', async () => {
      const cfg = provider.buildSdkConfig('gpt-5.3-codex', {
        workspacePath: '/tmp/ws-models',
      });
      const baseUrl = cfg.envVars.ANTHROPIC_BASE_URL as string;
      const resp = await fetch(`${baseUrl}/v1/models`);
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as {
        data: Array<{ id: string; context_window: number }>;
      };
      const byId = new Map(body.data.map((m) => [m.id, m.context_window]));
      // Real Codex models advertise their actual context windows.
      expect(byId.get('gpt-5.6-sol')).toBe(1_050_000);
      expect(byId.get('gpt-5.6-terra')).toBe(1_050_000);
      expect(byId.get('gpt-5.6-luna')).toBe(1_050_000);
      expect(byId.get('gpt-5.5')).toBe(272_000);
      expect(byId.get('gpt-5.4-mini')).toBe(128_000);
      // No Anthropic alias models should be present.
      expect(byId.has('claude-opus-4-7')).toBe(false);
      expect(byId.has('claude-sonnet-4-20250514')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // ownsModel()
  // -------------------------------------------------------------------------

  describe('ownsModel()', () => {
    beforeEach(() => {
      provider = makeProvider({}, undefined, undefined);
    });

    it('owns models explicitly listed in the catalogue', () => {
      expect(provider.ownsModel('gpt-5.6-sol')).toBe(true);
      expect(provider.ownsModel('gpt-5.6-terra')).toBe(true);
      expect(provider.ownsModel('gpt-5.6-luna')).toBe(true);
      expect(provider.ownsModel('gpt-5.3-codex')).toBe(true);
      expect(provider.ownsModel('gpt-5.4')).toBe(true);
      expect(provider.ownsModel('gpt-5.5')).toBe(true);
      expect(provider.ownsModel('gpt-5.4-mini')).toBe(true);
      // Aliases also owned
      expect(provider.ownsModel('codex')).toBe(true);
      expect(provider.ownsModel('codex-5.4')).toBe(true);
      expect(provider.ownsModel('codex-5.5')).toBe(true);
      expect(provider.ownsModel('codex-5.6')).toBe(true);
      expect(provider.ownsModel('codex-5.6-terra')).toBe(true);
      expect(provider.ownsModel('codex-5.6-luna')).toBe(true);
      expect(provider.ownsModel('codex-mini')).toBe(true);
      expect(provider.ownsModel('codex-latest')).toBe(true);
    });

    it('does not own models not in the catalogue', () => {
      // Old models removed from catalogue
      expect(provider.ownsModel('codex-1')).toBe(false);
      expect(provider.ownsModel('o4-mini')).toBe(false);
      expect(provider.ownsModel('o1-preview')).toBe(false);
      expect(provider.ownsModel('o3-mini')).toBe(false);
      expect(provider.ownsModel('gpt-5-mini')).toBe(false);
      expect(provider.ownsModel('gpt-5.1-codex-mini')).toBe(false);
      expect(provider.ownsModel('gpt-5.1-mini')).toBe(false);
      expect(provider.ownsModel('codex-5.1-mini')).toBe(false);
      // GPT-4 models the bridge cannot serve
      expect(provider.ownsModel('gpt-4o')).toBe(false);
      expect(provider.ownsModel('gpt-4')).toBe(false);
      expect(provider.ownsModel('gpt-3.5-turbo')).toBe(false);
    });

    it('translates all model IDs to "default" following GLM/Kimi pattern', () => {
      // Following GLM/Kimi pattern: return 'default' and let SDK use ANTHROPIC_DEFAULT_*_MODEL
      // env vars to route to real Codex model IDs. Context window comes from /v1/models metadata.
      expect(provider.translateModelIdForSdk('codex-latest')).toBe('default');
      expect(provider.translateModelIdForSdk('codex-mini')).toBe('default');
      expect(provider.translateModelIdForSdk('codex-5.6-terra')).toBe('default');
      expect(provider.translateModelIdForSdk('gpt-5.5')).toBe('default');
      expect(provider.translateModelIdForSdk('unknown-model')).toBe('default');
    });

    it('does not own claude- models', () => {
      expect(provider.ownsModel('claude-3-opus')).toBe(false);
    });

    it('does not own arbitrary unrecognised model IDs', () => {
      expect(provider.ownsModel('unknown-model-xyz')).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // getModels() — availability check uses isAvailable() not getAuthStatus()
  // -------------------------------------------------------------------------

  describe('getModels()', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-models-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns models when OPENAI_API_KEY env var is set (env vars still power API calls)', async () => {
      // getModels() uses isAvailable() which includes env-var credentials.
      // This ensures models appear in the picker even when the user has not done HyperNeo OAuth.
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir);
      const models = await provider.getModels();
      expect(models.length).toBeGreaterThan(0);
    });

    it('reports correct context windows for Codex catalogue models', async () => {
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir);
      const models = await provider.getModels();
      const contextWindows = new Map(models.map((model) => [model.id, model.contextWindow]));

      expect(contextWindows.get('gpt-5.6-sol')).toBe(1050000);
      expect(contextWindows.get('gpt-5.6-terra')).toBe(1050000);
      expect(contextWindows.get('gpt-5.6-luna')).toBe(1050000);
      expect(contextWindows.get('gpt-5.3-codex')).toBe(272000);
      expect(contextWindows.get('gpt-5.4')).toBe(272000);
      expect(contextWindows.get('gpt-5.5')).toBe(272000);
      expect(contextWindows.get('gpt-5.4-mini')).toBe(128000);
    });

    it('advertises real Codex model IDs in sdkModelIds', async () => {
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir);
      const models = await provider.getModels();
      const sdkIds = new Map(models.map((model) => [model.id, model.sdkModelIds]));

      expect(sdkIds.get('gpt-5.6-sol')).toContain('gpt-5.6-sol');
      expect(sdkIds.get('gpt-5.6-terra')).toContain('gpt-5.6-terra');
      expect(sdkIds.get('gpt-5.6-luna')).toContain('gpt-5.6-luna');
      expect(sdkIds.get('gpt-5.5')).toContain('gpt-5.5');
      expect(sdkIds.get('gpt-5.3-codex')).toContain('gpt-5.3-codex');
      expect(sdkIds.get('gpt-5.4')).toContain('gpt-5.4');
      expect(sdkIds.get('gpt-5.4-mini')).toContain('gpt-5.4-mini');
    });

    it('sets thinkingModes to granular when Responses adapter is active', async () => {
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir);
      const models = await provider.getModels();
      expect(models.length).toBeGreaterThan(0);
      for (const model of models) {
        expect(model.thinkingModes).toBe('granular');
      }
    });

    it('returns models when HyperNeo OAuth credentials are in auth.json', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'oauth-access-token',
        refresh: 'oauth-refresh-token',
      });
      provider = makeProvider({}, hyperneoDir, tmpDir);
      const models = await provider.getModels();
      expect(models.length).toBeGreaterThan(0);
    });

    it('returns empty array when no credentials and codex not found', async () => {
      provider = makeProvider({}, tmpDir, tmpDir);
      const models = await provider.getModels();
      expect(models).toEqual([]);
    });

    it('probes OpenAI upstream with the resolved API key', async () => {
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
      expect(url).toBe('https://api.openai.com/v1/responses');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer sk-env-key');
      // API-key mode accepts max_output_tokens — keep the field so the
      // probe costs ~1 token instead of a full completion.
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body['max_output_tokens']).toBe(1);
    });

    it('probes the ChatGPT codex backend for OAuth tokens', async () => {
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const jwt = makeJwt({
        https: { 'api.openai.com/auth': { user_id: 'u1', organization_id: 'org-1' } },
        exp: Math.floor(Date.now() / 1000) + 60 * 60,
      });
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: jwt,
        refresh: 'r',
        accountId: 'acct-1',
      });
      provider = makeProvider({}, hyperneoDir, tmpDir, fetchImpl);

      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = (fetchImpl.mock.calls[0] as [string, RequestInit]) ?? [];
      expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
      const headers = init?.headers as Record<string, string>;
      expect(headers['authorization']).toBe(`Bearer ${jwt}`);
      // Capital `ID` — matches buildOpenAIHeaders at openai-responses-bridge/server.ts:648.
      // The gateway is case-sensitive on this header.
      expect(headers['ChatGPT-Account-ID']).toBe('acct-1');
      // No speculative OpenAI-Beta header — the bridge's own traffic does
      // not send it, so the probe must not either.
      expect(headers['OpenAI-Beta']).toBeUndefined();
      // ChatGPT Codex backend requires streaming probe shape matching normal bridge traffic.
      const body = JSON.parse(init?.body as string) as Record<string, unknown>;
      expect(body['max_output_tokens']).toBeUndefined();
      expect(body['instructions']).toBe('You are a concise assistant.');
      expect(body['store']).toBe(false);
      expect(body['stream']).toBe(true);
    });

    it('throws when OpenAI rejects the API key (401)', async () => {
      const fetchImpl = mock(
        async () => new Response('unauthorized', { status: 401 })
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'bad-key' }, tmpDir, tmpDir, fetchImpl);

      expect(provider.getModels()).rejects.toThrow('Codex credentials rejected (HTTP 401)');
    });

    it('throws when probe fails at the network layer', async () => {
      const fetchImpl = mock(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

      expect(provider.getModels()).rejects.toThrow('Codex probe failed: ECONNREFUSED');
    });

    it('caches successful probe so repeated calls do not re-probe', async () => {
      const fetchImpl = mock(
        async () => new Response('{}', { status: 200 })
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

      await provider.getModels();
      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // importFromCodexAuth() — one-time migration from ~/.codex/auth.json
  // -------------------------------------------------------------------------

  describe('importFromCodexAuth() — one-time migration', () => {
    let tmpDir: string;
    let fetchSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-import-test-'));
      // Spy on global fetch to intercept token refresh calls.
      // Default: simulate a network error so tests that don't set up a mock fail clearly.
      fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(
        new Error('fetch not mocked for this test')
      );
    });

    afterEach(() => {
      fetchSpy.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('Test 1: imports API key directly from ~/.codex/auth.json into ~/.hyperneo/auth.json', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');
      writeCodexAuth(codexDir, { OPENAI_API_KEY: 'sk-codex-api-key' });

      const p = makeProvider({}, hyperneoDir, codexDir);
      const key = await p.getApiKey();

      expect(key).toBe('sk-codex-api-key');

      // Credentials should now be written to ~/.hyperneo/auth.json
      const hyperneoAuth = JSON.parse(
        readFileSync(path.join(hyperneoDir, 'auth.json'), 'utf-8')
      ) as {
        openai: { type: string; access: string };
      };
      expect(hyperneoAuth.openai.type).toBe('api_key');
      expect(hyperneoAuth.openai.access).toBe('sk-codex-api-key');

      // fetch should NOT have been called (API key import needs no refresh)
      expect(fetchSpy).not.toHaveBeenCalled();
      p.stopAllBridgeServers();
    });

    it('Test 2: refreshes expired token + imports into ~/.hyperneo/auth.json', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');
      writeCodexAuth(codexDir, {
        tokens: { access_token: 'old-expired-token', refresh_token: 'valid-refresh-token' },
      });

      // Mock a successful token refresh response
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'new-fresh-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const p = makeProvider({}, hyperneoDir, codexDir);
      const key = await p.getApiKey();

      expect(key).toBe('new-fresh-token');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Verify the refreshed token was written to ~/.hyperneo/auth.json
      const hyperneoAuth = JSON.parse(
        readFileSync(path.join(hyperneoDir, 'auth.json'), 'utf-8')
      ) as {
        openai: { type: string; access: string; refresh: string };
      };
      expect(hyperneoAuth.openai.type).toBe('oauth');
      expect(hyperneoAuth.openai.access).toBe('new-fresh-token');
      expect(hyperneoAuth.openai.refresh).toBe('new-refresh-token');
      p.stopAllBridgeServers();
    });

    it('Test 3: falls back to importing existing token when refresh fails', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');
      writeCodexAuth(codexDir, {
        tokens: { access_token: 'expired-token', refresh_token: 'invalid-refresh' },
      });

      // Mock a failed token refresh response (401)
      fetchSpy.mockResolvedValueOnce(
        new Response('{"error":"invalid_grant"}', {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const p = makeProvider({}, hyperneoDir, codexDir);
      const key = await p.getApiKey();

      // Refresh failure should still import existing codex token into ~/.hyperneo/auth.json
      expect(key).toBe('expired-token');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const hyperneoAuth = JSON.parse(
        readFileSync(path.join(hyperneoDir, 'auth.json'), 'utf-8')
      ) as {
        openai: { type: string; access: string; refresh?: string };
      };
      expect(hyperneoAuth.openai.type).toBe('oauth');
      expect(hyperneoAuth.openai.access).toBe('expired-token');
      expect(hyperneoAuth.openai.refresh).toBe('invalid-refresh');
      p.stopAllBridgeServers();
    });

    it('Test 4: second call uses in-memory cachedApiKey (no further file I/O)', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');

      // Pre-populate ~/.hyperneo/auth.json (simulates already-imported state)
      writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'already-imported-token' });

      const p = makeProvider({}, hyperneoDir, codexDir);

      // First call — reads from ~/.hyperneo/auth.json and populates cachedApiKey
      const key1 = await p.getApiKey();
      expect(key1).toBe('already-imported-token');

      // Delete the hyperneo auth file; no codex file exists either.
      // Any further disk read would find nothing and return undefined.
      await fs.unlink(path.join(hyperneoDir, 'auth.json'));

      // Second call — must return the key from in-memory cache, not from disk.
      const key2 = await p.getApiKey();
      expect(key2).toBe('already-imported-token');

      // fetch should NOT have been called at any point (no migration attempt)
      expect(fetchSpy).not.toHaveBeenCalled();
      p.stopAllBridgeServers();
    });
  });

  // -------------------------------------------------------------------------
  // refreshToken() — stale credential clearing
  // -------------------------------------------------------------------------

  describe('refreshToken() stale credential clearing', () => {
    let tmpDir: string;
    let fetchSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-refresh-test-'));
      fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(
        new Error('fetch not mocked for this test')
      );
    });

    afterEach(() => {
      fetchSpy.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('clears stale credentials when token refresh fails with invalid_grant', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'stale-access-token',
        refresh: 'invalid-refresh-token',
        expires: Date.now() - 60_000,
      });

      fetchSpy.mockResolvedValueOnce(
        new Response('{"error":"invalid_grant"}', {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const p = makeProvider({}, hyperneoDir, path.join(tmpDir, 'codex'));
      const refreshed = await p.refreshToken();

      expect(refreshed).toBe(false);
      // Credentials should be cleared so the user is prompted to re-authenticate
      const authStatus = await p.getAuthStatus();
      expect(authStatus.isAuthenticated).toBe(false);
      expect(await p.getApiKey()).toBeUndefined();
      p.stopAllBridgeServers();
    });

    it('clears stale credentials when token refresh returns 400', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'stale-access-token',
        refresh: 'revoked-refresh-token',
      });

      fetchSpy.mockResolvedValueOnce(
        new Response('{"error":"invalid_request"}', {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const p = makeProvider({}, hyperneoDir, path.join(tmpDir, 'codex'));
      const refreshed = await p.refreshToken();

      expect(refreshed).toBe(false);
      const authStatus = await p.getAuthStatus();
      expect(authStatus.isAuthenticated).toBe(false);
      p.stopAllBridgeServers();
    });

    it('preserves credentials on transient refresh failures (network error)', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'valid-access-token',
        refresh: 'valid-refresh-token',
        expires: Date.now() + 3600_000,
      });

      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const p = makeProvider({}, hyperneoDir, path.join(tmpDir, 'codex'));
      const refreshed = await p.refreshToken();

      expect(refreshed).toBe(false);
      // Credentials should NOT be cleared on transient failures
      const authStatus = await p.getAuthStatus();
      expect(authStatus.isAuthenticated).toBe(true);
      expect(await p.getApiKey()).toBe('valid-access-token');
      p.stopAllBridgeServers();
    });

    it('preserves credentials on transient refresh failures (5xx)', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'valid-access-token',
        refresh: 'valid-refresh-token',
        expires: Date.now() + 3600_000,
      });

      fetchSpy.mockResolvedValueOnce(
        new Response('{"error":"internal_error"}', {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const p = makeProvider({}, hyperneoDir, path.join(tmpDir, 'codex'));
      const refreshed = await p.refreshToken();

      expect(refreshed).toBe(false);
      const authStatus = await p.getAuthStatus();
      expect(authStatus.isAuthenticated).toBe(true);
      p.stopAllBridgeServers();
    });

    it('preserves credentials on rate-limit refresh failures (429)', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'valid-access-token',
        refresh: 'valid-refresh-token',
        expires: Date.now() + 3600_000,
      });

      fetchSpy.mockResolvedValueOnce(
        new Response('{"error":"rate_limit"}', {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const p = makeProvider({}, hyperneoDir, path.join(tmpDir, 'codex'));
      const refreshed = await p.refreshToken();

      expect(refreshed).toBe(false);
      const authStatus = await p.getAuthStatus();
      expect(authStatus.isAuthenticated).toBe(true);
      p.stopAllBridgeServers();
    });
  });

  describe('setSessionThinkingConfig', () => {
    function mockUpstreamFetch(capturedRef: { body?: Record<string, unknown> }) {
      const originalFetch = globalThis.fetch.bind(globalThis);
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (
          typeof url === 'string' &&
          (url.includes('api.openai.com') || url.includes('chatgpt.com'))
        ) {
          capturedRef.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(
            `event: response.completed\ndata: ${JSON.stringify({
              type: 'response.completed',
              response: { usage: { input_tokens: 5, output_tokens: 1 }, output: [] },
            })}\n\n`,
            { headers: { 'Content-Type': 'text/event-stream' } }
          );
        }
        return originalFetch(url, init);
      });
      return fetchSpy;
    }

    it('propagates thinking config to the active bridge server via side-channel', async () => {
      const captured = { body: undefined as Record<string, unknown> | undefined };
      const fetchSpy = mockUpstreamFetch(captured);
      const p = makeProvider({ OPENAI_API_KEY: 'sk-test' });
      const cfg = p.buildSdkConfig('gpt-5.3-codex', { sessionId: 'sess-123' });

      p.setSessionThinkingConfig('sess-123', 'think32k');

      const resp = await fetch(`${cfg.envVars.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({
          model: 'gpt-5.3-codex',
          max_tokens: 128,
          messages: [{ role: 'user', content: 'Say hi.' }],
        }),
      });

      expect(resp.status).toBe(200);
      expect(captured.body?.reasoning).toEqual({ effort: 'xhigh', summary: 'auto' });

      fetchSpy.mockRestore();
      p.stopAllBridgeServers();
    });

    it('finds env-var-keyed bridge (cachedBridgeAuth is unset)', async () => {
      const captured = { body: undefined as Record<string, unknown> | undefined };
      const fetchSpy = mockUpstreamFetch(captured);
      const p = makeProvider({ OPENAI_API_KEY: 'sk-env-key' });
      const cfg = p.buildSdkConfig('gpt-5.3-codex', { sessionId: 'sess-env' });

      p.setSessionThinkingConfig('sess-env', 'think16k');

      const resp = await fetch(`${cfg.envVars.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({
          model: 'gpt-5.3-codex',
          max_tokens: 128,
          messages: [{ role: 'user', content: 'Say hi.' }],
        }),
      });

      expect(resp.status).toBe(200);
      expect(captured.body?.reasoning).toEqual({ effort: 'medium', summary: 'auto' });

      fetchSpy.mockRestore();
      p.stopAllBridgeServers();
    });

    it('is a no-op when no bridge server is active', () => {
      const p = makeProvider({ OPENAI_API_KEY: 'sk-test' });
      expect(() => p.setSessionThinkingConfig('sess-456', 'think16k')).not.toThrow();
    });

    it('clears config when thinking level is off or undefined', async () => {
      const captured = { body: undefined as Record<string, unknown> | undefined };
      const fetchSpy = mockUpstreamFetch(captured);
      const p = makeProvider({ OPENAI_API_KEY: 'sk-test' });
      const cfg = p.buildSdkConfig('gpt-5.3-codex', { sessionId: 'sess-789' });

      p.setSessionThinkingConfig('sess-789', 'think32k');
      p.setSessionThinkingConfig('sess-789', 'off');
      p.setSessionThinkingConfig('sess-789', undefined);

      const resp = await fetch(`${cfg.envVars.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({
          model: 'gpt-5.3-codex',
          max_tokens: 128,
          messages: [{ role: 'user', content: 'Say hi.' }],
        }),
      });

      expect(resp.status).toBe(200);
      expect(captured.body?.reasoning).toBeUndefined();

      fetchSpy.mockRestore();
      p.stopAllBridgeServers();
    });
  });
});
