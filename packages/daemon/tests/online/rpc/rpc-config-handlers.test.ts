import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createDaemonServer, type DaemonServerContext } from '../../helpers/daemon-server';

describe('SDK Config RPC Handlers', () => {
  let daemon: DaemonServerContext;

  beforeEach(async () => {
    daemon = await createDaemonServer();
  }, 30_000);

  afterEach(async () => {
    if (!daemon) return;
    await daemon.waitForExit();
  }, 15_000);

  async function createSession(workspacePath: string): Promise<string> {
    const { sessionId } = (await daemon.messageHub.request('session.create', {
      workspacePath,
    })) as { sessionId: string };
    daemon.trackSession(sessionId);
    return sessionId;
  }

  describe('config.model.get', () => {
    test('should return error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('config.model.get', { sessionId: 'non-existent' })
      ).rejects.toThrow();
    });

    test('should return model settings for existing session', async () => {
      const sessionId = await createSession('/test/config-model');

      const result = (await daemon.messageHub.request('config.model.get', {
        sessionId,
      })) as Record<string, unknown>;

      expect(result).toHaveProperty('model');
    });
  });

  describe('config.model.update', () => {
    test('should update model settings', async () => {
      const sessionId = await createSession('/test/config-model-update');

      const result = (await daemon.messageHub.request('config.model.update', {
        sessionId,
        settings: { model: 'claude-haiku-4-20250514', maxTurns: 50 },
      })) as { applied?: string[] };

      expect(result).toHaveProperty('applied');
    });

    test('should return error for invalid model', async () => {
      const sessionId = await createSession('/test/config-model-invalid');

      const result = (await daemon.messageHub.request('config.model.update', {
        sessionId,
        settings: { model: 'invalid-model-id' },
      })) as { errors?: Array<{ field: string; error: string }> };

      expect(result.errors?.length).toBeGreaterThan(0);
    });
  });

  describe('config.systemPrompt.get', () => {
    test('should return system prompt for session', async () => {
      const sessionId = await createSession('/test/config-prompt');

      const result = await daemon.messageHub.request('config.systemPrompt.get', { sessionId });
      expect(result).toBeDefined();
    });
  });

  describe('config.systemPrompt.update', () => {
    test('should update system prompt with string', async () => {
      const sessionId = await createSession('/test/config-prompt-update');

      const result = (await daemon.messageHub.request('config.systemPrompt.update', {
        sessionId,
        systemPrompt: 'You are a helpful coding assistant',
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });

    test('should update system prompt with preset', async () => {
      const sessionId = await createSession('/test/config-prompt-preset');

      const result = (await daemon.messageHub.request('config.systemPrompt.update', {
        sessionId,
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: 'Additional instructions here',
        },
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });

    test('should reject invalid system prompt preset', async () => {
      const sessionId = await createSession('/test/config-prompt-invalid');

      const result = (await daemon.messageHub.request('config.systemPrompt.update', {
        sessionId,
        systemPrompt: { type: 'preset', preset: 'invalid_preset' },
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('config.tools.get', () => {
    test('should return tools config for session', async () => {
      const sessionId = await createSession('/test/config-tools');

      const result = await daemon.messageHub.request('config.tools.get', { sessionId });
      expect(result).toBeDefined();
    });
  });

  describe('config.tools.update', () => {
    test('should update allowed tools', async () => {
      const sessionId = await createSession('/test/config-tools-update');

      const result = (await daemon.messageHub.request('config.tools.update', {
        sessionId,
        settings: { allowedTools: ['Bash', 'Read', 'Write'], disallowedTools: ['Edit'] },
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });

    test('should reject invalid tools array', async () => {
      const sessionId = await createSession('/test/config-tools-invalid');

      const result = (await daemon.messageHub.request('config.tools.update', {
        sessionId,
        settings: { allowedTools: 'Bash' },
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('config.permissions.get', () => {
    test('should return permissions config for session', async () => {
      const sessionId = await createSession('/test/config-permissions');

      const result = await daemon.messageHub.request('config.permissions.get', { sessionId });
      expect(result).toBeDefined();
    });
  });

  describe('config.permissions.update', () => {
    test('should update permission mode', async () => {
      const sessionId = await createSession('/test/config-permissions-update');

      const result = (await daemon.messageHub.request('config.permissions.update', {
        sessionId,
        permissionMode: 'acceptEdits',
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });

    test('should reject invalid permission mode', async () => {
      const sessionId = await createSession('/test/config-permissions-invalid');

      const result = (await daemon.messageHub.request('config.permissions.update', {
        sessionId,
        permissionMode: 'invalidMode',
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('config.getAll', () => {
    test('should return full config for session', async () => {
      const sessionId = await createSession('/test/config-get-all');

      const result = (await daemon.messageHub.request('config.getAll', { sessionId })) as {
        config: { model: string };
      };

      expect(result).toHaveProperty('config');
      expect(result.config).toHaveProperty('model');
    });
  });

  describe('config.updateBulk', () => {
    test('should update multiple settings at once', async () => {
      const sessionId = await createSession('/test/config-bulk-update');

      const result = (await daemon.messageHub.request('config.updateBulk', {
        sessionId,
        config: {
          model: 'claude-haiku-4-20250514',
          maxTurns: 25,
          allowedTools: ['Read', 'Grep'],
          permissionMode: 'acceptEdits',
        },
      })) as { applied?: string[] };

      expect(result).toHaveProperty('applied');
    });

    test('should handle partial updates with errors', async () => {
      const sessionId = await createSession('/test/config-bulk-partial');

      const result = (await daemon.messageHub.request('config.updateBulk', {
        sessionId,
        config: { model: 'invalid-model-id' },
      })) as { errors?: Array<{ field: string; error: string }> };

      expect(result.errors?.length).toBeGreaterThan(0);
    });
  });

  describe('config.agents.get/update', () => {
    test('should get agents config', async () => {
      const sessionId = await createSession('/test/config-agents-get');

      const result = await daemon.messageHub.request('config.agents.get', { sessionId });
      expect(result).toBeDefined();
    });

    test('should update agents config', async () => {
      const sessionId = await createSession('/test/config-agents-update');

      const result = (await daemon.messageHub.request('config.agents.update', {
        sessionId,
        agents: {
          explorer: {
            description: 'Explores the codebase',
            prompt: 'You are a code explorer',
            model: 'haiku',
          },
        },
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });

    test('should reject invalid agent definition', async () => {
      const sessionId = await createSession('/test/config-agents-invalid');

      const result = (await daemon.messageHub.request('config.agents.update', {
        sessionId,
        agents: {
          explorer: {
            description: '',
            prompt: 'You are a code explorer',
          },
        },
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('config.sandbox.get/update', () => {
    test('should get sandbox config', async () => {
      const sessionId = await createSession('/test/config-sandbox-get');

      const result = await daemon.messageHub.request('config.sandbox.get', { sessionId });
      expect(result).toBeDefined();
    });

    test('should update sandbox config', async () => {
      const sessionId = await createSession('/test/config-sandbox-update');

      const result = (await daemon.messageHub.request('config.sandbox.update', {
        sessionId,
        sandbox: {
          enabled: true,
          autoAllowBashIfSandboxed: true,
          excludedCommands: ['rm', 'sudo'],
        },
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });
  });

  describe('config.betas.get/update', () => {
    test('should get betas config', async () => {
      const sessionId = await createSession('/test/config-betas-get');

      const result = (await daemon.messageHub.request('config.betas.get', {
        sessionId,
      })) as { betas: unknown };

      expect(result).toHaveProperty('betas');
    });

    test('should update betas config', async () => {
      const sessionId = await createSession('/test/config-betas-update');

      const result = (await daemon.messageHub.request('config.betas.update', {
        sessionId,
        betas: ['context-1m-2025-08-07'],
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });

    test('should reject invalid beta feature', async () => {
      const sessionId = await createSession('/test/config-betas-invalid');

      const result = (await daemon.messageHub.request('config.betas.update', {
        sessionId,
        betas: ['invalid-beta-feature'],
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('config.outputFormat.get/update', () => {
    test('should get output format config', async () => {
      const sessionId = await createSession('/test/config-output-get');

      const result = await daemon.messageHub.request('config.outputFormat.get', { sessionId });
      expect(result).toBeDefined();
    });

    test('should update output format config', async () => {
      const sessionId = await createSession('/test/config-output-update');

      const result = (await daemon.messageHub.request('config.outputFormat.update', {
        sessionId,
        outputFormat: {
          type: 'json_schema',
          schema: { type: 'object', properties: { name: { type: 'string' } } },
        },
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });

    test('should clear output format with null', async () => {
      const sessionId = await createSession('/test/config-output-clear');

      const result = (await daemon.messageHub.request('config.outputFormat.update', {
        sessionId,
        outputFormat: null,
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });
  });

  describe('config.mcp.get', () => {
    test('should return MCP config for session', async () => {
      const sessionId = await createSession('/test/config-mcp-get');

      const result = (await daemon.messageHub.request('config.mcp.get', { sessionId })) as {
        runtimeStatus?: unknown[];
      };

      expect(result).toBeDefined();
      expect(result.runtimeStatus).toBeArray();
    });
  });

  describe('config.mcp.update', () => {
    test('should update MCP servers', async () => {
      const sessionId = await createSession('/test/config-mcp-update');

      const result = (await daemon.messageHub.request('config.mcp.update', {
        sessionId,
        mcpServers: { 'test-server': { command: 'test-command', args: [] } },
        strictMcpConfig: false,
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });

    test('should reject invalid MCP server config', async () => {
      const sessionId = await createSession('/test/config-mcp-invalid');

      const result = (await daemon.messageHub.request('config.mcp.update', {
        sessionId,
        mcpServers: { '': { command: 'test-command', args: [] } },
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('config.mcp.addServer', () => {
    test('should add MCP server', async () => {
      const sessionId = await createSession('/test/config-mcp-add');

      const result = (await daemon.messageHub.request('config.mcp.addServer', {
        sessionId,
        name: 'new-server',
        config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-test'] },
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });

    test('should reject adding invalid server', async () => {
      const sessionId = await createSession('/test/config-mcp-add-invalid');

      const result = (await daemon.messageHub.request('config.mcp.addServer', {
        sessionId,
        name: '',
        config: { command: 'test-command', args: [] },
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('config.mcp.removeServer', () => {
    test('should remove MCP server', async () => {
      const sessionId = await createSession('/test/config-mcp-remove');

      await daemon.messageHub.request('config.mcp.addServer', {
        sessionId,
        name: 'temp-server',
        config: { command: 'test', args: [] },
      });

      const result = (await daemon.messageHub.request('config.mcp.removeServer', {
        sessionId,
        name: 'temp-server',
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });
  });

  describe('config.env.get', () => {
    test('should return environment config for session', async () => {
      const sessionId = await createSession('/test/config-env-get');

      const result = await daemon.messageHub.request('config.env.get', { sessionId });
      expect(result).toBeDefined();
    });
  });

  describe('config.env.update', () => {
    test('should update environment settings', async () => {
      const sessionId = await createSession('/test/config-env-update');

      const result = (await daemon.messageHub.request('config.env.update', {
        sessionId,
        settings: {
          additionalDirectories: ['/extra/dir'],
          env: { MY_VAR: 'test-value' },
        },
      })) as { success: boolean };

      expect(result.success).toBe(true);
    });

    test('should reject invalid env settings', async () => {
      const sessionId = await createSession('/test/config-env-invalid');

      const result = (await daemon.messageHub.request('config.env.update', {
        sessionId,
        settings: { additionalDirectories: 'not-an-array' },
      })) as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('config.model.update with maxThinkingTokens', () => {
    test('should update maxThinkingTokens', async () => {
      const sessionId = await createSession('/test/config-thinking-tokens');

      const result = (await daemon.messageHub.request('config.model.update', {
        sessionId,
        settings: { maxThinkingTokens: 4096 },
      })) as { applied?: string[] };

      expect(result.applied).toContain('maxThinkingTokens');
    });
  });

  describe('config.model.update with fallback settings', () => {
    test('should update fallbackModel, maxTurns, maxBudgetUsd', async () => {
      const sessionId = await createSession('/test/config-model-fallback');

      const result = (await daemon.messageHub.request('config.model.update', {
        sessionId,
        settings: {
          fallbackModel: 'claude-haiku-4-20250514',
          maxTurns: 100,
          maxBudgetUsd: 10.0,
        },
      })) as { pending?: string[] };

      expect(result.pending).toContain('fallbackModel');
      expect(result.pending).toContain('maxTurns');
      expect(result.pending).toContain('maxBudgetUsd');
    });
  });

  describe('config.updateBulk with restartQuery', () => {
    test('should update config with restartQuery=false', async () => {
      const sessionId = await createSession('/test/config-bulk-no-restart');

      const result = (await daemon.messageHub.request('config.updateBulk', {
        sessionId,
        config: { systemPrompt: 'New system prompt' },
        restartQuery: false,
      })) as { pending?: string[] };

      expect(result.pending).toContain('systemPrompt');
    });

    test('should handle tools in bulk config (maps to sdkToolsPreset)', async () => {
      const sessionId = await createSession('/test/config-bulk-tools');

      const result = await daemon.messageHub.request('config.updateBulk', {
        sessionId,
        config: { tools: 'sdk' },
        restartQuery: false,
      });

      expect(result).toBeDefined();
    });
  });

  describe('Error handling for non-existent sessions', () => {
    test('config.env.get should error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('config.env.get', { sessionId: 'non-existent' })
      ).rejects.toThrow();
    });

    test('config.mcp.get should error for non-existent session', async () => {
      await expect(
        daemon.messageHub.request('config.mcp.get', { sessionId: 'non-existent' })
      ).rejects.toThrow();
    });
  });
});
