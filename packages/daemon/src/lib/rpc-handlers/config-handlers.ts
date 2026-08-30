import type {
  AddMcpServerRequest,
  GetAgentsConfigRequest,
  GetAllConfigRequest,
  GetBetasConfigRequest,
  GetEnvConfigRequest,
  GetMcpConfigRequest,
  GetModelSettingsRequest,
  GetOutputFormatRequest,
  GetPermissionsConfigRequest,
  GetSandboxConfigRequest,
  GetSystemPromptRequest,
  GetToolsConfigRequest,
  MessageHub,
  RemoveMcpServerRequest,
  Session,
  UpdateAgentsConfigRequest,
  UpdateBetasConfigRequest,
  UpdateBulkConfigRequest,
  UpdateEnvConfigRequest,
  UpdateMcpConfigRequest,
  UpdateModelSettingsRequest,
  UpdateOutputFormatRequest,
  UpdatePermissionsConfigRequest,
  UpdateSandboxConfigRequest,
  UpdateSystemPromptRequest,
  UpdateToolsConfigRequest,
} from '@hyperneo/shared';
import type { AgentSession } from '../agent/agent-session.ts';
import {
  validateAgentsConfig,
  validateBetasConfig,
  validateEnvConfig,
  validateMcpServerConfig,
  validateMcpServersConfig,
  validateOutputFormat,
  validateSandboxConfig,
  validateSystemPromptConfig,
  validateToolsConfig,
} from '../config-validators.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import { Logger } from '../logger.ts';
import {
  hasRuntimeNodeAgentServer,
  isWorkflowSubSessionIdentity,
} from '../session/sub-session-identity.ts';
import type { SessionManager } from '../session-manager.ts';

const log = new Logger('config-handlers');

async function restartQueryForConfig(
  sessionManager: SessionManager,
  sessionId: string,
  agentSession: AgentSession,
  configDelta: Partial<Session['config']>,
  applyUserMcpUpdate?: (session: AgentSession) => Promise<void>
): Promise<{ success: boolean; error?: string }> {
  if (agentSession.isQueryActiveOrStarting()) {
    return agentSession.resetQuery({ restartQuery: true });
  }
  const current = await sessionManager.getSessionAsync(sessionId);
  if (current && current !== agentSession) {
    if (applyUserMcpUpdate) await applyUserMcpUpdate(current);
    if (Object.keys(configDelta).length > 0) await current.updateConfig(configDelta);
  }
  if (!current) {
    return {
      success: false,
      error: `Session ${sessionId} is not resumable — workflow provisioning skipped`,
    };
  }
  const currentData = current.getSessionData();
  if (isWorkflowSubSessionIdentity(sessionId) && !hasRuntimeNodeAgentServer(currentData.config)) {
    return {
      success: false,
      error: `Session ${sessionId} is not resumable — workflow provisioning skipped`,
    };
  }
  if (current.isQueryActiveOrStarting()) return { success: true };
  return current.resetQuery({ restartQuery: true });
}

export function setupConfigHandlers(
  messageHub: MessageHub,
  sessionManager: SessionManager,
  _internalEventBus: InternalEventBus<DaemonInternalEventMap>
): void {
  messageHub.onRequest('config.model.get', async (data) => {
    const { sessionId } = data as GetModelSettingsRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
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
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const results = {
      applied: [] as string[],
      pending: [] as string[],
      errors: [] as Array<{ field: string; error: string }>,
    };

    if (settings.model) {
      const provider = agentSession.getSessionData().config.provider;
      if (!provider) {
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

  messageHub.onRequest('config.systemPrompt.get', async (data) => {
    const { sessionId } = data as GetSystemPromptRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    return {
      systemPrompt: agentSession.getSessionData().config.systemPrompt,
    };
  });

  messageHub.onRequest('config.systemPrompt.update', async (data) => {
    const { sessionId, systemPrompt, restartQuery } = data as UpdateSystemPromptRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const validation = validateSystemPromptConfig(systemPrompt);
    if (!validation.valid) {
      return { success: false, applied: false, error: validation.error };
    }

    const configUpdate = { systemPrompt };
    await agentSession.updateConfig(configUpdate);

    if (restartQuery) {
      const result = await restartQueryForConfig(
        sessionManager,
        sessionId,
        agentSession,
        configUpdate
      );
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

  messageHub.onRequest('config.tools.get', async (data) => {
    const { sessionId } = data as GetToolsConfigRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
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
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const validation = validateToolsConfig(settings);
    if (!validation.valid) {
      return { success: false, applied: false, error: validation.error };
    }

    const configUpdate: Partial<Session['config']> = {};
    if (settings.tools !== undefined) configUpdate.sdkToolsPreset = settings.tools;
    if (settings.allowedTools !== undefined) configUpdate.allowedTools = settings.allowedTools;
    if (settings.disallowedTools !== undefined)
      configUpdate.disallowedTools = settings.disallowedTools;

    await agentSession.updateConfig(configUpdate);

    if (restartQuery) {
      const result = await restartQueryForConfig(
        sessionManager,
        sessionId,
        agentSession,
        configUpdate
      );
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

  messageHub.onRequest('config.agents.get', async (data) => {
    const { sessionId } = data as GetAgentsConfigRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    return {
      agents: agentSession.getSessionData().config.agents,
    };
  });

  messageHub.onRequest('config.agents.update', async (data) => {
    const { sessionId, agents, restartQuery } = data as UpdateAgentsConfigRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const validation = validateAgentsConfig(agents);
    if (!validation.valid) {
      return { success: false, applied: false, error: validation.error };
    }

    const configUpdate = { agents };
    await agentSession.updateConfig(configUpdate);

    if (restartQuery) {
      const result = await restartQueryForConfig(
        sessionManager,
        sessionId,
        agentSession,
        configUpdate
      );
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

  messageHub.onRequest('config.sandbox.get', async (data) => {
    const { sessionId } = data as GetSandboxConfigRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    return {
      sandbox: agentSession.getSessionData().config.sandbox,
    };
  });

  messageHub.onRequest('config.sandbox.update', async (data) => {
    const { sessionId, sandbox, restartQuery } = data as UpdateSandboxConfigRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const validation = validateSandboxConfig(sandbox);
    if (!validation.valid) {
      return { success: false, applied: false, error: validation.error };
    }

    const configUpdate = { sandbox };
    await agentSession.updateConfig(configUpdate);

    if (restartQuery) {
      const result = await restartQueryForConfig(
        sessionManager,
        sessionId,
        agentSession,
        configUpdate
      );
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

  messageHub.onRequest('config.mcp.get', async (data) => {
    const { sessionId } = data as GetMcpConfigRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
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
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    if (mcpServers) {
      const validation = validateMcpServersConfig(mcpServers);
      if (!validation.valid) {
        return { success: false, applied: false, error: validation.error };
      }
    }

    if (mcpServers !== undefined) {
      await agentSession.updateUserMcpServers(mcpServers);
    }
    const configUpdate = strictMcpConfig === undefined ? {} : { strictMcpConfig };
    if (strictMcpConfig !== undefined) {
      await agentSession.updateConfig(configUpdate);
    }

    if (restartQuery) {
      const result = await restartQueryForConfig(
        sessionManager,
        sessionId,
        agentSession,
        configUpdate,
        mcpServers === undefined ? undefined : (current) => current.updateUserMcpServers(mcpServers)
      );
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
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const validation = validateMcpServerConfig(name, config);
    if (!validation.valid) {
      return { success: false, applied: false, error: validation.error };
    }

    const currentConfig = agentSession.getSessionData().config;
    const currentSubprocessServers = Object.fromEntries(
      Object.entries(currentConfig.mcpServers ?? {}).filter(
        ([, cfg]) => (cfg as { type?: string }).type !== 'sdk'
      )
    );
    const updatedServers = { ...currentSubprocessServers, [name]: config };

    await agentSession.updateUserMcpServers(updatedServers);

    if (restartQuery) {
      const result = await restartQueryForConfig(
        sessionManager,
        sessionId,
        agentSession,
        {},
        async (current) => {
          const currentServers = current.getSessionData().config.mcpServers ?? {};
          const subprocessServers = Object.fromEntries(
            Object.entries(currentServers).filter(
              ([, cfg]) => (cfg as { type?: string }).type !== 'sdk'
            )
          );
          await current.updateUserMcpServers({ ...subprocessServers, [name]: config });
        }
      );
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
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const currentConfig = agentSession.getSessionData().config;
    const allServers = currentConfig.mcpServers ?? {};

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

    await agentSession.updateUserMcpServers(currentSubprocessServers);

    if (restartQuery) {
      const result = await restartQueryForConfig(
        sessionManager,
        sessionId,
        agentSession,
        {},
        async (current) => {
          const currentServers = current.getSessionData().config.mcpServers ?? {};
          const subprocessServers = Object.fromEntries(
            Object.entries(currentServers).filter(
              ([, cfg]) => (cfg as { type?: string }).type !== 'sdk'
            )
          );
          delete subprocessServers[name];
          await current.updateUserMcpServers(subprocessServers);
        }
      );
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

  messageHub.onRequest('config.outputFormat.get', async (data) => {
    const { sessionId } = data as GetOutputFormatRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    return {
      outputFormat: agentSession.getSessionData().config.outputFormat,
    };
  });

  messageHub.onRequest('config.outputFormat.update', async (data) => {
    const { sessionId, outputFormat, restartQuery } = data as UpdateOutputFormatRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    if (outputFormat) {
      const validation = validateOutputFormat(outputFormat);
      if (!validation.valid) {
        return { success: false, applied: false, error: validation.error };
      }
    }

    const configUpdate = { outputFormat: outputFormat || undefined };
    await agentSession.updateConfig(configUpdate);

    if (restartQuery) {
      const result = await restartQueryForConfig(
        sessionManager,
        sessionId,
        agentSession,
        configUpdate
      );
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

  messageHub.onRequest('config.betas.get', async (data) => {
    const { sessionId } = data as GetBetasConfigRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    return {
      betas: agentSession.getSessionData().config.betas || [],
    };
  });

  messageHub.onRequest('config.betas.update', async (data) => {
    const { sessionId, betas, restartQuery } = data as UpdateBetasConfigRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const validation = validateBetasConfig(betas);
    if (!validation.valid) {
      return { success: false, applied: false, error: validation.error };
    }

    const configUpdate = { betas };
    await agentSession.updateConfig(configUpdate);

    if (restartQuery) {
      const result = await restartQueryForConfig(
        sessionManager,
        sessionId,
        agentSession,
        configUpdate
      );
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

  messageHub.onRequest('config.env.get', async (data) => {
    const { sessionId } = data as GetEnvConfigRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
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
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const validation = validateEnvConfig(settings);
    if (!validation.valid) {
      return { success: false, applied: false, error: validation.error };
    }

    await agentSession.updateConfig(settings);

    if (restartQuery) {
      const result = await restartQueryForConfig(sessionManager, sessionId, agentSession, settings);
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

  messageHub.onRequest('config.permissions.get', async (data) => {
    const { sessionId } = data as GetPermissionsConfigRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const config = agentSession.getSessionData().config;
    return {
      permissionMode: config.permissionMode,
      allowDangerouslySkipPermissions: config.allowDangerouslySkipPermissions,
    };
  });

  messageHub.onRequest('config.permissions.update', async (data) => {
    const { sessionId, permissionMode } = data as UpdatePermissionsConfigRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const validModes = ['default', 'bypassPermissions', 'acceptEdits', 'prompt'];
    if (!validModes.includes(permissionMode)) {
      return {
        success: false,
        applied: false,
        error: `Invalid permission mode: ${permissionMode}. Must be one of: ${validModes.join(', ')}`,
      };
    }

    const result = await agentSession.setPermissionMode(permissionMode);

    if (result.success) {
      return { success: true, applied: true };
    }

    return { success: false, applied: false, error: result.error };
  });

  messageHub.onRequest('config.getAll', async (data) => {
    const { sessionId } = data as GetAllConfigRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    return {
      config: agentSession.getSessionData().config,
    };
  });

  messageHub.onRequest('config.updateBulk', async (data) => {
    const { sessionId, config, restartQuery } = data as UpdateBulkConfigRequest;
    const agentSession = await sessionManager.getSessionForControl(sessionId);
    if (!agentSession) throw new Error('Session not found');

    const results = {
      applied: [] as string[],
      pending: [] as string[],
      errors: [] as Array<{ field: string; error: string }>,
    };

    const runtimeConfig = { ...config };

    if (runtimeConfig.model) {
      const provider = agentSession.getSessionData().config.provider;
      if (!provider) {
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

    const remainingKeys = Object.keys(runtimeConfig);
    if (remainingKeys.length > 0) {
      const configToUpdate = { ...runtimeConfig } as Partial<Session['config']>;
      if ('tools' in configToUpdate && configToUpdate.tools !== undefined) {
        (configToUpdate as Record<string, unknown>).sdkToolsPreset = configToUpdate.tools;
        delete (configToUpdate as Record<string, unknown>).tools;
      }

      await agentSession.updateConfig(configToUpdate as Partial<Session['config']>);

      if (restartQuery) {
        const result = await restartQueryForConfig(
          sessionManager,
          sessionId,
          agentSession,
          configToUpdate
        );
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
