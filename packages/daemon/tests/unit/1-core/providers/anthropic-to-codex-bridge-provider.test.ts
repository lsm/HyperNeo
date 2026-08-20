import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { ProviderCredentials } from '@hyperneo/shared/provider';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { vi } from 'vitest';

const CODEX_COMPAT_CLIENT_VERSION = '0.148.0';
import { AnthropicToCodexBridgeProvider } from '../../../../src/lib/providers/anthropic-to-codex-bridge-provider';

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

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

function writeHyperNeoAuth(dir: string, credentials: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ openai: credentials }), {
    mode: 0o600,
  });
}

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

describe('AnthropicToCodexBridgeProvider', () => {
  let provider: AnthropicToCodexBridgeProvider;
  const fsSpies = [
    fsPromiseMocks.readFile,
    fsPromiseMocks.writeFile,
    fsPromiseMocks.rename,
    fsPromiseMocks.unlink,
  ];

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
          mode !== undefined ? { mode } : undefined
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
      try {
        unlinkSync(filePath as Parameters<typeof unlinkSync>[0]);
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err);
      }
    });
  });

  afterEach(() => {
    provider?.stopAllBridgeServers();
    fsSpies.forEach((spy) => spy.mockReset());
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
        expires: Date.now() - 60_000,
      });
      provider = makeProvider({}, hyperneoDir, codexDir);
      const result = await provider.getAuthStatus();
      expect(result.isAuthenticated).toBe(true);
      expect(result.needsRefresh).toBe(true);
    });
  });

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
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');
      writeCodexAuth(codexDir, { OPENAI_API_KEY: 'codex-imported-key' });

      provider = makeProvider({}, hyperneoDir, codexDir);
      const credentials = await provider.getCredentials();
      expect(credentials).toEqual({ type: 'api_key', apiKey: 'codex-imported-key' });
    });

    it('Priority 4a: returns OPENAI_API_KEY from ~/.codex/auth.json when no higher source', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');
      writeCodexAuth(codexDir, { OPENAI_API_KEY: 'codex-file-api-key' });

      provider = makeProvider({}, hyperneoDir, codexDir);
      expect(await provider.getApiKey()).toBe('codex-file-api-key');
    });

    it('Priority 4b: returns access_token from ~/.codex/auth.json when OPENAI_API_KEY is null', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');
      writeCodexAuth(codexDir, {
        OPENAI_API_KEY: null,
        tokens: { access_token: 'codex-oauth-token' },
      });

      provider = makeProvider({}, hyperneoDir, codexDir);
      expect(await provider.getApiKey()).toBe('codex-oauth-token');
    });

    it('returns undefined when all sources are absent', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');

      provider = makeProvider({}, hyperneoDir, codexDir);
      expect(await provider.getApiKey()).toBeUndefined();
    });

    it('empty-string env var falls through to file-based auth', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');
      writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'hyperneo-fallback-token' });

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

  describe.skipIf(!isBun)('buildSdkConfig() bridge server routing', () => {
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

    it('caps GPT-5.6 at 272K on the ChatGPT Codex (OAuth) backend', async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-codex-oauth-window-'));
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'oauth-access-token',
        refresh: 'oauth-refresh-token',
        expires: Date.now() + 3600_000,
        accountId: 'user_abc123',
      });
      const p = makeProvider({}, hyperneoDir, path.join(tmpDir, 'codex'));
      try {
        await p.getApiKey();
        const cfg = p.buildSdkConfig('gpt-5.6-sol', { workspacePath: '/tmp/ws-oauth-window' });
        expect(cfg.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('272000');
        const resp = await fetch(`${cfg.envVars.ANTHROPIC_BASE_URL}/v1/models`);
        const body = (await resp.json()) as { data: Array<{ id: string; context_window: number }> };
        const byId = new Map(body.data.map((m) => [m.id, m.context_window]));
        expect(byId.get('gpt-5.6-sol')).toBe(272000);
        expect(byId.get('gpt-5.5')).toBe(272000);
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
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-build-cfg-test-'));
      try {
        const hyperneoDir = path.join(tmpDir, 'hyperneo');
        writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'file-based-token' });
        const p = makeProvider({}, hyperneoDir, path.join(tmpDir, 'codex'));
        await p.getApiKey();
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
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-build-cfg-empty-'));
      try {
        const hyperneoDir = path.join(tmpDir, 'hyperneo');
        writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'file-token-not-empty' });
        const p = makeProvider({ OPENAI_API_KEY: '' }, hyperneoDir, path.join(tmpDir, 'codex'));
        await p.getApiKey();
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
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.3-codex');
    });

    it('keeps the SDK sonnet tier on Luna for mini Codex sessions', () => {
      const cfg = provider.buildSdkConfig('codex-mini', { workspacePath: '/tmp/ws-mini' });
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.6-luna');
      expect(cfg.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gpt-5.6-luna');
      expect(cfg.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1050000');
    });

    it('clamps bundled mini model reasoning to high', async () => {
      const captured = { body: undefined as Record<string, unknown> | undefined };
      const originalFetch = globalThis.fetch;
      const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        if (String(input).startsWith('http://127.0.0.1:')) {
          return originalFetch(input, init);
        }
        captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":0},"output":[]}}\n\n',
          { headers: { 'Content-Type': 'text/event-stream' } }
        );
      });
      try {
        const cfg = provider.buildSdkConfig('gpt-5.4-mini', { sessionId: 'bundled-mini' });
        provider.setSessionThinkingConfig('bundled-mini', 'think32k');
        const response = await originalFetch(`${cfg.envVars.ANTHROPIC_BASE_URL}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-5.4-mini',
            max_tokens: 128,
            messages: [{ role: 'user', content: 'Think deeply.' }],
          }),
        });

        expect(response.status).toBe(200);
        expect(captured.body?.reasoning).toEqual({ effort: 'high', summary: 'auto' });
      } finally {
        fetchSpy.mockRestore();
      }
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
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.6-sol');
    });

    it('resolves gpt-5.4 alias to real Codex ID', () => {
      const cfg = provider.buildSdkConfig('codex-5.4', { workspacePath: '/tmp/ws-54' });
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.4');
    });

    it('falls back to the default listed model for stale model IDs', () => {
      const cfg = provider.buildSdkConfig('unknown-model', { workspacePath: '/tmp/ws-unk' });
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.6-terra');
    });

    it('uses real Codex model IDs in ANTHROPIC_DEFAULT_*_MODEL env vars', () => {
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
      expect(byId.get('gpt-5.6-sol')).toBe(1_050_000);
      expect(byId.get('gpt-5.6-terra')).toBe(1_050_000);
      expect(byId.get('gpt-5.6-luna')).toBe(1_050_000);
      expect(byId.get('gpt-5.5')).toBe(272_000);
      expect(byId.get('gpt-5.4-mini')).toBe(128_000);
      expect(byId.has('claude-opus-4-7')).toBe(false);
      expect(byId.has('claude-sonnet-4-20250514')).toBe(false);
    });

    it('updates the existing bridge catalog without changing its port', async () => {
      const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-bridge-catalog-update-'));
      try {
        const fetchImpl = mock(
          async () =>
            new Response(JSON.stringify({ data: [{ id: 'gpt-dynamic' }] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
        ) as unknown as typeof fetch;
        const p = makeProvider({ OPENAI_API_KEY: 'sk-dynamic' }, tmpDir, tmpDir, fetchImpl);
        const initial = p.buildSdkConfig('gpt-5.3-codex', { sessionId: 'active-session' });
        const initialBaseUrl = initial.envVars.ANTHROPIC_BASE_URL as string;

        await p.getModels();
        const updated = p.buildSdkConfig('gpt-dynamic', { sessionId: 'next-session' });

        expect(new URL(updated.envVars.ANTHROPIC_BASE_URL as string).port).toBe(
          new URL(initialBaseUrl).port
        );
        const oldUrlResponse = await fetch(`${initialBaseUrl}/v1/models`);
        expect(oldUrlResponse.status).toBe(200);
        const body = (await oldUrlResponse.json()) as { data: Array<{ id: string }> };
        expect(body.data.map((model) => model.id)).toEqual(['gpt-dynamic']);
        const servers = (p as unknown as { bridgeServers: Map<string, unknown> }).bridgeServers;
        expect(servers.size).toBe(1);
        p.stopAllBridgeServers();
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

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
      expect(provider.ownsModel('codex-1')).toBe(false);
      expect(provider.ownsModel('o4-mini')).toBe(false);
      expect(provider.ownsModel('o1-preview')).toBe(false);
      expect(provider.ownsModel('o3-mini')).toBe(false);
      expect(provider.ownsModel('gpt-5-mini')).toBe(false);
      expect(provider.ownsModel('gpt-5.1-codex-mini')).toBe(false);
      expect(provider.ownsModel('gpt-5.1-mini')).toBe(false);
      expect(provider.ownsModel('codex-5.1-mini')).toBe(false);
      expect(provider.ownsModel('gpt-4o')).toBe(false);
      expect(provider.ownsModel('gpt-4')).toBe(false);
      expect(provider.ownsModel('gpt-3.5-turbo')).toBe(false);
    });

    it('translates all model IDs to "default" following GLM/Kimi pattern', () => {
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

  describe('getModels()', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-models-test-'));
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('returns models when OPENAI_API_KEY env var is set (env vars still power API calls)', async () => {
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

    it('fetches OpenAI models with the resolved API key', async () => {
      const fetchImpl = mock(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'gpt-dynamic-api' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

      const models = await provider.getModels();

      expect(models.map((model) => model.id)).toEqual(['gpt-dynamic-api']);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = (fetchImpl.mock.calls[0] as [URL, RequestInit]) ?? [];
      expect(String(url)).toBe(
        `https://api.openai.com/v1/models?client_version=${CODEX_COMPAT_CLIENT_VERSION}`
      );
      expect(init?.method).toBe('GET');
      const headers = init?.headers as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer sk-env-key');
      expect(init?.body).toBeUndefined();
    });

    it.skipIf(!isBun)(
      'preserves known per-model reasoning limits from the general OpenAI catalog',
      async () => {
        const fetchImpl = mock(
          async () =>
            new Response(JSON.stringify({ data: [{ id: 'gpt-5.4-mini' }] }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            })
        ) as unknown as typeof fetch;
        provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

        await provider.getModels();

        const captured = { body: undefined as Record<string, unknown> | undefined };
        const originalFetch = globalThis.fetch;
        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
          if (String(input).startsWith('http://127.0.0.1:')) return originalFetch(input, init);
          captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(
            'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":0},"output":[]}}\n\n',
            { headers: { 'Content-Type': 'text/event-stream' } }
          );
        });
        try {
          const config = provider.buildSdkConfig('gpt-5.4-mini', { sessionId: 'api-mini' });
          provider.setSessionThinkingConfig('api-mini', 'think32k');
          await originalFetch(`${config.envVars.ANTHROPIC_BASE_URL}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'gpt-5.4-mini',
              max_tokens: 128,
              messages: [{ role: 'user', content: 'Think deeply.' }],
            }),
          });

          expect(captured.body?.reasoning).toEqual({ effort: 'high', summary: 'auto' });
        } finally {
          fetchSpy.mockRestore();
        }
      }
    );

    it('filters non-Responses models from the general OpenAI catalog', async () => {
      const fetchImpl = mock(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                { id: 'gpt-5.4' },
                { id: 'o3' },
                { id: 'text-embedding-3-small' },
                { id: 'gpt-image-1' },
                { id: 'omni-moderation-latest' },
                { id: 'whisper-1' },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

      const models = await provider.getModels();

      expect(models.map((model) => model.id)).toEqual(['gpt-5.4', 'o3']);
      expect(provider.getModelThinkingMode('gpt-5.4')).toBe('granular');
      expect(provider.getModelThinkingMode('o3')).toBe('off');
    });

    it('fetches rich models from the ChatGPT Codex backend for OAuth tokens', async () => {
      const fetchImpl = mock(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  slug: 'gpt-dynamic-oauth',
                  display_name: 'GPT Dynamic OAuth',
                  description: 'Account-specific model',
                  context_window: 300000,
                  visibility: 'list',
                  supported_in_api: false,
                  supported_reasoning_levels: [
                    { effort: 'low', description: 'Fast' },
                    { effort: 'medium', description: 'Balanced' },
                    { effort: 'high', description: 'Deep' },
                  ],
                  priority: 1,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
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

      const models = await provider.getModels();

      expect(models.map((model) => model.id)).toEqual(['gpt-dynamic-oauth']);
      expect(provider.getModelForTier('opus')).toBe('gpt-dynamic-oauth');
      if (isBun) {
        const config = provider.buildSdkConfig('gpt-dynamic-oauth', {
          sessionId: 'dynamic-only',
        });
        expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gpt-dynamic-oauth');
        expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gpt-dynamic-oauth');
      }
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = (fetchImpl.mock.calls[0] as [URL, RequestInit]) ?? [];
      expect(String(url)).toBe(
        `https://chatgpt.com/backend-api/codex/models?client_version=${CODEX_COMPAT_CLIENT_VERSION}`
      );
      const headers = init?.headers as Record<string, string>;
      expect(headers['authorization']).toBe(`Bearer ${jwt}`);
      expect(headers['ChatGPT-Account-ID']).toBe('acct-1');
      expect(headers['OpenAI-Beta']).toBeUndefined();
      expect(init?.body).toBeUndefined();
    });

    it('throws when OpenAI rejects the API key (401)', async () => {
      const fetchImpl = mock(
        async () => new Response('unauthorized', { status: 401 })
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'bad-key' }, tmpDir, tmpDir, fetchImpl);

      expect(provider.getModels()).rejects.toThrow('Codex credentials rejected (HTTP 401)');
    });

    it('keeps bundled models when model discovery is forbidden', async () => {
      const fetchImpl = mock(
        async () => new Response('forbidden', { status: 403 })
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'restricted-key' }, tmpDir, tmpDir, fetchImpl);

      const models = await provider.getModels();

      expect(models.map((model) => model.id)).toContain('gpt-5.6-sol');
    });

    it('falls back to bundled models when discovery fails at the network layer', async () => {
      const fetchImpl = mock(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

      const models = await provider.getModels();

      expect(models.map((model) => model.id)).toContain('gpt-5.6-sol');
      await expect(provider.healthCheck()).rejects.toThrow('model discovery failed: ECONNREFUSED');
    });

    it.each([
      429, 503,
    ])('reports HTTP %i discovery responses as unhealthy while retaining fallback models', async (status) => {
      const fetchImpl = mock(
        async () => new Response('unavailable', { status })
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

      const models = await provider.getModels();

      expect(models.map((model) => model.id)).toContain('gpt-5.6-sol');
      await expect(provider.healthCheck()).rejects.toThrow(`model discovery HTTP ${status}`);
    });

    it('rejects strict model refresh failures while ordinary callers retain fallback models', async () => {
      const fetchImpl = mock(
        async () => new Response('unavailable', { status: 503 })
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

      await expect(provider.getModels()).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'gpt-5.6-sol' })])
      );
      await expect(provider.refreshModels()).rejects.toThrow('model discovery HTTP 503');
    });

    it.each([
      ['malformed JSON', '{'],
      ['unexpected schema', JSON.stringify({ result: [] })],
      ['no usable listed models', JSON.stringify({ data: [{ id: 'text-embedding-3-large' }] })],
    ])('reports %s as unhealthy while retaining fallback models', async (_name, body) => {
      const fetchImpl = mock(
        async () =>
          new Response(body, {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

      const models = await provider.getModels();

      expect(models.map((model) => model.id)).toContain('gpt-5.6-sol');
      await expect(provider.healthCheck()).rejects.toThrow(
        'model discovery returned no usable models'
      );
    });

    it('clears discovery health failures after a successful probe', async () => {
      const fetchImpl = mock()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: [{ id: 'gpt-healthy' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

      await provider.getModels();

      await expect(provider.healthCheck()).resolves.toBeUndefined();
    });

    it('caches a successful model list so repeated calls do not refetch', async () => {
      const fetchImpl = mock(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'gpt-dynamic-api' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

      await provider.getModels();
      await provider.getModels();

      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('coalesces concurrent model calls when discovery fails', async () => {
      let rejectFetch: ((error: Error) => void) | undefined;
      const failedResponse = new Promise<Response>((_resolve, reject) => {
        rejectFetch = reject;
      });
      const fetchImpl = mock(async () => failedResponse) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

      const first = provider.getModels();
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      const second = provider.getModels();
      rejectFetch?.(new Error('ECONNRESET'));

      const [firstModels, secondModels] = await Promise.all([first, second]);

      expect(firstModels.map((model) => model.id)).toContain('gpt-5.6-sol');
      expect(secondModels.map((model) => model.id)).toContain('gpt-5.6-sol');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('keeps valid rich models when another entry has unsupported schema', async () => {
      const fetchImpl = mock(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  slug: 'gpt-valid',
                  display_name: 'GPT Valid',
                  visibility: 'list',
                  supported_in_api: true,
                  priority: 1,
                },
                {
                  slug: 'gpt-invalid',
                  display_name: 'GPT Invalid',
                  visibility: 'preview',
                  supported_in_api: true,
                  priority: 2,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      ) as unknown as typeof fetch;
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'oauth-access-token',
        accountId: 'acct-valid',
      });
      provider = makeProvider({}, hyperneoDir, tmpDir, fetchImpl);

      const models = await provider.getModels();

      expect(models.map((model) => model.id)).toEqual(['gpt-valid']);
    });

    it('rejects oversized rich metadata without poisoning the persisted cache', async () => {
      const fetchImpl = mock(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  slug: 'gpt-valid',
                  display_name: 'GPT Valid',
                  visibility: 'list',
                  supported_in_api: true,
                  priority: 1,
                },
                {
                  slug: 'gpt-oversized',
                  display_name: 'x'.repeat(501),
                  description: 'y'.repeat(4001),
                  visibility: 'list',
                  supported_in_api: true,
                  priority: 2,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      ) as unknown as typeof fetch;
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'oauth-access-token',
        accountId: 'acct-bounded',
      });
      provider = makeProvider({}, hyperneoDir, tmpDir, fetchImpl);

      const models = await provider.getModels();

      expect(models.map((model) => model.id)).toEqual(['gpt-valid']);
      const cache = readFileSync(path.join(hyperneoDir, 'openai-models-cache.json'), 'utf-8');
      expect(cache).not.toContain('gpt-oversized');
    });

    it('sorts rich models, filters API-ineligible and hidden entries, and keeps hidden routing', async () => {
      const fetchImpl = mock(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  slug: 'gpt-later',
                  display_name: 'GPT Later',
                  max_context_window: 222000,
                  visibility: 'list',
                  supported_in_api: true,
                  priority: 20,
                },
                {
                  slug: 'gpt-5.6-sol',
                  display_name: 'GPT Hidden',
                  context_window: 111000,
                  visibility: 'hide',
                  supported_in_api: true,
                  priority: 5,
                },
                {
                  slug: 'gpt-5.6-luna',
                  display_name: 'GPT Hidden Mini',
                  context_window: 111000,
                  visibility: 'none',
                  supported_in_api: true,
                  priority: 6,
                },
                {
                  slug: 'gpt-account-only',
                  display_name: 'GPT Account Only',
                  visibility: 'list',
                  supported_in_api: false,
                  priority: 1,
                },
                {
                  slug: 'gpt-first',
                  display_name: 'GPT First',
                  description: 'First available model',
                  context_window: 333000,
                  visibility: 'list',
                  supported_in_api: true,
                  priority: 10,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

      const models = await provider.getModels();

      expect(models.map((model) => model.id)).toEqual(['gpt-first', 'gpt-later']);
      expect(models[0]).toMatchObject({
        name: 'GPT First',
        description: 'First available model',
        contextWindow: 333000,
        sdkModelIds: ['gpt-first'],
      });
      expect(models[1]?.contextWindow).toBe(222000);
      expect(provider.ownsModel('gpt-5.6-sol')).toBe(true);
      expect(provider.ownsModel('gpt-5.6-luna')).toBe(true);
      expect(provider.ownsModel('gpt-account-only')).toBe(false);
      expect(provider.getModelForTier('opus')).toBe('gpt-first');
      expect(provider.getModelForTier('haiku')).toBe('gpt-first');
      if (isBun) {
        const config = provider.buildSdkConfig('gpt-first', { sessionId: 'hidden-defaults' });
        expect(config.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gpt-first');
        expect(config.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gpt-first');
      }
    });

    it('preserves curated metadata and aliases for known remote models', async () => {
      const fetchImpl = mock(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  slug: 'gpt-5.6-sol',
                  display_name: 'Server Name',
                  description: 'Server description',
                  context_window: 1,
                  visibility: 'list',
                  supported_in_api: true,
                  priority: 1,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

      const models = await provider.getModels();

      expect(models).toHaveLength(1);
      expect(models[0]).toMatchObject({
        id: 'gpt-5.6-sol',
        name: 'GPT-5.6 Sol',
        alias: 'codex-latest',
        contextWindow: 1050000,
        sdkModelIds: ['gpt-5.6-sol'],
      });
      expect(provider.ownsModel('codex-5.6')).toBe(true);
    });

    it('ignores discovery failures from a replaced credential scope', async () => {
      let rejectOld: ((error: Error) => void) | undefined;
      const oldRequest = new Promise<Response>((_resolve, reject) => {
        rejectOld = reject;
      });
      const successfulResponse = () =>
        new Response(JSON.stringify({ data: [{ id: 'gpt-new-scope' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      const fetchImpl = mock()
        .mockImplementationOnce(async () => oldRequest)
        .mockImplementation(async () => successfulResponse()) as unknown as typeof fetch;
      provider = makeProvider({}, tmpDir, tmpDir, fetchImpl);
      provider.setCredentials({ type: 'api_key', apiKey: 'sk-old-scope' });

      const oldRefresh = provider.getModels();
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      provider.setCredentials({ type: 'api_key', apiKey: 'sk-new-scope' });
      await provider.refreshModels();
      rejectOld?.(new Error('old scope offline'));

      await expect(oldRefresh).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: 'gpt-new-scope' })])
      );
      await expect(provider.healthCheck()).resolves.toBeUndefined();
    });

    it('does not route a previous credential scope catalog after credentials change', async () => {
      const fetchImpl = mock(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'gpt-account-specific' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      ) as unknown as typeof fetch;
      provider = makeProvider({}, tmpDir, tmpDir, fetchImpl);
      provider.setCredentials({ type: 'api_key', apiKey: 'sk-first-account' });
      await provider.getModels();
      expect(provider.ownsModel('gpt-account-specific')).toBe(true);

      provider.setCredentials({ type: 'api_key', apiKey: 'sk-second-account' });

      expect(provider.ownsModel('gpt-account-specific')).toBe(false);
      expect(provider.ownsModel('gpt-5.3-codex')).toBe(true);
      if (isBun) {
        const config = provider.buildSdkConfig('gpt-account-specific', {
          sessionId: 'new-account',
        });
        expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.6-terra');
      }
    });

    it('hydrates OAuth dynamic routing synchronously after restart', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'oauth-token',
        refresh: 'oauth-refresh',
        accountId: 'acct-restart',
      });
      const fetchImpl = mock(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  slug: 'gpt-oauth-restart',
                  display_name: 'GPT OAuth Restart',
                  visibility: 'list',
                  supported_in_api: true,
                  supported_reasoning_levels: [
                    { effort: 'low', description: 'Fast' },
                    { effort: 'medium', description: 'Balanced' },
                  ],
                  priority: 1,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      ) as unknown as typeof fetch;
      provider = makeProvider({}, hyperneoDir, tmpDir, fetchImpl);
      await provider.getModels();

      const restarted = makeProvider(
        {},
        hyperneoDir,
        tmpDir,
        mock(async () => {
          throw new Error('offline');
        }) as unknown as typeof fetch
      );

      expect(restarted.ownsModel('gpt-oauth-restart')).toBe(true);
      if (isBun) {
        const captured = { body: undefined as Record<string, unknown> | undefined };
        const responseFetch = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
          if (typeof url === 'string' && url.includes('/responses')) {
            captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return new Response(
              `event: response.completed\ndata: ${JSON.stringify({
                type: 'response.completed',
                response: { usage: { input_tokens: 1, output_tokens: 0 }, output: [] },
              })}\n\n`,
              { headers: { 'Content-Type': 'text/event-stream' } }
            );
          }
          return new Response('not found', { status: 404 });
        });
        try {
          const config = restarted.buildSdkConfig('gpt-oauth-restart', {
            sessionId: 'oauth-restart',
          });
          restarted.setSessionThinkingConfig('oauth-restart', 'think32k');
          const response = await fetch(`${config.envVars.ANTHROPIC_BASE_URL}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'gpt-oauth-restart',
              max_tokens: 128,
              messages: [{ role: 'user', content: 'Think deeply.' }],
            }),
          });
          expect(response.status).toBe(200);
          expect(captured.body?.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
        } finally {
          responseFetch.mockRestore();
        }
      }
      restarted.stopAllBridgeServers();
    });

    it('persists dynamic models without credentials and hydrates routing on restart', async () => {
      const fetchImpl = mock(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'gpt-restart-safe' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ETag: 'catalog-v1' },
          })
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'secret-api-key' }, tmpDir, tmpDir, fetchImpl);

      await provider.getModels();

      const cachePath = path.join(tmpDir, 'openai-models-cache.json');
      const serialized = readFileSync(cachePath, 'utf-8');
      expect(serialized).toContain('gpt-restart-safe');
      expect(serialized).toContain('catalog-v1');
      expect(serialized).not.toContain('secret-api-key');

      const restarted = makeProvider(
        { OPENAI_API_KEY: 'secret-api-key' },
        tmpDir,
        tmpDir,
        mock(async () => {
          throw new Error('offline');
        }) as unknown as typeof fetch
      );
      expect(restarted.ownsModel('gpt-restart-safe')).toBe(true);
      expect(restarted.ownsModel('unfetched-model')).toBe(false);
      const models = await restarted.getModels();
      expect(models.map((model) => model.id)).toEqual(['gpt-restart-safe']);
      expect(restarted.ownsModel('gpt-restart-safe')).toBe(true);
      if (isBun) {
        const config = restarted.buildSdkConfig('gpt-restart-safe', {
          sessionId: 'restart-safe',
        });
        expect(config.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-restart-safe');
        expect(config.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('128000');
      }
      restarted.stopAllBridgeServers();
    });

    it('revalidates a stale cache with its ETag and retains models on 304', async () => {
      const cachePath = path.join(tmpDir, 'openai-models-cache.json');
      const initialFetch = mock(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'gpt-revalidated' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ETag: 'catalog-v1' },
          })
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, initialFetch);
      await provider.getModels();
      const staleCache = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<string, unknown>;
      staleCache.fetchedAt = '2020-01-01T00:00:00.000Z';
      writeFileSync(cachePath, JSON.stringify(staleCache), { mode: 0o600 });

      const revalidateFetch = mock(
        async () => new Response(null, { status: 304 })
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, revalidateFetch);
      const models = await provider.getModels();

      expect(models.map((model) => model.id)).toEqual(['gpt-revalidated']);
      const [, init] = (revalidateFetch as ReturnType<typeof mock>).mock.calls[0] as [
        URL,
        RequestInit,
      ];
      expect((init.headers as Record<string, string>)['if-none-match']).toBe('catalog-v1');
      const refreshedCache = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<
        string,
        unknown
      >;
      expect(refreshedCache.fetchedAt).not.toBe(staleCache.fetchedAt);
      expect(JSON.stringify(refreshedCache)).toContain('gpt-revalidated');
    });

    it('ignores corrupt cache files', () => {
      const cachePath = path.join(tmpDir, 'openai-models-cache.json');
      writeFileSync(cachePath, '{broken', { mode: 0o600 });

      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir);

      expect(provider.ownsModel('gpt-5.3-codex')).toBe(true);
    });

    it('does not activate a cache from another client version', async () => {
      const cachePath = path.join(tmpDir, 'openai-models-cache.json');
      const initialFetch = mock(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'gpt-incompatible-cache' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, initialFetch);
      await provider.getModels();
      const incompatibleCache = JSON.parse(readFileSync(cachePath, 'utf-8')) as Record<
        string,
        unknown
      >;
      incompatibleCache.clientVersion = '0.147.0';
      writeFileSync(cachePath, JSON.stringify(incompatibleCache), { mode: 0o600 });

      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir);

      expect(provider.ownsModel('gpt-incompatible-cache')).toBe(false);
      expect(provider.ownsModel('gpt-5.3-codex')).toBe(true);
    });

    it('forces an unconditional refresh instead of reusing the ETag', async () => {
      const fetchImpl = mock()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: [{ id: 'gpt-etag' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ETag: 'catalog-v1' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: [{ id: 'gpt-refreshed' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ETag: 'catalog-v2' },
          })
        ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

      await provider.getModels();
      provider.clearModelCache();
      const models = await provider.getModels();

      expect(models.map((model) => model.id)).toEqual(['gpt-refreshed']);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [, init] = (fetchImpl as ReturnType<typeof mock>).mock.calls[1] as [URL, RequestInit];
      expect((init.headers as Record<string, string>)['if-none-match']).toBeUndefined();
    });

    it('queues a forced refresh behind an in-flight conditional request', async () => {
      let resolveFirst: ((response: Response) => void) | undefined;
      const firstResponse = new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      });
      const fetchImpl = mock()
        .mockImplementationOnce(async () => firstResponse)
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: [{ id: 'gpt-forced-after-flight' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

      const initial = provider.getModels();
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
      provider.clearModelCache();
      const forced = provider.getModels();
      resolveFirst?.(
        new Response(JSON.stringify({ data: [{ id: 'gpt-in-flight' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ETag: 'catalog-v1' },
        })
      );

      await initial;
      const models = await forced;

      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const [, forcedInit] = (fetchImpl as ReturnType<typeof mock>).mock.calls[1] as [
        URL,
        RequestInit,
      ];
      expect((forcedInit.headers as Record<string, string>)['if-none-match']).toBeUndefined();
      expect(models.map((model) => model.id)).toEqual(['gpt-forced-after-flight']);
    });

    it('keeps the last valid catalog when a forced refresh is malformed', async () => {
      const fetchImpl = mock()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: [{ id: 'gpt-stable' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ models: [] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, fetchImpl);

      await provider.getModels();
      provider.clearModelCache();
      const models = await provider.getModels();

      expect(models.map((model) => model.id)).toEqual(['gpt-stable']);
    });

    it.skipIf(!isBun)('rekeys an active bridge after proactive OAuth refresh', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const staleToken = makeJwt({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-old' },
      });
      const refreshedToken = makeJwt({
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'acct-new',
          is_fedramp_account: true,
        },
        jti: 'refreshed',
      });
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: staleToken,
        refresh: 'refresh-token',
        accountId: 'acct-old',
        expires: Date.now() + 60_000,
      });
      const catalogFetch = mock(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'gpt-5.3-codex' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      ) as unknown as typeof fetch;
      const capturedHeaders: Headers[] = [];
      const refreshFetch = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (typeof url === 'string' && url.includes('/oauth/token')) {
          return new Response(
            JSON.stringify({
              access_token: refreshedToken,
              refresh_token: 'next-refresh-token',
              expires_in: 3600,
              token_type: 'Bearer',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (typeof url === 'string' && url.includes('/responses')) {
          capturedHeaders.push(new Headers(init?.headers));
          return new Response(
            `event: response.completed\ndata: ${JSON.stringify({
              type: 'response.completed',
              response: { usage: { input_tokens: 1, output_tokens: 0 }, output: [] },
            })}\n\n`,
            { headers: { 'Content-Type': 'text/event-stream' } }
          );
        }
        return new Response('not found', { status: 404 });
      });
      try {
        provider = makeProvider({}, hyperneoDir, tmpDir, catalogFetch);
        await provider.getApiKey();
        const config = provider.buildSdkConfig('gpt-5.3-codex', {
          sessionId: 'proactive-refresh',
        });
        const port = new URL(config.envVars.ANTHROPIC_BASE_URL as string).port;

        await provider.getModels();
        const response = await fetch(`${config.envVars.ANTHROPIC_BASE_URL}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-5.3-codex',
            max_tokens: 128,
            messages: [{ role: 'user', content: 'Say hello.' }],
          }),
        });

        expect(response.status).toBe(200);
        expect(new URL(config.envVars.ANTHROPIC_BASE_URL as string).port).toBe(port);
        expect(capturedHeaders[0]?.get('Authorization')).toBe(`Bearer ${refreshedToken}`);
        expect(capturedHeaders[0]?.get('ChatGPT-Account-ID')).toBe('acct-new');
        expect(capturedHeaders[0]?.get('X-OpenAI-Fedramp')).toBe('true');
        const servers = (provider as unknown as { bridgeServers: Map<string, { port: number }> })
          .bridgeServers;
        expect([...servers.keys()]).toEqual(['responses:chatgpt:acct-new:fedramp']);
        expect(servers.values().next().value?.port).toBe(Number(port));
      } finally {
        refreshFetch.mockRestore();
      }
    });

    it('switches to the refreshed OAuth scope before failed discovery returns', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const staleToken = makeJwt({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-old' },
      });
      const refreshedToken = makeJwt({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-new' },
        jti: 'refreshed-scope',
      });
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: staleToken,
        refresh: 'refresh-token',
        accountId: 'acct-old',
        expires: Date.now() + 60_000,
      });
      const catalogFetch = mock(async () => {
        throw new Error('catalog offline');
      }) as unknown as typeof fetch;
      const refreshFetch = spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: refreshedToken,
            refresh_token: 'next-refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      try {
        provider = makeProvider({}, hyperneoDir, tmpDir, catalogFetch);
        (
          provider as unknown as { replaceCatalog: (entries: unknown[], scope: unknown) => void }
        ).replaceCatalog(
          [
            {
              info: {
                id: 'gpt-old-account-only',
                name: 'Old Account Only',
                family: 'gpt',
                provider: 'anthropic-codex',
                contextWindow: 128000,
              },
              visibility: 'list',
            },
          ],
          {
            source: 'chatgpt_oauth',
            credentialId: 'acct-old',
            accountId: 'acct-old',
            isFedrampAccount: false,
          }
        );

        const models = await provider.getModels();

        expect(models.map((model) => model.id)).not.toContain('gpt-old-account-only');
        expect(models.map((model) => model.id)).toContain('gpt-5.6-sol');
      } finally {
        refreshFetch.mockRestore();
      }
    });

    it.skipIf(!isBun)('clamps thinking to a discovered model reasoning level', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'oauth-access-token',
        refresh: 'oauth-refresh-token',
        accountId: 'acct-reasoning',
      });
      const catalogFetch = mock(
        async () =>
          new Response(
            JSON.stringify({
              models: [
                {
                  slug: 'gpt-limited-reasoning',
                  display_name: 'GPT Limited Reasoning',
                  visibility: 'list',
                  supported_in_api: true,
                  supported_reasoning_levels: [
                    { effort: 'low', description: 'Fast' },
                    { effort: 'medium', description: 'Balanced' },
                  ],
                  priority: 1,
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
      ) as unknown as typeof fetch;
      const captured = { body: undefined as Record<string, unknown> | undefined };
      const originalFetch = globalThis.fetch.bind(globalThis);
      const responseFetch = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
        if (typeof url === 'string' && url.includes('/responses')) {
          captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return new Response(
            `event: response.completed\ndata: ${JSON.stringify({
              type: 'response.completed',
              response: { usage: { input_tokens: 1, output_tokens: 0 }, output: [] },
            })}\n\n`,
            { headers: { 'Content-Type': 'text/event-stream' } }
          );
        }
        return originalFetch(url, init);
      });
      try {
        provider = makeProvider({}, hyperneoDir, tmpDir, catalogFetch);
        await provider.getModels();
        const config = provider.buildSdkConfig('gpt-limited-reasoning', {
          sessionId: 'limited-reasoning',
        });
        provider.setSessionThinkingConfig('limited-reasoning', 'think32k');

        const response = await fetch(`${config.envVars.ANTHROPIC_BASE_URL}/v1/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'gpt-limited-reasoning',
            max_tokens: 128,
            messages: [{ role: 'user', content: 'Think deeply.' }],
          }),
        });

        expect(response.status).toBe(200);
        expect(captured.body?.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
      } finally {
        responseFetch.mockRestore();
      }
    });

    it.skipIf(!isBun)(
      'preserves known reasoning limits when rich metadata omits levels',
      async () => {
        const hyperneoDir = path.join(tmpDir, 'hyperneo');
        writeHyperNeoAuth(hyperneoDir, {
          type: 'oauth',
          access: 'oauth-access-token',
          refresh: 'oauth-refresh-token',
          accountId: 'acct-rich-mini',
        });
        const catalogFetch = mock(
          async () =>
            new Response(
              JSON.stringify({
                models: [
                  {
                    slug: 'gpt-5.4-mini',
                    display_name: 'GPT-5.4 Mini',
                    visibility: 'list',
                    supported_in_api: true,
                    priority: 1,
                  },
                ],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
        ) as unknown as typeof fetch;
        const captured = { body: undefined as Record<string, unknown> | undefined };
        const originalFetch = globalThis.fetch.bind(globalThis);
        const responseFetch = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
          if (typeof url === 'string' && url.includes('/responses')) {
            captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return new Response(
              `event: response.completed\ndata: ${JSON.stringify({
                type: 'response.completed',
                response: { usage: { input_tokens: 1, output_tokens: 0 }, output: [] },
              })}\n\n`,
              { headers: { 'Content-Type': 'text/event-stream' } }
            );
          }
          return originalFetch(url, init);
        });
        try {
          provider = makeProvider({}, hyperneoDir, tmpDir, catalogFetch);
          await provider.getModels();
          const config = provider.buildSdkConfig('gpt-5.4-mini', {
            sessionId: 'rich-mini',
          });
          provider.setSessionThinkingConfig('rich-mini', 'think32k');

          await fetch(`${config.envVars.ANTHROPIC_BASE_URL}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: 'gpt-5.4-mini',
              max_tokens: 128,
              messages: [{ role: 'user', content: 'Think deeply.' }],
            }),
          });

          expect(captured.body?.reasoning).toEqual({ effort: 'high', summary: 'auto' });
        } finally {
          responseFetch.mockRestore();
        }
      }
    );

    it('refreshes OAuth after a 401 and retries model discovery once', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const refreshedToken = makeJwt({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-refresh' },
      });
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'stale-token',
        refresh: 'refresh-token',
        accountId: 'acct-refresh',
      });
      const fetchImpl = mock()
        .mockResolvedValueOnce(new Response('unauthorized', { status: 401 }))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ data: [{ id: 'gpt-after-refresh' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
        ) as unknown as typeof fetch;
      const refreshFetch = spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: refreshedToken,
            refresh_token: 'next-refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );
      try {
        provider = makeProvider({}, hyperneoDir, tmpDir, fetchImpl);

        const models = await provider.getModels();

        expect(models.map((model) => model.id)).toEqual(['gpt-after-refresh']);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        const [, retryInit] = (fetchImpl as ReturnType<typeof mock>).mock.calls[1] as [
          URL,
          RequestInit,
        ];
        expect((retryInit.headers as Record<string, string>).authorization).toBe(
          `Bearer ${refreshedToken}`
        );
      } finally {
        refreshFetch.mockRestore();
      }
    });

    it('does not expose a persisted catalog to different credentials after restart', async () => {
      const firstFetch = mock(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'gpt-first-account-only' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'first-key' }, tmpDir, tmpDir, firstFetch);
      await provider.getModels();

      const offlineFetch = mock(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch;
      const restarted = makeProvider(
        { OPENAI_API_KEY: 'second-key' },
        tmpDir,
        tmpDir,
        offlineFetch
      );

      const models = await restarted.getModels();

      expect(models.map((model) => model.id)).toContain('gpt-5.6-sol');
      expect(models.map((model) => model.id)).not.toContain('gpt-first-account-only');
      expect(restarted.ownsModel('gpt-first-account-only')).toBe(false);
      restarted.stopAllBridgeServers();
    });

    it('uses a persisted catalog after restart even when discovery is offline', async () => {
      const firstFetch = mock(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'gpt-persisted-offline' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      ) as unknown as typeof fetch;
      provider = makeProvider({ OPENAI_API_KEY: 'sk-env-key' }, tmpDir, tmpDir, firstFetch);
      await provider.getModels();

      const offlineFetch = mock(async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch;
      const restarted = makeProvider(
        { OPENAI_API_KEY: 'sk-env-key' },
        tmpDir,
        tmpDir,
        offlineFetch
      );

      const models = await restarted.getModels();

      expect(models.map((model) => model.id)).toEqual(['gpt-persisted-offline']);
      expect(offlineFetch).not.toHaveBeenCalled();
      restarted.stopAllBridgeServers();
    });

    it('sends FedRAMP routing on OAuth model discovery', async () => {
      const fetchImpl = mock(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'gpt-fedramp' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      ) as unknown as typeof fetch;
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'oauth-access-token',
        refresh: 'oauth-refresh-token',
        accountId: 'acct-fedramp',
        isFedrampAccount: true,
      });
      provider = makeProvider({}, hyperneoDir, tmpDir, fetchImpl);

      await provider.getModels();

      const [, init] = (fetchImpl.mock.calls[0] as [URL, RequestInit]) ?? [];
      const headers = init.headers as Record<string, string>;
      expect(headers['ChatGPT-Account-ID']).toBe('acct-fedramp');
      expect(headers['X-OpenAI-Fedramp']).toBe('true');
    });
  });

  describe('importFromCodexAuth() — one-time migration', () => {
    let tmpDir: string;
    let fetchSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-import-test-'));
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

      const hyperneoAuth = JSON.parse(
        readFileSync(path.join(hyperneoDir, 'auth.json'), 'utf-8')
      ) as {
        openai: { type: string; access: string };
      };
      expect(hyperneoAuth.openai.type).toBe('api_key');
      expect(hyperneoAuth.openai.access).toBe('sk-codex-api-key');

      expect(fetchSpy).not.toHaveBeenCalled();
      p.stopAllBridgeServers();
    });

    it('Test 2: refreshes expired token + imports into ~/.hyperneo/auth.json', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');
      writeCodexAuth(codexDir, {
        tokens: { access_token: 'old-expired-token', refresh_token: 'valid-refresh-token' },
      });

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

      fetchSpy.mockResolvedValueOnce(
        new Response('{"error":"invalid_grant"}', {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      );

      const p = makeProvider({}, hyperneoDir, codexDir);
      const key = await p.getApiKey();

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

      writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'already-imported-token' });

      const p = makeProvider({}, hyperneoDir, codexDir);

      const key1 = await p.getApiKey();
      expect(key1).toBe('already-imported-token');

      await fs.unlink(path.join(hyperneoDir, 'auth.json'));

      const key2 = await p.getApiKey();
      expect(key2).toBe('already-imported-token');

      expect(fetchSpy).not.toHaveBeenCalled();
      p.stopAllBridgeServers();
    });
  });

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

    it('coalesces concurrent refreshes that rotate the refresh token', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const refreshedAccess = makeJwt({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-coalesced' },
      });
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'stale-access-token',
        refresh: 'single-use-refresh-token',
        expires: Date.now() - 60_000,
        accountId: 'acct-coalesced',
      });
      let resolveRefresh: ((response: Response) => void) | undefined;
      const refreshResponse = new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      });
      fetchSpy.mockImplementationOnce(async () => refreshResponse);
      const p = makeProvider({}, hyperneoDir, path.join(tmpDir, 'codex'));

      const first = p.refreshToken();
      const second = p.refreshToken();
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      resolveRefresh?.(
        new Response(
          JSON.stringify({
            access_token: refreshedAccess,
            refresh_token: 'rotated-refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(await p.getApiKey()).toBe(refreshedAccess);
      const saved = JSON.parse(readFileSync(path.join(hyperneoDir, 'auth.json'), 'utf-8')) as {
        openai: { refresh: string };
      };
      expect(saved.openai.refresh).toBe('rotated-refresh-token');
      p.stopAllBridgeServers();
    });

    it('does not let an old-account refresh overwrite replacement credentials', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const oldAccess = makeJwt({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-old' },
      });
      const refreshedOldAccess = makeJwt({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-old' },
      });
      const replacementAccess = makeJwt({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-new' },
      });
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: oldAccess,
        refresh: 'old-refresh-token',
        expires: Date.now() - 60_000,
        accountId: 'acct-old',
      });
      let resolveRefresh: ((response: Response) => void) | undefined;
      const refreshResponse = new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      });
      fetchSpy.mockImplementationOnce(async () => refreshResponse);
      const p = makeProvider({}, hyperneoDir, path.join(tmpDir, 'codex'));

      const oldRefresh = p.refreshToken();
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      p.setCredentials({
        type: 'oauth',
        accessToken: replacementAccess,
        refreshToken: 'new-refresh-token',
        expiresAt: Date.now() + 3600_000,
        raw: { accountId: 'acct-new' },
      });
      resolveRefresh?.(
        new Response(
          JSON.stringify({
            access_token: refreshedOldAccess,
            refresh_token: 'rotated-old-refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await expect(oldRefresh).resolves.toBe(false);
      expect(await p.getApiKey()).toBe(replacementAccess);
      const saved = JSON.parse(readFileSync(path.join(hyperneoDir, 'auth.json'), 'utf-8')) as {
        openai: { access: string; refresh: string };
      };
      expect(saved.openai.access).toBe(oldAccess);
      expect(saved.openai.refresh).toBe('old-refresh-token');
      p.stopAllBridgeServers();
    });

    it('does not let an in-flight refresh restore credentials after logout', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const refreshedAccess = makeJwt({
        'https://api.openai.com/auth': { chatgpt_account_id: 'acct-logout' },
      });
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'stale-access-token',
        refresh: 'logout-refresh-token',
        expires: Date.now() - 60_000,
        accountId: 'acct-logout',
      });
      let resolveRefresh: ((response: Response) => void) | undefined;
      const refreshResponse = new Promise<Response>((resolve) => {
        resolveRefresh = resolve;
      });
      fetchSpy.mockImplementationOnce(async () => refreshResponse);
      const p = makeProvider({}, hyperneoDir, path.join(tmpDir, 'codex'));

      const refresh = p.refreshToken();
      await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
      await p.logout();
      resolveRefresh?.(
        new Response(
          JSON.stringify({
            access_token: refreshedAccess,
            refresh_token: 'rotated-logout-refresh-token',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await expect(refresh).resolves.toBe(false);
      expect(await p.getApiKey()).toBeUndefined();
      expect(existsSync(path.join(hyperneoDir, 'auth.json'))).toBe(false);
      p.stopAllBridgeServers();
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

  describe.skipIf(!isBun)('setSessionThinkingConfig', () => {
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

    it('does not send reasoning for a discovered non-reasoning model', async () => {
      const captured = { body: undefined as Record<string, unknown> | undefined };
      const fetchSpy = mockUpstreamFetch(captured);
      const catalogFetch = mock(
        async () =>
          new Response(JSON.stringify({ data: [{ id: 'o3' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          })
      ) as unknown as typeof fetch;
      const p = makeProvider({ OPENAI_API_KEY: 'sk-test' }, undefined, undefined, catalogFetch);
      await p.getModels();
      const cfg = p.buildSdkConfig('o3', { sessionId: 'sess-no-reasoning' });

      p.setSessionThinkingConfig('sess-no-reasoning', 'think32k');

      const resp = await fetch(`${cfg.envVars.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' },
        body: JSON.stringify({
          model: 'o3',
          max_tokens: 128,
          messages: [{ role: 'user', content: 'Say hi.' }],
        }),
      });

      expect(resp.status).toBe(200);
      expect(captured.body?.reasoning).toBeUndefined();

      fetchSpy.mockRestore();
      p.stopAllBridgeServers();
    });

    it.skipIf(!isBun)(
      'applies thinking capability to each primary and fallback model',
      async () => {
        const capturedBodies: Record<string, unknown>[] = [];
        const originalFetch = globalThis.fetch.bind(globalThis);
        const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
          if (
            typeof url === 'string' &&
            (url.includes('api.openai.com') || url.includes('chatgpt.com'))
          ) {
            capturedBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
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
        const catalogFetch = mock(
          async () =>
            new Response(
              JSON.stringify({
                models: [
                  {
                    slug: 'gpt-reasoning',
                    display_name: 'GPT Reasoning',
                    visibility: 'list',
                    supported_in_api: true,
                    supported_reasoning_levels: [{ effort: 'high' }],
                    priority: 1,
                  },
                  {
                    slug: 'gpt-no-reasoning',
                    display_name: 'GPT No Reasoning',
                    visibility: 'list',
                    supported_in_api: true,
                    supported_reasoning_levels: [],
                    priority: 2,
                  },
                ],
              }),
              { status: 200, headers: { 'Content-Type': 'application/json' } }
            )
        ) as unknown as typeof fetch;
        const p = makeProvider({ OPENAI_API_KEY: 'sk-test' }, undefined, undefined, catalogFetch);
        try {
          await p.getModels();
          const session = { sessionId: 'mixed-capabilities' };
          const config = p.buildSdkConfig('gpt-no-reasoning', session);
          p.buildSdkConfig('gpt-reasoning', session);
          p.setSessionThinkingConfig(session.sessionId, 'think24k');

          for (const model of ['gpt-no-reasoning', 'gpt-reasoning']) {
            const response = await fetch(`${config.envVars.ANTHROPIC_BASE_URL}/v1/messages`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model,
                max_tokens: 128,
                messages: [{ role: 'user', content: 'Think.' }],
              }),
            });
            expect(response.status).toBe(200);
          }

          p.buildSdkConfig('gpt-reasoning', session);
          p.buildSdkConfig('gpt-no-reasoning', session);
          for (const model of ['gpt-reasoning', 'gpt-no-reasoning']) {
            const response = await fetch(`${config.envVars.ANTHROPIC_BASE_URL}/v1/messages`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model,
                max_tokens: 128,
                messages: [{ role: 'user', content: 'Think.' }],
              }),
            });
            expect(response.status).toBe(200);
          }

          expect(capturedBodies.map((body) => body.reasoning)).toEqual([
            undefined,
            { effort: 'high', summary: 'auto' },
            { effort: 'high', summary: 'auto' },
            undefined,
          ]);
        } finally {
          fetchSpy.mockRestore();
          p.stopAllBridgeServers();
        }
      }
    );

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

  describe('setSessionThinkingConfig (no bridge required)', () => {
    it('is a no-op when no bridge server is active', () => {
      const p = makeProvider({ OPENAI_API_KEY: 'sk-test' });
      expect(() => p.setSessionThinkingConfig('sess-456', 'think16k')).not.toThrow();
    });
  });
});
