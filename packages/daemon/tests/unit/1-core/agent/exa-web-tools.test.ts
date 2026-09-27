import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { GlobalSettings } from '@hyperneo/shared';
import {
  EXA_CREDENTIAL_PROVIDER_ID,
  resolveExaApiKey,
  resolveExaWebToolsActivation,
} from '../../../../src/lib/agent/exa-web-tools';
import { ProviderCredentialManager } from '../../../../src/lib/credentials/provider-credential-manager';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

function settingsWithExa(exa?: GlobalSettings['exa']): GlobalSettings {
  return { settingSources: ['user'], exa } as GlobalSettings;
}

describe('exa-web-tools', () => {
  let db: BunDatabase;
  let credentialManager: ProviderCredentialManager;
  let priorExaEnv: string | undefined;

  const fakeWrapper = () => ({ getDatabase: () => db });

  beforeEach(() => {
    priorExaEnv = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;
    db = new BunDatabase(':memory:');
    credentialManager = ProviderCredentialManager.create(db);
  });

  afterEach(() => {
    db.close();
    if (priorExaEnv === undefined) {
      delete process.env.EXA_API_KEY;
    } else {
      process.env.EXA_API_KEY = priorExaEnv;
    }
  });

  describe('resolveExaApiKey', () => {
    it('returns null when no key is stored and env is unset', async () => {
      expect(await resolveExaApiKey(fakeWrapper())).toBeNull();
    });

    it('returns the stored credential', async () => {
      await credentialManager.storeApiKey(EXA_CREDENTIAL_PROVIDER_ID, 'stored-key');
      expect(await resolveExaApiKey(fakeWrapper())).toBe('stored-key');
    });

    it('falls back to EXA_API_KEY env when nothing is stored', async () => {
      process.env.EXA_API_KEY = 'env-key';
      expect(await resolveExaApiKey(fakeWrapper())).toBe('env-key');
    });

    it('prefers the stored credential over env', async () => {
      process.env.EXA_API_KEY = 'env-key';
      await credentialManager.storeApiKey(EXA_CREDENTIAL_PROVIDER_ID, 'stored-key');
      expect(await resolveExaApiKey(fakeWrapper())).toBe('stored-key');
    });

    it('falls back to env when the db is unavailable', async () => {
      process.env.EXA_API_KEY = 'env-key';
      const broken = {
        getDatabase: () => {
          throw new Error('no db');
        },
      };
      expect(await resolveExaApiKey(broken)).toBe('env-key');
    });

    it('works without a db when env is set', async () => {
      process.env.EXA_API_KEY = 'env-key';
      expect(await resolveExaApiKey()).toBe('env-key');
    });
  });

  describe('resolveExaWebToolsActivation', () => {
    it('returns undefined when the provider has native web tools', async () => {
      process.env.EXA_API_KEY = 'env-key';
      const activation = await resolveExaWebToolsActivation({
        settings: settingsWithExa({ enabled: true, hasApiKey: true }),
        db: fakeWrapper(),
        nativeWebTools: true,
      });
      expect(activation).toBeUndefined();
    });

    it('returns undefined when exa is not enabled', async () => {
      process.env.EXA_API_KEY = 'env-key';
      const activation = await resolveExaWebToolsActivation({
        settings: settingsWithExa({ enabled: false }),
        db: fakeWrapper(),
        nativeWebTools: false,
      });
      expect(activation).toBeUndefined();
    });

    it('returns undefined when exa settings are absent', async () => {
      process.env.EXA_API_KEY = 'env-key';
      const activation = await resolveExaWebToolsActivation({
        settings: settingsWithExa(undefined),
        db: fakeWrapper(),
        nativeWebTools: false,
      });
      expect(activation).toBeUndefined();
    });

    it('returns undefined when enabled but no API key is available', async () => {
      const activation = await resolveExaWebToolsActivation({
        settings: settingsWithExa({ enabled: true, hasApiKey: true }),
        db: fakeWrapper(),
        nativeWebTools: false,
      });
      expect(activation).toBeUndefined();
    });

    it('returns the MCP server config and disallowed tools when fully configured', async () => {
      await credentialManager.storeApiKey(EXA_CREDENTIAL_PROVIDER_ID, 'stored-key');
      const activation = await resolveExaWebToolsActivation({
        settings: settingsWithExa({ enabled: true, hasApiKey: true }),
        db: fakeWrapper(),
        nativeWebTools: false,
      });
      expect(activation).toBeDefined();
      expect(activation!.serverName).toBe('exa');
      expect(activation!.serverConfig).toEqual({
        type: 'http',
        url: 'https://mcp.exa.ai/mcp?exaApiKey=stored-key',
      });
      expect(activation!.disallowedTools).toEqual(['WebSearch', 'WebFetch']);
    });
  });
});
