import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { AcpProvider } from '../../../../src/lib/providers/acp-provider';

describe('AcpProvider', () => {
  let provider: AcpProvider;
  let originalEnv: NodeJS.ProcessEnv;

  const noopProbe = async (): Promise<void> => {};

  beforeEach(() => {
    originalEnv = { ...process.env };
    delete process.env.HYPERNEO_ACP_COMMAND;
    delete process.env.HYPERNEO_ACP_CONTEXT_WINDOW;
    provider = new AcpProvider(process.env, noopProbe);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('basic properties', () => {
    it('should have correct ID and display name', () => {
      expect(provider.id).toBe('acp');
      expect(provider.displayName).toBe('ACP Agent');
    });

    it('should have correct capabilities', () => {
      expect(provider.capabilities).toEqual({
        streaming: true,
        extendedThinking: true,
        maxContextWindow: 200000,
        functionCalling: true,
        vision: false,
        thinkingModes: 'granular',
      });
    });

    it('should use configured context window in capabilities', () => {
      process.env.HYPERNEO_ACP_CONTEXT_WINDOW = '123456';

      expect(provider.capabilities.maxContextWindow).toBe(123456);
    });
  });

  describe('isAvailable', () => {
    it('should return true when HYPERNEO_ACP_COMMAND is set', () => {
      process.env.HYPERNEO_ACP_COMMAND = 'claude --acp';
      expect(provider.isAvailable()).toBe(true);
    });

    it('should return false when no HYPERNEO_ACP_COMMAND is set', () => {
      expect(provider.isAvailable()).toBe(false);
    });

    it('should return false when HYPERNEO_ACP_COMMAND is empty', () => {
      process.env.HYPERNEO_ACP_COMMAND = '';
      expect(provider.isAvailable()).toBe(false);
    });
  });

  describe('getAcpCommand', () => {
    it('should return the command from env', () => {
      process.env.HYPERNEO_ACP_COMMAND = 'devin';
      expect(provider.getAcpCommand()).toBe('devin');
    });

    it('should return undefined when not set', () => {
      expect(provider.getAcpCommand()).toBeUndefined();
    });
  });

  describe('setAcpCommand', () => {
    it('should override the env command', () => {
      process.env.HYPERNEO_ACP_COMMAND = 'claude --acp';
      provider.setAcpCommand('devin acp');

      expect(provider.getAcpCommand()).toBe('devin acp');
    });

    it('should fall back to env when override is cleared', () => {
      process.env.HYPERNEO_ACP_COMMAND = 'claude --acp';
      provider.setAcpCommand('devin acp');
      provider.setAcpCommand(undefined);

      expect(provider.getAcpCommand()).toBe('claude --acp');
    });

    it('should make the provider available without env', () => {
      provider.setAcpCommand('devin acp');

      expect(provider.isAvailable()).toBe(true);
    });

    it('should clear cached models so getModels reflects the new command', async () => {
      provider.setAcpCommand('old acp');
      provider.setCachedModels([
        {
          id: 'acp-cached',
          name: 'ACP Cached',
          family: 'acp',
          provider: 'acp',
          contextWindow: 100000,
          available: true,
        },
      ]);
      provider.setAcpCommand('devin acp');

      const models = await provider.getModels();

      expect(models[0].id).toBe('acp-default');
    });

    it('should preserve cached models for equivalent command formatting', async () => {
      provider.setAcpCommand('devin acp "model one"');
      provider.setCachedModels([
        {
          id: 'acp-cached',
          name: 'ACP Cached',
          family: 'acp',
          provider: 'acp',
          contextWindow: 100000,
          available: true,
        },
      ]);
      provider.setAcpCommand("devin   acp 'model one'");

      expect((await provider.getModels())[0].id).toBe('acp-cached');
    });
  });

  describe('setAcpModels', () => {
    it('should expose curated models from getModels', async () => {
      provider.setAcpCommand('devin acp');
      provider.setAcpModels([{ id: 'devin-model-a', name: 'Model A' }, { id: 'devin-model-b' }]);

      const models = await provider.getModels();

      expect(models.map((m) => m.id)).toEqual(['devin-model-a', 'devin-model-b']);
      expect(models[0].name).toBe('Model A');
      expect(models[1].name).toBe('devin-model-b');
      expect(models[0].provider).toBe('acp');
    });

    it('should probe the command during explicit health checks', async () => {
      let calls = 0;
      const probed = new AcpProvider(process.env, async () => {
        calls++;
      });
      probed.setAcpCommand('devin acp');
      probed.setAcpModels([{ id: 'devin-model-a' }]);

      await probed.verifyCommandAvailable();

      expect(calls).toBe(1);
    });

    it('should surface command probe failures despite curated models', async () => {
      const probed = new AcpProvider(process.env, async () => {
        throw new Error('probe failed');
      });
      probed.setAcpCommand('broken acp');
      probed.setAcpModels([{ id: 'devin-model-a' }]);

      await expect(probed.verifyCommandAvailable()).rejects.toThrow('probe failed');
      await expect(probed.getModels()).rejects.toThrow('probe failed');
    });

    it('should fall back to defaults when curated list is cleared', async () => {
      process.env.HYPERNEO_ACP_COMMAND = 'claude --acp';
      provider.setAcpModels([{ id: 'devin-model-a' }]);
      provider.setAcpModels(undefined);

      const models = await provider.getModels();

      expect(models[0].id).toBe('acp-default');
    });

    it('should not be overwritten by live config negotiation', () => {
      provider.setAcpCommand('devin acp');
      provider.setAcpModels([{ id: 'devin-model-a' }]);
      provider.setConfigOptions([
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          category: 'model',
          currentValue: 'sonnet',
          options: [{ name: 'Sonnet', value: 'sonnet' }],
        },
      ]);

      expect(provider.getCachedModels()?.map((m) => m.id)).toEqual(['devin-model-a']);
    });

    it('should own curated model ids', () => {
      provider.setAcpCommand('devin acp');
      provider.setAcpModels([{ id: 'devin-model-a' }]);

      expect(provider.ownsModel('devin-model-a')).toBe(true);
      expect(provider.ownsModel('acp-default')).toBe(true);
    });

    it('should survive clearModelCache (e.g. model refresh)', async () => {
      provider.setAcpCommand('devin acp');
      provider.setAcpModels([{ id: 'devin-model-a' }]);
      provider.clearModelCache();

      const models = await provider.getModels();

      expect(models.map((m) => m.id)).toEqual(['devin-model-a']);
    });
  });

  describe('getContextWindow', () => {
    it('should return default context window when env is not set', () => {
      expect(provider.getContextWindow()).toBe(200000);
    });

    it('should return context window from env', () => {
      process.env.HYPERNEO_ACP_CONTEXT_WINDOW = '64000';

      expect(provider.getContextWindow()).toBe(64000);
    });

    it('should truncate fractional context window values', () => {
      process.env.HYPERNEO_ACP_CONTEXT_WINDOW = '64000.9';

      expect(provider.getContextWindow()).toBe(64000);
    });

    it('should return default context window for invalid env values', () => {
      process.env.HYPERNEO_ACP_CONTEXT_WINDOW = 'not-a-number';
      expect(provider.getContextWindow()).toBe(200000);

      process.env.HYPERNEO_ACP_CONTEXT_WINDOW = '0';
      expect(provider.getContextWindow()).toBe(200000);

      process.env.HYPERNEO_ACP_CONTEXT_WINDOW = '-1';
      expect(provider.getContextWindow()).toBe(200000);
    });
  });

  describe('getModels', () => {
    it('should return default models when ACP command is available', async () => {
      process.env.HYPERNEO_ACP_COMMAND = 'claude --acp';

      const models = await provider.getModels();

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('acp-default');
      expect(models[0].provider).toBe('acp');
      expect(models[0].contextWindow).toBe(200000);
    });

    it('should use configured context window in default models', async () => {
      process.env.HYPERNEO_ACP_COMMAND = 'claude --acp';
      process.env.HYPERNEO_ACP_CONTEXT_WINDOW = '64000';

      const models = await provider.getModels();

      expect(models[0].contextWindow).toBe(64000);
    });

    it('should return empty array when ACP command is not available', async () => {
      const models = await provider.getModels();
      expect(models).toEqual([]);
    });

    it('should discover cached models from model config option', async () => {
      process.env.HYPERNEO_ACP_COMMAND = 'claude --acp';
      provider.setConfigOptions([
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          category: 'model',
          currentValue: 'sonnet',
          options: [
            { name: 'Sonnet', value: 'sonnet' },
            { group: 'more', name: 'More', options: [{ name: 'Opus', value: 'opus' }] },
          ],
        },
      ]);

      const models = await provider.getModels();

      expect(models.map((model) => model.id)).toEqual(['sonnet', 'opus']);
      expect(models[0].provider).toBe('acp');
    });

    it('should clear cached models when config options have no model selector', async () => {
      process.env.HYPERNEO_ACP_COMMAND = 'claude --acp';
      provider.setConfigOptions([
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          category: 'model',
          currentValue: 'sonnet',
          options: [{ name: 'Sonnet', value: 'sonnet' }],
        },
      ]);

      provider.setConfigOptions([]);
      const models = await provider.getModels();

      expect(models[0].id).toBe('acp-default');
    });

    it('should reject cached models when the command becomes unavailable', async () => {
      process.env.HYPERNEO_ACP_COMMAND = 'claude --acp';
      provider.setCachedModels([
        {
          id: 'acp-cached',
          name: 'ACP Cached',
          family: 'acp',
          provider: 'acp',
          contextWindow: 100000,
          available: true,
        },
      ]);
      delete process.env.HYPERNEO_ACP_COMMAND;

      expect(await provider.getModels()).toEqual([]);
      expect(provider.getCachedModels()).toBeNull();
    });

    it('should return cached models when set', async () => {
      process.env.HYPERNEO_ACP_COMMAND = 'claude --acp';
      const cached = [
        {
          id: 'acp-cached',
          name: 'ACP Cached',
          family: 'acp',
          provider: 'acp',
          contextWindow: 100000,
          available: true,
        },
      ];
      provider.setCachedModels(cached);

      const models = await provider.getModels();

      expect(models).toHaveLength(1);
      expect(models[0].id).toBe('acp-cached');
    });

    it('should fall back to defaults after clearing cache', async () => {
      process.env.HYPERNEO_ACP_COMMAND = 'claude --acp';
      provider.setCachedModels([
        {
          id: 'cached',
          name: 'Cached',
          family: 'acp',
          provider: 'acp',
          contextWindow: 100000,
          available: true,
        },
      ]);
      provider.clearModelCache();

      const models = await provider.getModels();

      expect(models[0].id).toBe('acp-default');
    });

    it('probes the agent binary before returning default models', async () => {
      process.env.HYPERNEO_ACP_COMMAND = 'claude --acp';
      let calls = 0;
      const probe = async (): Promise<void> => {
        calls++;
      };
      const probed = new AcpProvider(process.env, probe);

      await probed.getModels();

      expect(calls).toBe(1);
    });

    it('throws when the agent binary is not found', async () => {
      process.env.HYPERNEO_ACP_COMMAND = 'missing-binary';
      const probe = async (): Promise<void> => {
        throw new Error("ACP command 'missing-binary' not found in PATH");
      };
      const probed = new AcpProvider(process.env, probe);

      expect(probed.getModels()).rejects.toThrow("ACP command 'missing-binary' not found in PATH");
    });

    it('caches successful probe so repeated calls do not re-spawn', async () => {
      process.env.HYPERNEO_ACP_COMMAND = 'claude --acp';
      let calls = 0;
      const probe = async (): Promise<void> => {
        calls++;
      };
      const probed = new AcpProvider(process.env, probe);

      await probed.getModels();
      await probed.getModels();

      expect(calls).toBe(1);
    });
  });

  describe('ownsModel', () => {
    it('should own acp model IDs', () => {
      expect(provider.ownsModel('acp')).toBe(true);
      expect(provider.ownsModel('acp-default')).toBe(true);
      expect(provider.ownsModel('acp-custom')).toBe(true);
      expect(provider.ownsModel('ACP-DEFAULT')).toBe(true);
    });

    it('should own cached dynamic model IDs', () => {
      provider.setConfigOptions([
        {
          id: 'model',
          name: 'Model',
          type: 'select',
          category: 'model',
          currentValue: 'sonnet',
          options: [{ name: 'Sonnet', value: 'sonnet' }],
        },
      ]);

      expect(provider.ownsModel('sonnet')).toBe(true);
    });

    it('should not own other provider models', () => {
      expect(provider.ownsModel('default')).toBe(false);
      expect(provider.ownsModel('glm-5')).toBe(false);
      expect(provider.ownsModel('claude-sonnet-4-5')).toBe(false);
      expect(provider.ownsModel('kimi-for-coding')).toBe(false);
    });
  });

  describe('getModelForTier', () => {
    it('should map all tiers to acp-default', () => {
      expect(provider.getModelForTier('haiku')).toBe('acp-default');
      expect(provider.getModelForTier('sonnet')).toBe('acp-default');
      expect(provider.getModelForTier('opus')).toBe('acp-default');
      expect(provider.getModelForTier('default')).toBe('acp-default');
    });
  });

  describe('buildSdkConfig', () => {
    it('should return empty env vars with isAnthropicCompatible false', () => {
      const config = provider.buildSdkConfig('acp-default');

      expect(config.envVars).toEqual({});
      expect(config.isAnthropicCompatible).toBe(false);
    });

    it('should ignore session config overrides', () => {
      const config = provider.buildSdkConfig('acp-default', {
        apiKey: 'test-key',
        baseUrl: 'https://example.com',
      });

      expect(config.envVars).toEqual({});
      expect(config.isAnthropicCompatible).toBe(false);
    });
  });

  describe('translateModelIdForSdk', () => {
    it('should translate any model to default', () => {
      expect(provider.translateModelIdForSdk('acp-default')).toBe('default');
      expect(provider.translateModelIdForSdk('acp-custom')).toBe('default');
    });
  });

  describe('getTitleGenerationModel', () => {
    it('should return acp-default', () => {
      expect(provider.getTitleGenerationModel()).toBe('acp-default');
    });
  });

  describe('getAuthStatus', () => {
    it('should return authenticated when command is set', async () => {
      process.env.HYPERNEO_ACP_COMMAND = 'claude --acp';
      const status = await provider.getAuthStatus();
      expect(status.isAuthenticated).toBe(true);
      expect(status.error).toBeUndefined();
    });

    it('should return not authenticated when no command', async () => {
      const status = await provider.getAuthStatus();
      expect(status.isAuthenticated).toBe(false);
      expect(status.error).toContain('HYPERNEO_ACP_COMMAND');
    });
  });

  describe('static models', () => {
    it('should have correct static model definitions', () => {
      expect(AcpProvider.MODELS).toHaveLength(1);
      expect(AcpProvider.MODELS[0].id).toBe('acp-default');
      expect(AcpProvider.MODELS[0].contextWindow).toBe(200000);
      expect(AcpProvider.MODELS[0].provider).toBe('acp');
    });
  });
});
