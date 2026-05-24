/**
 * SDK Config RPC Handlers
 *
 * Provides granular control over SDK configuration with:
 * - Runtime changes via native SDK methods when available
 * - Automatic query restart when required
 * - Validation before applying changes
 *
 * ARCHITECTURE: Follows the 3-layer communication pattern:
 * - RPC handlers do minimal work and return fast (<100ms for config reads)
 * - Heavy operations (restart) are explicit via restartQuery parameter
 * - State updates are broadcast via InternalEventBus<DaemonInternalEventMap> events
 */

import type { MessageHub, Session } from '@neokai/shared';
import type {
  GetModelSettingsRequest,
  UpdateModelSettingsRequest,
  GetSystemPromptRequest,
  UpdateSystemPromptRequest,
  GetToolsConfigRequest,
  UpdateToolsConfigRequest,
  GetAgentsConfigRequest,
  UpdateAgentsConfigRequest,
  GetSandboxConfigRequest,
  UpdateSandboxConfigRequest,
  GetMcpConfigRequest,
  UpdateMcpConfigRequest,
  AddMcpServerRequest,
  RemoveMcpServerRequest,
  GetOutputFormatRequest,
  UpdateOutputFormatRequest,
  GetBetasConfigRequest,
  UpdateBetasConfigRequest,
  GetEnvConfigRequest,
  UpdateEnvConfigRequest,
  GetPermissionsConfigRequest,
  UpdatePermissionsConfigRequest,
  GetAllConfigRequest,
  UpdateBulkConfigRequest,
} from '@neokai/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import { Logger } from '../logger';
import type { SessionManager } from '../session-manager';
import {
  validateSystemPromptConfig,
  validateToolsConfig,
  validateAgentsConfig,
  validateSandboxConfig,
  validateMcpServerConfig,
  validateMcpServersConfig,
  validateOutputFormat,
  validateBetasConfig,
  validateEnvConfig,
} from '../config-validators';

const log = new Logger('config-handlers');

/**
 * Setup SDK config RPC handlers
 */
export function setupConfigHandlers(
  messageHub: MessageHub,
  sessionManager: SessionManager,
  _internalEventBus: InternalEventBus<DaemonInternalEventMap>
): void {
  // ============================================================================
  // Model Settings
  // ============================================================================

  messageHub.onRequest('config.model.get', async (data) => {
    const { sessionId } = data as GetModelSettingsRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const config = agentSession.getSessionData().config;
    return {
      model: config.model,
      fallbackModel: config.fallbackModel,
      maxTurns: config.maxTurns,
      maxBudgetUsd: config.maxBudgetUsd,
      maxThinkingTokens: config.maxThinkingTokens,
    };
  });

  messageHub.onRequest('config.model.update', async (data) => {
    const { sessionId, settings } = data as UpdateModelSettingsRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const results = {
      applied: [] as string[],
      pending: [] as string[],
      errors: [] as Array<{ field: string; error: string }>,
    };

    // Handle model change (runtime native via existing handleModelSwitch)
    if (settings.model) {
      const provider = agentSession.getSessionData().config.provider;
      if (!provider) {
        // Session has no provider — cannot route the model switch.
        // This is a misconfigured session; surface the error rather than
        // silently falling back to 'anthropic' (which switchModel rejects anyway).
        log.warn('config.model.update: session has no provider configured — skipping model switch');
        results.errors.push({
          field: 'model',
          error: 'Session has no provider configured',
        });
      } else {
        const result = await agentSession.handleModelSwitch(settings.model, provider);
        if (result.success) {
          results.applied.push('model');
        } else {
          results.errors.push({
            field: 'model',
            error: result.error || 'Failed to switch model',
          });
        }
      }
    }

    // Handle maxThinkingTokens change (runtime native)
    if (settings.maxThinkingTokens !== undefined) {
      const result = await agentSession.setMaxThinkingTokens(settings.maxThinkingTokens);
      if (result.success) {
        results.applied.push('maxThinkingTokens');
      } else {
        results.errors.push({
          field: 'maxThinkingTokens',
          error: result.error || 'Failed to set thinking tokens',
        });
      }
    }

    // Handle other settings (persist only, applied on next query)
    const persistSettings: Partial<Session['config']> = {};
    if (settings.fallbackModel !== undefined) {
      persistSettings.fallbackModel = settings.fallbackModel;
      results.pending.push('fallbackModel');
    }
    if (settings.maxTurns !== undefined) {
      persistSettings.maxTurns = settings.maxTurns;
      results.pending.push('maxTurns');
    }
    if (settings.maxBudgetUsd !== undefined) {
      persistSettings.maxBudgetUsd = settings.maxBudgetUsd;
      results.pending.push('maxBudgetUsd');
    }

    if (Object.keys(persistSettings).length > 0) {
      await agentSession.updateConfig(persistSettings);
    }

    return results;
  });

  // ============================================================================
  // System Prompt
  // ============================================================================

  messageHub.onRequest('config.systemPrompt.get', async (data) => {
    const { sessionId } = data as GetSystemPromptRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    return {
      systemPrompt: agentSession.getSessionData().config.systemPrompt,
    };
  });

  messageHub.onRequest('config.systemPrompt.update', async (data) => {
    const { sessionId, systemPrompt, restartQuery } = data as UpdateSystemPromptRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    // Validate
    const validation = validateSystemPromptConfig(systemPrompt);
    if (!validation.valid) {
      return { success: false, applied: false, error: validation.error };
    }

    // Persist to database
    await agentSession.updateConfig({ systemPrompt });

    // Restart query if requested
    if (restartQuery) {
      const result = await agentSession.resetQuery({ restartQuery: true });
      if (!result.success) {
        return {
          success: false,
          applied: false,
          error: result.error,
          message: 'Config saved but restart failed',
        };
      }
      return { success: true, applied: true };
    }

    return {
      success: true,
      applied: false,
      message: 'Restart query to apply changes',
    };
  });

  // ============================================================================
  // Tools Configuration
  // ============================================================================

  messageHub.onRequest('config.tools.get', async (data) => {
    const { sessionId } = data as GetToolsConfigRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const config = agentSession.getSessionData().config;
    return {
      tools: config.sdkToolsPreset,
      allowedTools: config.allowedTools,
      disallowedTools: config.disallowedTools,
    };
  });

  messageHub.onRequest('config.tools.update', async (data) => {
    const { sessionId, settings, restartQuery } = data as UpdateToolsConfigRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    // Validate
    const validation = validateToolsConfig(settings);
    if (!validation.valid) {
      return { success: false, applied: false, error: validation.error };
    }

    // Persist - map tools to sdkToolsPreset
    const configUpdate: Partial<Session['config']> = {};
    if (settings.tools !== undefined) configUpdate.sdkToolsPreset = settings.tools;
    if (settings.allowedTools !== undefined) configUpdate.allowedTools = settings.allowedTools;
    if (settings.disallowedTools !== undefined)
      configUpdate.disallowedTools = settings.disallowedTools;

    await agentSession.updateConfig(configUpdate);

    // Restart query if requested
    if (restartQuery) {
      const result = await agentSession.resetQuery({ restartQuery: true });
      if (!result.success) {
        return {
          success: false,
          applied: false,
          error: result.error,
          message: 'Config saved but restart failed',
        };
      }
      return { success: true, applied: true };
    }

    return {
      success: true,
      applied: false,
      message: 'Restart query to apply changes',
    };
  });

  // ============================================================================
  // Agents/Subagents
  // ============================================================================

  messageHub.onRequest('config.agents.get', async (data) => {
    const { sessionId } = data as GetAgentsConfigRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    return {
      agents: agentSession.getSessionData().config.agents,
    };
  });

  messageHub.onRequest('config.agents.update', async (data) => {
    const { sessionId, agents, restartQuery } = data as UpdateAgentsConfigRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    // Validate
    const validation = validateAgentsConfig(agents);
    if (!validation.valid) {
      return { success: false, applied: false, error: validation.error };
    }

    // Persist
    await agentSession.updateConfig({ agents });

    // Restart query if requested
    if (restartQuery) {
      const result = await agentSession.resetQuery({ restartQuery: true });
      if (!result.success) {
        return {
          success: false,
          applied: false,
          error: result.error,
          message: 'Config saved but restart failed',
        };
      }
      return { success: true, applied: true };
    }

    return {
      success: true,
      applied: false,
      message: 'Restart query to apply changes',
    };
  });

  // ============================================================================
  // Sandbox
  // ============================================================================

  messageHub.onRequest('config.sandbox.get', async (data) => {
    const { sessionId } = data as GetSandboxConfigRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    return {
      sandbox: agentSession.getSessionData().config.sandbox,
    };
  });

  messageHub.onRequest('config.sandbox.update', async (data) => {
    const { sessionId, sandbox, restartQuery } = data as UpdateSandboxConfigRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    // Validate
    const validation = validateSandboxConfig(sandbox);
    if (!validation.valid) {
      return { success: false, applied: false, error: validation.error };
    }

    // Persist
    await agentSession.updateConfig({ sandbox });

    // Restart query if requested
    if (restartQuery) {
      const result = await agentSession.resetQuery({ restartQuery: true });
      if (!result.success) {
        return {
          success: false,
          applied: false,
          error: result.error,
          message: 'Config saved but restart failed',
        };
      }
      return { success: true, applied: true };
    }

    return {
      success: true,
      applied: false,
      message: 'Restart query to apply changes',
    };
  });

  // ============================================================================
  // MCP Servers
  // ============================================================================

  messageHub.onRequest('config.mcp.get', async (data) => {
    const { sessionId } = data as GetMcpConfigRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const config = agentSession.getSessionData().config;
    const runtimeStatus = await agentSession.getMcpServerStatus();

    return {
      mcpServers: config.mcpServers,
      strictMcpConfig: config.strictMcpConfig,
      runtimeStatus,
    };
  });

  messageHub.onRequest('config.mcp.update', async (data) => {
    const { sessionId, mcpServers, strictMcpConfig, restartQuery } = data as UpdateMcpConfigRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    // Validate
    if (mcpServers) {
      const validation = validateMcpServersConfig(mcpServers);
      if (!validation.valid) {
        return { success: false, applied: false, error: validation.error };
      }
    }

    // Persist user-managed MCP servers via the safe merge API that preserves
    // in-process runtime servers (node-agent, task-agent, space-agent-tools, db-query).
    // Other config fields (strictMcpConfig) go through updateConfig as before.
    if (mcpServers !== undefined) {
      await agentSession.updateUserMcpServers(mcpServers);
    }
    if (strictMcpConfig !== undefined) {
      await agentSession.updateConfig({ strictMcpConfig });
    }

    // Restart query if requested
    if (restartQuery) {
      const result = await agentSession.resetQuery({ restartQuery: true });
      if (!result.success) {
        return {
          success: false,
          applied: false,
          error: result.error,
          message: 'Config saved but restart failed',
        };
      }
      return { success: true, applied: true };
    }

    return {
      success: true,
      applied: false,
      message: 'Restart query to apply changes',
    };
  });

  messageHub.onRequest('config.mcp.addServer', async (data) => {
    const { sessionId, name, config, restartQuery } = data as AddMcpServerRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    // Validate
    const validation = validateMcpServerConfig(name, config);
    if (!validation.valid) {
      return { success: false, applied: false, error: validation.error };
    }

    // Merge with existing user-managed servers (subprocess/external only).
    // Reading only the persisted (non-SDK) subset via the current in-memory config;
    // updateUserMcpServers will preserve in-process servers on the way back in.
    const currentConfig = agentSession.getSessionData().config;
    const currentSubprocessServers = Object.fromEntries(
      Object.entries(currentConfig.mcpServers ?? {}).filter(
        ([, cfg]) => (cfg as { type?: string }).type !== 'sdk'
      )
    );
    const updatedServers = { ...currentSubprocessServers, [name]: config };

    // Persist via the safe merge API that preserves in-process runtime servers.
    await agentSession.updateUserMcpServers(updatedServers);

    // Restart if requested
    if (restartQuery) {
      const result = await agentSession.resetQuery({ restartQuery: true });
      if (!result.success) {
        return {
          success: false,
          applied: false,
          error: result.error,
          message: 'Config saved but restart failed',
        };
      }
      return { success: true, applied: true };
    }

    return {
      success: true,
      applied: false,
      message: 'Restart query to apply changes',
    };
  });

  messageHub.onRequest('config.mcp.removeServer', async (data) => {
    const { sessionId, name, restartQuery } = data as RemoveMcpServerRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    // Build updated subprocess-only server map without the removed entry.
    const currentConfig = agentSession.getSessionData().config;
    const allServers = currentConfig.mcpServers ?? {};

    // Reject attempts to remove in-process (SDK-type) runtime servers —
    // they are managed by the daemon, not user configuration.
    const targetServer = allServers[name] as { type?: string } | undefined;
    if (targetServer && targetServer.type === 'sdk') {
      throw new Error(
        `Cannot remove "${name}": it is a runtime-managed in-process server and cannot be removed via config`
      );
    }

    const currentSubprocessServers = Object.fromEntries(
      Object.entries(allServers).filter(([, cfg]) => (cfg as { type?: string }).type !== 'sdk')
    );
    delete currentSubprocessServers[name];

    // Persist via the safe merge API that preserves in-process runtime servers.
    await agentSession.updateUserMcpServers(currentSubprocessServers);

    // Restart if requested
    if (restartQuery) {
      const result = await agentSession.resetQuery({ restartQuery: true });
      if (!result.success) {
        return {
          success: false,
          applied: false,
          error: result.error,
          message: 'Config saved but restart failed',
        };
      }
      return { success: true, applied: true };
    }

    return {
      success: true,
      applied: false,
      message: 'Restart query to apply changes',
    };
  });

  // ============================================================================
  // Output Format
  // ============================================================================

  messageHub.onRequest('config.outputFormat.get', async (data) => {
    const { sessionId } = data as GetOutputFormatRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    return {
      outputFormat: agentSession.getSessionData().config.outputFormat,
    };
  });

  messageHub.onRequest('config.outputFormat.update', async (data) => {
    const { sessionId, outputFormat, restartQuery } = data as UpdateOutputFormatRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    // Validate if provided
    if (outputFormat) {
      const validation = validateOutputFormat(outputFormat);
      if (!validation.valid) {
        return { success: false, applied: false, error: validation.error };
      }
    }

    // Persist
    await agentSession.updateConfig({
      outputFormat: outputFormat || undefined,
    });

    // Restart query if requested
    if (restartQuery) {
      const result = await agentSession.resetQuery({ restartQuery: true });
      if (!result.success) {
        return {
          success: false,
          applied: false,
          error: result.error,
          message: 'Config saved but restart failed',
        };
      }
      return { success: true, applied: true };
    }

    return {
      success: true,
      applied: false,
      message: 'Restart query to apply changes',
    };
  });

  // ============================================================================
  // Beta Features
  // ============================================================================

  messageHub.onRequest('config.betas.get', async (data) => {
    const { sessionId } = data as GetBetasConfigRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    return {
      betas: agentSession.getSessionData().config.betas || [],
    };
  });

  messageHub.onRequest('config.betas.update', async (data) => {
    const { sessionId, betas, restartQuery } = data as UpdateBetasConfigRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    // Validate
    const validation = validateBetasConfig(betas);
    if (!validation.valid) {
      return { success: false, applied: false, error: validation.error };
    }

    // Persist
    await agentSession.updateConfig({ betas });

    // Restart query if requested
    if (restartQuery) {
      const result = await agentSession.resetQuery({ restartQuery: true });
      if (!result.success) {
        return {
          success: false,
          applied: false,
          error: result.error,
          message: 'Config saved but restart failed',
        };
      }
      return { success: true, applied: true };
    }

    return {
      success: true,
      applied: false,
      message: 'Restart query to apply changes',
    };
  });

  // ============================================================================
  // Environment Settings
  // ============================================================================

  messageHub.onRequest('config.env.get', async (data) => {
    const { sessionId } = data as GetEnvConfigRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const config = agentSession.getSessionData().config;
    return {
      cwd: config.cwd,
      additionalDirectories: config.additionalDirectories,
      env: config.env,
      executable: config.executable,
      executableArgs: config.executableArgs,
    };
  });

  messageHub.onRequest('config.env.update', async (data) => {
    const { sessionId, settings, restartQuery } = data as UpdateEnvConfigRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    // Validate
    const validation = validateEnvConfig(settings);
    if (!validation.valid) {
      return { success: false, applied: false, error: validation.error };
    }

    // Persist
    await agentSession.updateConfig(settings);

    // Restart query if requested
    if (restartQuery) {
      const result = await agentSession.resetQuery({ restartQuery: true });
      if (!result.success) {
        return {
          success: false,
          applied: false,
          error: result.error,
          message: 'Config saved but restart failed',
        };
      }
      return { success: true, applied: true };
    }

    return {
      success: true,
      applied: false,
      message: 'Restart query to apply changes',
    };
  });

  // ============================================================================
  // Permissions
  // ============================================================================

  messageHub.onRequest('config.permissions.get', async (data) => {
    const { sessionId } = data as GetPermissionsConfigRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const config = agentSession.getSessionData().config;
    return {
      permissionMode: config.permissionMode,
      allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions,
    };
  });

  messageHub.onRequest('config.permissions.update', async (data) => {
    const { sessionId, permissionMode } = data as UpdatePermissionsConfigRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    // Validate permission mode
    const validModes = ['default', 'bypassPermissions', 'acceptEdits', 'prompt'];
    if (!validModes.includes(permissionMode)) {
      return {
        success: false,
        applied: false,
        error: `Invalid permission mode: ${permissionMode}. Must be one of: ${validModes.join(', ')}`,
      };
    }

    // Use SDK's native setPermissionMode() if available
    const result = await agentSession.setPermissionMode(permissionMode);

    if (result.success) {
      return { success: true, applied: true };
    }

    return { success: false, applied: false, error: result.error };
  });

  // ============================================================================
  // Bulk Configuration
  // ============================================================================

  messageHub.onRequest('config.getAll', async (data) => {
    const { sessionId } = data as GetAllConfigRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    return {
      config: agentSession.getSessionData().config,
    };
  });

  messageHub.onRequest('config.updateBulk', async (data) => {
    const { sessionId, config, restartQuery } = data as UpdateBulkConfigRequest;
    const agentSession = await sessionManager.getSessionAsync(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const results = {
      applied: [] as string[],
      pending: [] as string[],
      errors: [] as Array<{ field: string; error: string }>,
    };

    // 1. Apply runtime-native changes first
    const runtimeConfig = { ...config };

    if (runtimeConfig.model) {
      const provider = agentSession.getSessionData().config.provider;
      if (!provider) {
        // Session has no provider — surface the error instead of silently
        // falling back (switchModel rejects missing provider internally anyway).
        log.warn('config.updateBulk: session has no provider configured — skipping model switch');
        results.errors.push({
          field: 'model',
          error: 'Session has no provider configured',
        });
      } else {
        const result = await agentSession.handleModelSwitch(runtimeConfig.model, provider);
        if (result.success) {
          results.applied.push('model');
        } else {
          results.errors.push({
            field: 'model',
            error: result.error || 'Failed',
          });
        }
      }
      delete runtimeConfig.model;
    }

    if (runtimeConfig.maxThinkingTokens !== undefined) {
      const result = await agentSession.setMaxThinkingTokens(runtimeConfig.maxThinkingTokens);
      if (result.success) {
        results.applied.push('maxThinkingTokens');
      } else {
        results.errors.push({
          field: 'maxThinkingTokens',
          error: result.error || 'Failed',
        });
      }
      delete runtimeConfig.maxThinkingTokens;
    }

    if (runtimeConfig.permissionMode) {
      const result = await agentSession.setPermissionMode(runtimeConfig.permissionMode);
      if (result.success) {
        results.applied.push('permissionMode');
      } else {
        results.errors.push({
          field: 'permissionMode',
          error: result.error || 'Failed',
        });
      }
      delete runtimeConfig.permissionMode;
    }

    // 2. Persist remaining config (restart-required)
    const remainingKeys = Object.keys(runtimeConfig);
    if (remainingKeys.length > 0) {
      // Map tools to sdkToolsPreset if present
      const configToUpdate = { ...runtimeConfig } as Partial<Session['config']>;
      if ('tools' in configToUpdate && configToUpdate.tools !== undefined) {
        (configToUpdate as Record<string, unknown>).sdkToolsPreset = configToUpdate.tools;
        delete (configToUpdate as Record<string, unknown>).tools;
      }

      await agentSession.updateConfig(configToUpdate as Partial<Session['config']>);

      if (restartQuery) {
        const result = await agentSession.resetQuery({ restartQuery: true });
        if (result.success) {
          results.applied.push(...remainingKeys);
        } else {
          results.errors.push({
            field: 'restart',
            error: result.error || 'Restart failed',
          });
          results.pending.push(...remainingKeys);
        }
      } else {
        results.pending.push(...remainingKeys);
      }
    }

    return results;
  });
}
