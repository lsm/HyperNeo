import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { vi } from 'vitest';
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
import {
  recordProviderFailure,
  resetProviderFailureStore,
} from '../../../../src/lib/providers/provider-failure-store';

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

    it('reports the maximum Codex context window', async () => {
      expect(provider.capabilities.maxContextWindow).toBe(1050000);
    });

    it('advertises thinking when the Responses adapter is active', async () => {
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
      resetProviderFailureStore();
      rmSync(emptyDir, { recursive: true, force: true });
    });

    it('returns isAuthenticated=false when no credentials', async () => {
      provider = makeProvider({}, emptyDir, emptyDir);
      const result = await provider.getAuthStatus();
      expect(result.isAuthenticated).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('treats a missing auth file as definitively logged out', async () => {
      provider = makeProvider({}, emptyDir, emptyDir);

      const result = await provider.getAuthStatus();

      expect(result.isAuthenticated).toBe(false);
      expect(result.errorKind).toBeUndefined();
      expect(result.error).toContain('Not logged in');
    });

    it('classifies unreadable auth credentials as transient', async () => {
      const hyperneoDir = path.join(emptyDir, 'hyperneo');
      mkdirSync(hyperneoDir, { recursive: true });
      writeFileSync(path.join(hyperneoDir, 'auth.json'), '{invalid json', { mode: 0o600 });
      provider = makeProvider({}, hyperneoDir, emptyDir);

      const result = await provider.getAuthStatus();

      expect(result.isAuthenticated).toBe(false);
      expect(result.errorKind).toBe('transient');
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

    it('surfaces a recorded transient failure as authenticated-but-degraded', async () => {
      const hyperneoDir = path.join(emptyDir, 'hyperneo');
      const codexDir = path.join(emptyDir, 'codex');
      writeHyperNeoAuth(hyperneoDir, {
        type: 'oauth',
        access: 'oauth-access-token',
        refresh: 'oauth-refresh-token',
        expires: Date.now() + 3600_000,
      });
      provider = makeProvider({}, hyperneoDir, codexDir);
      recordProviderFailure('anthropic-codex', new Error('Codex probe failed (HTTP 503)'));

      const result = await provider.getAuthStatus();

      expect(result.isAuthenticated).toBe(true);
      expect(result.errorKind).toBe('transient');
      expect(result.error).toBe('Codex probe failed (HTTP 503)');
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

    it('shares the Responses bridge server across workspace paths with the same auth', async () => {
      await provider.ensureBridgeStarted('gpt-5.3-codex', { workspacePath: '/tmp/workspace-a' });
      const cfgA = provider.buildSdkConfig('gpt-5.3-codex', { workspacePath: '/tmp/workspace-a' });
      await provider.ensureBridgeStarted('gpt-5.3-codex', { workspacePath: '/tmp/workspace-b' });
      const cfgB = provider.buildSdkConfig('gpt-5.3-codex', { workspacePath: '/tmp/workspace-b' });

      const urlA = cfgA.envVars.ANTHROPIC_BASE_URL as string;
      const urlB = cfgB.envVars.ANTHROPIC_BASE_URL as string;
      expect(urlA).toBe(urlB);
      expect(new URL(urlA).port).toBe(new URL(urlB).port);
    });

    it('reuses the same bridge server for the same workspace path', async () => {
      await provider.ensureBridgeStarted('gpt-5.3-codex', {
        workspacePath: '/tmp/workspace-reuse',
      });
      const cfg1 = provider.buildSdkConfig('gpt-5.3-codex', {
        workspacePath: '/tmp/workspace-reuse',
      });
      await provider.ensureBridgeStarted('gpt-5.3-codex', {
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
        await p.ensureBridgeStarted('gpt-5.3-codex', {
          workspacePath: '/tmp/workspace-auth-late',
        });
        const cfgWithoutAuth = p.buildSdkConfig('gpt-5.3-codex', {
          workspacePath: '/tmp/workspace-auth-late',
        });

        writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'file-token-now-available' });
        await p.getApiKey();

        await p.ensureBridgeStarted('gpt-5.3-codex', {
          workspacePath: '/tmp/workspace-auth-late',
        });
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
        await p.ensureBridgeStarted('gpt-5.6-sol', { workspacePath: '/tmp/ws-oauth-window' });
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

        await p.ensureBridgeStarted('gpt-5.3-codex', { workspacePath: '/tmp/ws-refresh' });
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

        await p.ensureBridgeStarted('gpt-5.3-codex', { workspacePath: '/tmp/ws-refresh' });
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

        await p.ensureBridgeStarted('gpt-5.3-codex', {
          workspacePath: '/tmp/workspace-auth-change',
        });
        const firstCfg = p.buildSdkConfig('gpt-5.3-codex', {
          workspacePath: '/tmp/workspace-auth-change',
        });
        const firstBaseUrl = firstCfg.envVars.ANTHROPIC_BASE_URL;
        await fetchLocal(firstBaseUrl);

        env.OPENAI_API_KEY = 'sk-second';
        await p.ensureBridgeStarted('gpt-5.3-codex', {
          workspacePath: '/tmp/workspace-auth-change',
        });
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
        await p.ensureBridgeStarted('gpt-5.3-codex', {
          workspacePath: '/tmp/workspace-auth-change',
        });
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

    it('returns isAnthropicCompatible=true and clears OAuth token precedence', async () => {
      await provider.ensureBridgeStarted('gpt-5.3-codex', { workspacePath: '/tmp/ws-compat' });
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
        await p.ensureBridgeStarted('gpt-5.3-codex', { workspacePath: '/tmp/file-auth-ws' });
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
        await p.ensureBridgeStarted('gpt-5.3-codex', { workspacePath: '/tmp/empty-env-ws' });
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
        await p.ensureBridgeStarted('gpt-5.3-codex', { workspacePath: '/tmp/fedramp-ws' });
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

    it('sets ANTHROPIC_DEFAULT_*_MODEL env vars to real Codex model IDs', async () => {
      await provider.ensureBridgeStarted('gpt-5.6-terra', { workspacePath: '/tmp/ws-model' });
      const cfg = provider.buildSdkConfig('gpt-5.6-terra', { workspacePath: '/tmp/ws-model' });
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.6-terra');
      expect(cfg.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('gpt-5.6-luna');
      expect(cfg.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gpt-5.6-sol');
      expect(cfg.envVars.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1050000');
    });

    it('routes GPT-5.6 Sol using real Codex ID with context metadata', async () => {
      await provider.ensureBridgeStarted('gpt-5.6-sol', { workspacePath: '/tmp/ws-gpt-56-sol' });
      const cfg = provider.buildSdkConfig('gpt-5.6-sol', { workspacePath: '/tmp/ws-gpt-56-sol' });
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.6-sol');
      expect(cfg.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('gpt-5.6-sol');

      const models = await provider.getModels();
      const sol = models.find((model) => model.id === 'gpt-5.6-sol');
      expect(sol?.contextWindow).toBe(1_050_000);
      expect(sol?.preferContextWindowMetadata).toBe(true);
      expect(sol?.sdkModelIds).toContain('gpt-5.6-sol');
    });

    it('resolves model alias to real Codex ID in ANTHROPIC_DEFAULT_SONNET_MODEL', async () => {
      await provider.ensureBridgeStarted('codex', { workspacePath: '/tmp/ws-alias' });
      const cfg = provider.buildSdkConfig('codex', { workspacePath: '/tmp/ws-alias' });
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.3-codex');
    });

    it('keeps the SDK sonnet tier on Luna for mini Codex sessions', async () => {
      await provider.ensureBridgeStarted('codex-mini', { workspacePath: '/tmp/ws-mini' });
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
        await provider.ensureBridgeStarted('gpt-5.6-luna', lunaSession);
        const lunaPrimary = provider.buildSdkConfig('gpt-5.6-luna', lunaSession);
        await provider.ensureBridgeStarted('gpt-5.6-sol', lunaSession);
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
        await provider.ensureBridgeStarted('gpt-5.6-sol', frontierSession);
        const frontierPrimary = provider.buildSdkConfig('gpt-5.6-sol', frontierSession);
        await provider.ensureBridgeStarted('gpt-5.6-luna', frontierSession);
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

    it('resolves codex-latest alias to real Codex ID', async () => {
      await provider.ensureBridgeStarted('codex-latest', { workspacePath: '/tmp/ws-latest' });
      const cfg = provider.buildSdkConfig('codex-latest', { workspacePath: '/tmp/ws-latest' });
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.6-sol');
    });

    it('resolves gpt-5.4 alias to real Codex ID', async () => {
      await provider.ensureBridgeStarted('codex-5.4', { workspacePath: '/tmp/ws-54' });
      const cfg = provider.buildSdkConfig('codex-5.4', { workspacePath: '/tmp/ws-54' });
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('gpt-5.4');
    });

    it('throws for unknown model IDs instead of silently falling back', async () => {
      expect(() =>
        provider.buildSdkConfig('unknown-model', { workspacePath: '/tmp/ws-unk' })
      ).toThrow('Unknown Codex model: unknown-model');
    });

    it('uses real Codex model IDs in ANTHROPIC_DEFAULT_*_MODEL env vars', async () => {
      await provider.ensureBridgeStarted('gpt-5.3-codex', {
        workspacePath: '/tmp/ws-no-leak',
      });
      const cfg = provider.buildSdkConfig('gpt-5.3-codex', {
        workspacePath: '/tmp/ws-no-leak',
      });
      expect(cfg.envVars.ANTHROPIC_DEFAULT_HAIKU_MODEL).toMatch(/^gpt-/);
      expect(cfg.envVars.ANTHROPIC_DEFAULT_SONNET_MODEL).toMatch(/^gpt-/);
      expect(cfg.envVars.ANTHROPIC_DEFAULT_OPUS_MODEL).toMatch(/^gpt-/);
    });

    it('advertises real Codex context windows in bridge models list', async () => {
      await provider.ensureBridgeStarted('gpt-5.3-codex', {
        workspacePath: '/tmp/ws-models',
      });
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
  });

  describe('ownsModel()', () => {
    beforeEach(() => {
      provider = makeProvider({}, undefined, undefined);
    });

    it('owns models explicitly listed in the catalogue', async () => {
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

    it('does not own models not in the catalogue', async () => {
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

    it('translates all model IDs to "default" following GLM/Kimi pattern', async () => {
      expect(provider.translateModelIdForSdk('codex-latest')).toBe('default');
      expect(provider.translateModelIdForSdk('codex-mini')).toBe('default');
      expect(provider.translateModelIdForSdk('codex-5.6-terra')).toBe('default');
      expect(provider.translateModelIdForSdk('gpt-5.5')).toBe('default');
      expect(provider.translateModelIdForSdk('unknown-model')).toBe('default');
    });

    it('does not own claude- models', async () => {
      expect(provider.ownsModel('claude-3-opus')).toBe(false);
    });

    it('does not own arbitrary unrecognised model IDs', async () => {
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
      expect(headers['ChatGPT-Account-ID']).toBe('acct-1');
      expect(headers['OpenAI-Beta']).toBeUndefined();
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

  describe('getBridgeAuth() negative auth cache', () => {
    let tmpDir: string;
    let fetchSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'hyperneo-negative-cache-test-'));
      fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(
        new Error('fetch not mocked for this test')
      );
    });

    afterEach(() => {
      fetchSpy.mockRestore();
      rmSync(tmpDir, { recursive: true, force: true });
    });

    function authJsonReadCount(): number {
      return fsPromiseMocks.readFile.mock.calls.filter((call) =>
        String(call[0]).endsWith('auth.json')
      ).length;
    }

    function fastForwardNegativeCacheTtl(): () => void {
      const originalNow = Date.now;
      Date.now = () => originalNow() + 5 * 60 * 1000 + 1;
      return () => {
        Date.now = originalNow;
      };
    }

    it('caches the miss until the TTL expires, then picks up a later-appearing ~/.hyperneo/auth.json', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');

      const p = makeProvider({}, hyperneoDir, codexDir);
      expect(await p.getApiKey()).toBeUndefined();
      expect(await p.isAvailable()).toBe(false);

      writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'late-hyperneo-token' });
      const readsBefore = authJsonReadCount();

      expect(await p.getApiKey()).toBeUndefined();
      expect(await p.isAvailable()).toBe(false);
      expect(authJsonReadCount()).toBe(readsBefore);

      const restoreNow = fastForwardNegativeCacheTtl();
      try {
        expect(await p.getApiKey()).toBe('late-hyperneo-token');
        expect(await p.isAvailable()).toBe(true);
      } finally {
        restoreNow();
      }

      p.stopAllBridgeServers();
    });

    it('caches the miss until the TTL expires, then picks up a later-appearing ~/.codex/auth.json', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');

      const p = makeProvider({}, hyperneoDir, codexDir);
      expect(await p.getApiKey()).toBeUndefined();

      writeCodexAuth(codexDir, { OPENAI_API_KEY: 'late-codex-key' });

      expect(await p.getApiKey()).toBeUndefined();
      expect(await p.isAvailable()).toBe(false);

      const restoreNow = fastForwardNegativeCacheTtl();
      try {
        expect(await p.getApiKey()).toBe('late-codex-key');
        expect(await p.isAvailable()).toBe(true);
      } finally {
        restoreNow();
      }

      p.stopAllBridgeServers();
    });

    it('treats unusable credential files like absent ones until the TTL expires, then re-checks them', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');
      mkdirSync(hyperneoDir, { recursive: true });
      writeFileSync(path.join(hyperneoDir, 'auth.json'), 'not-json', { mode: 0o600 });
      writeCodexAuth(codexDir, { tokens: { refresh_token: 'refresh-only-token' } });

      const p = makeProvider({}, hyperneoDir, codexDir);
      expect(await p.getApiKey()).toBeUndefined();
      expect(await p.isAvailable()).toBe(false);

      writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'late-usable-token' });
      expect(await p.getApiKey()).toBeUndefined();

      const restoreNow = fastForwardNegativeCacheTtl();
      try {
        expect(await p.getApiKey()).toBe('late-usable-token');
        expect(await p.isAvailable()).toBe(true);
      } finally {
        restoreNow();
      }

      p.stopAllBridgeServers();
    });

    it('re-arms a fresh miss window when the TTL re-check still finds no credentials', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');

      const p = makeProvider({}, hyperneoDir, codexDir);
      expect(await p.getApiKey()).toBeUndefined();

      const restoreNow = fastForwardNegativeCacheTtl();
      let readsAfterExpiredRecheck = 0;
      try {
        const readsBeforeRecheck = authJsonReadCount();
        expect(await p.getApiKey()).toBeUndefined();
        readsAfterExpiredRecheck = authJsonReadCount();
        expect(readsAfterExpiredRecheck).toBeGreaterThan(readsBeforeRecheck);
        expect(await p.isAvailable()).toBe(false);
      } finally {
        restoreNow();
      }
      expect(authJsonReadCount()).toBe(readsAfterExpiredRecheck);

      writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'late-hyperneo-token' });
      expect(await p.getApiKey()).toBeUndefined();

      p.stopAllBridgeServers();
    });

    it('does not expire a resolved auth result after the TTL', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');
      writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'hyperneo-token' });

      const p = makeProvider({}, hyperneoDir, codexDir);
      expect(await p.getApiKey()).toBe('hyperneo-token');

      const restoreNow = fastForwardNegativeCacheTtl();
      try {
        expect(await p.getApiKey()).toBe('hyperneo-token');
        expect(await p.isAvailable()).toBe(true);
      } finally {
        restoreNow();
      }

      p.stopAllBridgeServers();
    });

    it('a fresh instance (disable then enable) re-reads unconditionally and picks up late credentials', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');

      const first = makeProvider({}, hyperneoDir, codexDir);
      expect(await first.getApiKey()).toBeUndefined();
      first.stopAllBridgeServers();

      writeHyperNeoAuth(hyperneoDir, { type: 'oauth', access: 'late-hyperneo-token' });

      const second = makeProvider({}, hyperneoDir, codexDir);
      expect(await second.getApiKey()).toBe('late-hyperneo-token');
      expect(await second.isAvailable()).toBe(true);
      second.stopAllBridgeServers();
    });

    it('does not cache a miss when the in-import token refresh fails transiently (network error)', async () => {
      const hyperneoDir = path.join(tmpDir, 'hyperneo');
      const codexDir = path.join(tmpDir, 'codex');
      writeCodexAuth(codexDir, {
        tokens: { access_token: 'codex-existing-token', refresh_token: 'codex-refresh-token' },
      });

      fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const p = makeProvider({}, hyperneoDir, codexDir);
      expect(await p.getApiKey()).toBe('codex-existing-token');
      expect(await p.isAvailable()).toBe(true);
      expect(await p.getApiKey()).toBe('codex-existing-token');
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      const hyperneoAuth = JSON.parse(
        readFileSync(path.join(hyperneoDir, 'auth.json'), 'utf-8')
      ) as {
        openai: { type: string; access: string; refresh: string };
      };
      expect(hyperneoAuth.openai.type).toBe('oauth');
      expect(hyperneoAuth.openai.access).toBe('codex-existing-token');
      expect(hyperneoAuth.openai.refresh).toBe('codex-refresh-token');
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
      await p.ensureBridgeStarted('gpt-5.3-codex', { sessionId: 'sess-123' });
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
      await p.ensureBridgeStarted('gpt-5.3-codex', { sessionId: 'sess-env' });
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

    it('clears config when thinking level is off or undefined', async () => {
      const captured = { body: undefined as Record<string, unknown> | undefined };
      const fetchSpy = mockUpstreamFetch(captured);
      const p = makeProvider({ OPENAI_API_KEY: 'sk-test' });
      await p.ensureBridgeStarted('gpt-5.3-codex', { sessionId: 'sess-789' });
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
    it('is a no-op when no bridge server is active', async () => {
      const p = makeProvider({ OPENAI_API_KEY: 'sk-test' });
      expect(() => p.setSessionThinkingConfig('sess-456', 'think16k')).not.toThrow();
    });
  });
});
