import type { MessageHub } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { GlobalSettings, SessionSettings } from '@hyperneo/shared';
import type { SettingsManager } from '../settings-manager.ts';
import type { Database } from '../../storage/database.ts';
import type { McpImportService } from '../mcp/index.ts';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager.ts';
import { withVoiceCredentialLock } from './voice-credential-lock.ts';

export const VOICE_CREDENTIAL_PROVIDER_ID = 'voice-transcription';

export async function syncProviderModelAllowlists(
  allowlists?: Record<string, string[]>
): Promise<void> {
  applyProviderModelAllowlistsToEnv(allowlists);
  const { bumpProviderCatalogEpoch, clearModelsCache } = await import('../model-service.ts');
  for (const providerId of Object.keys(allowlists ?? {})) {
    bumpProviderCatalogEpoch(providerId);
  }
  clearModelsCache();
}

export function applyProviderModelAllowlistsToEnv(allowlists?: Record<string, string[]>): void {
  if (!allowlists || Object.keys(allowlists).length === 0) {
    delete process.env.HYPERNEO_PROVIDER_MODEL_ALLOWLISTS;
    return;
  }

  const entries = Object.entries(allowlists).flatMap(([provider, models]) =>
    models
      .map((model) => model.trim())
      .filter(Boolean)
      .map((model) => `${provider}:${model}`)
  );

  if (entries.length === 0) {
    delete process.env.HYPERNEO_PROVIDER_MODEL_ALLOWLISTS;
  } else {
    process.env.HYPERNEO_PROVIDER_MODEL_ALLOWLISTS = entries.join('\n');
  }
}

export function registerSettingsHandlers(
  messageHub: MessageHub,
  settingsManager: SettingsManager,
  internalEventBus: InternalEventBus<DaemonInternalEventMap>,
  db: Database,
  mcpImportService?: McpImportService,
  credentialManager?: ProviderCredentialManager
) {
  messageHub.onRequest('settings.global.get', async () => {
    return sanitizeGlobalSettings(settingsManager.getGlobalSettings(), credentialManager);
  });

  messageHub.onRequest(
    'settings.global.update',
    async (data: { updates: Partial<GlobalSettings> }) => {
      const touchesCustomEndpoints = data.updates.customEndpoints !== undefined;
      const run = async () => {
        if (touchesCustomEndpoints) {
          const { validateCustomEndpoints } = await import('./custom-endpoint-handlers.js');
          validateCustomEndpoints(data.updates.customEndpoints);
        }
        const voiceMutation: VoiceCredentialMutation = {};
        const updates = await prepareGlobalSettingsUpdate(
          data.updates,
          credentialManager,
          settingsManager,
          voiceMutation
        );
        const runVoiceMutation = async () => {
          const priorSettings = settingsManager.getGlobalSettings();
          const needsCredentialSnapshot = credentialManager
            ? Boolean(voiceMutation.storeKey || voiceMutation.remove)
            : false;
          const priorCredential = needsCredentialSnapshot
            ? await credentialManager!.getCredentials(VOICE_CREDENTIAL_PROVIDER_ID)
            : null;
          const result = settingsManager.updateGlobalSettings(updates);
          try {
            await applyVoiceCredentialMutation(voiceMutation, credentialManager);
          } catch (error) {
            settingsManager.saveGlobalSettings(priorSettings);
            await restorePriorVoiceCredential(priorCredential, credentialManager);
            throw error;
          }
          return result;
        };
        const updated =
          voiceMutation.storeKey || voiceMutation.remove
            ? await withVoiceCredentialLock(runVoiceMutation)
            : await runVoiceMutation();
        if (data.updates.providerModelAllowlists !== undefined) {
          await syncProviderModelAllowlists(data.updates.providerModelAllowlists);
        }
        if (touchesCustomEndpoints) {
          const { filterDisabledCustomEndpoints, syncCustomEndpointsToProviderTable } =
            await import('./custom-endpoint-handlers.js');
          syncCustomEndpointsToProviderTable(db, data.updates.customEndpoints ?? []);
          const endpointsToSync = filterDisabledCustomEndpoints(
            data.updates.customEndpoints ?? [],
            db
          );
          const { syncCustomEndpointProviders } = await import('../providers/factory.js');
          await syncCustomEndpointProviders(endpointsToSync);
          const { clearModelsCache } = await import('../model-service.ts');
          clearModelsCache();
        }
        internalEventBus.publishAsync('settings.updated', {
          namespaceId: 'global',
          settings: sanitizeGlobalSettings(updated, credentialManager),
        });
        if (touchesCustomEndpoints || data.updates.providerModelAllowlists !== undefined) {
          internalEventBus.publishAsync('providers.changed', { sessionId: 'global' });
        }

        return { success: true, settings: sanitizeGlobalSettings(updated, credentialManager) };
      };
      const { withCustomEndpointsLock } = await import('./custom-endpoint-handlers.js');
      return withCustomEndpointsLock(run);
    }
  );

  messageHub.onRequest('settings.global.save', async (data: { settings: GlobalSettings }) => {
    const customEndpointsProvided = Object.prototype.hasOwnProperty.call(
      data.settings,
      'customEndpoints'
    );
    const run = async () => {
      if (customEndpointsProvided) {
        const { validateCustomEndpoints } = await import('./custom-endpoint-handlers.js');
        validateCustomEndpoints(data.settings.customEndpoints);
      }
      const voiceMutation: VoiceCredentialMutation = {};
      const preparedSettings = (await prepareGlobalSettingsUpdate(
        data.settings,
        credentialManager,
        settingsManager,
        voiceMutation
      )) as GlobalSettings;
      const runVoiceSave = async () => {
        const priorSettings = settingsManager.getGlobalSettings();
        const needsCredentialSnapshot = credentialManager
          ? Boolean(voiceMutation.storeKey || voiceMutation.remove)
          : false;
        const priorCredential = needsCredentialSnapshot
          ? await credentialManager!.getCredentials(VOICE_CREDENTIAL_PROVIDER_ID)
          : null;
        const voiceProvided = Object.prototype.hasOwnProperty.call(data.settings, 'voice');
        const settingsToPersist: GlobalSettings = {
          ...preparedSettings,
          ...(customEndpointsProvided ? {} : { customEndpoints: priorSettings.customEndpoints }),
          ...(voiceProvided ? {} : { voice: priorSettings.voice }),
        };
        settingsManager.saveGlobalSettings(settingsToPersist);
        try {
          await applyVoiceCredentialMutation(voiceMutation, credentialManager);
        } catch (error) {
          settingsManager.saveGlobalSettings(priorSettings);
          await restorePriorVoiceCredential(priorCredential, credentialManager);
          throw error;
        }
      };
      if (voiceMutation.storeKey || voiceMutation.remove) {
        await withVoiceCredentialLock(runVoiceSave);
      } else {
        await runVoiceSave();
      }
      if (data.settings.providerModelAllowlists !== undefined) {
        await syncProviderModelAllowlists(data.settings.providerModelAllowlists);
      }
      if (customEndpointsProvided) {
        const { filterDisabledCustomEndpoints, syncCustomEndpointsToProviderTable } = await import(
          './custom-endpoint-handlers.js'
        );
        syncCustomEndpointsToProviderTable(db, data.settings.customEndpoints ?? []);
        const endpointsToSync = filterDisabledCustomEndpoints(
          data.settings.customEndpoints ?? [],
          db
        );
        const { syncCustomEndpointProviders } = await import('../providers/factory.js');
        await syncCustomEndpointProviders(endpointsToSync);
        const { clearModelsCache } = await import('../model-service.ts');
        clearModelsCache();
      }
      internalEventBus.publishAsync('settings.updated', {
        namespaceId: 'global',
        settings: sanitizeGlobalSettings(settingsManager.getGlobalSettings(), credentialManager),
      });
      if (customEndpointsProvided || data.settings.providerModelAllowlists !== undefined) {
        internalEventBus.publishAsync('providers.changed', { sessionId: 'global' });
      }
      return { success: true };
    };
    const { withCustomEndpointsLock } = await import('./custom-endpoint-handlers.js');
    return withCustomEndpointsLock(run);
  });

  messageHub.onRequest('settings.fileOnly.read', async () => {
    return settingsManager.readFileOnlySettings();
  });

  messageHub.onRequest('settings.mcp.listFromSources', async (data?: { sessionId?: string }) => {
    let effectiveSettings = settingsManager;

    if (data?.sessionId) {
      const session = db.getSession(data.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${data.sessionId}`);
      }

      const workspacePath = session.worktree?.worktreePath ?? session.workspacePath ?? undefined;
      effectiveSettings = new (await import('../settings-manager.ts')).SettingsManager(
        db,
        workspacePath
      );
    }

    return {
      servers: effectiveSettings.listMcpServersFromSources(),
    };
  });

  messageHub.onRequest('settings.mcp.refreshImports', async () => {
    if (!mcpImportService) {
      return { results: [] };
    }
    const workspacePaths = db.workspaceHistory.list(100).map((row) => row.path);
    const { results, orphanPruned } = mcpImportService.refreshAll(workspacePaths);
    internalEventBus.publishAsync('settings.updated', {
      namespaceId: 'global',
      settings: sanitizeGlobalSettings(settingsManager.getGlobalSettings(), credentialManager),
    });
    const changedRows =
      results.reduce((sum, r) => sum + r.added + r.updated + r.removed, 0) + orphanPruned;
    if (changedRows > 0) {
      internalEventBus.publishAsync('mcp.registry.changed', { sessionId: 'global' });
    }
    return { results };
  });

  messageHub.onRequest('settings.session.get', async (data: { sessionId: string }) => {
    return {
      sessionId: data.sessionId,
      settings: {},
    };
  });

  messageHub.onRequest(
    'settings.session.update',
    async (data: { sessionId: string; updates: Partial<SessionSettings> }) => {
      return { success: true, sessionId: data.sessionId };
    }
  );

  messageHub.onRequest('usage.calculate', async () => {
    const database = db.getDatabase();

    const totals = database
      .prepare(
        `SELECT
					COALESCE(SUM(json_extract(metadata, '$.totalCost')), 0) as totalCost,
					COALESCE(SUM(json_extract(metadata, '$.totalTokens')), 0) as totalTokens,
					COALESCE(SUM(json_extract(metadata, '$.messageCount')), 0) as totalMessages,
				COUNT(*) as sessionCount
				FROM sessions
				WHERE type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
					  AND room_id IS NULL
					  AND space_id IS NULL`
      )
      .get() as {
      totalCost: number;
      totalTokens: number;
      totalMessages: number;
      sessionCount: number;
    };

    const topSessions = database
      .prepare(
        `SELECT
					id,
					title,
					json_extract(metadata, '$.totalCost') as cost,
					json_extract(metadata, '$.totalTokens') as tokens,
					json_extract(metadata, '$.messageCount') as messages
				FROM sessions
				WHERE type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
				  AND room_id IS NULL
				  AND space_id IS NULL
				  AND json_extract(metadata, '$.totalCost') > 0
				ORDER BY cost DESC
				LIMIT 10`
      )
      .all() as Array<{
      id: string;
      title: string;
      cost: number;
      tokens: number;
      messages: number;
    }>;

    const dailyCosts = database
      .prepare(
        `SELECT
					date(created_at) as date,
					COALESCE(SUM(json_extract(metadata, '$.totalCost')), 0) as cost
				FROM sessions
				WHERE type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
				  AND room_id IS NULL
				  AND space_id IS NULL
				  AND created_at >= date('now', '-14 days')
				GROUP BY date(created_at)
				ORDER BY date ASC`
      )
      .all() as Array<{ date: string; cost: number }>;

    return {
      totalCost: totals.totalCost,
      totalTokens: totals.totalTokens,
      totalMessages: totals.totalMessages,
      sessionCount: totals.sessionCount,
      topSessions,
      dailyCosts,
    };
  });
}

interface VoiceCredentialMutation {
  storeKey?: string;
  remove?: boolean;
}

async function applyVoiceCredentialMutation(
  mutation: VoiceCredentialMutation,
  credentialManager?: ProviderCredentialManager
): Promise<void> {
  if (!credentialManager) return;
  if (mutation.storeKey) {
    await credentialManager.storeApiKey(VOICE_CREDENTIAL_PROVIDER_ID, mutation.storeKey);
  } else if (mutation.remove) {
    await credentialManager.removeCredentials(VOICE_CREDENTIAL_PROVIDER_ID);
  }
}

async function restorePriorVoiceCredential(
  prior: { type: string; apiKey?: string } | null | undefined,
  credentialManager?: ProviderCredentialManager
): Promise<void> {
  if (!credentialManager) return;
  try {
    if (prior?.type === 'api_key' && prior.apiKey) {
      await credentialManager.storeApiKey(VOICE_CREDENTIAL_PROVIDER_ID, prior.apiKey);
    } else {
      await credentialManager.removeCredentials(VOICE_CREDENTIAL_PROVIDER_ID);
    }
  } catch {}
}

async function prepareGlobalSettingsUpdate(
  updates: Partial<GlobalSettings>,
  credentialManager: ProviderCredentialManager | undefined,
  settingsManager: SettingsManager,
  mutation: VoiceCredentialMutation
): Promise<Partial<GlobalSettings>> {
  if (!updates.voice) return updates;
  const voice = { ...updates.voice };
  const newApiKey = voice.apiKey?.trim();
  const clearRequested = voice.hasApiKey === false;
  delete voice.apiKey;
  delete voice.apiKeyEndpoint;
  delete voice.hasApiKey;

  const persistedVoice = settingsManager.getGlobalSettings().voice;

  if (newApiKey) {
    if (!credentialManager) throw new Error('Credential store is not available');
    if (!voice.endpoint?.trim()) {
      throw new Error('Configure the voice transcription endpoint before saving an API key');
    }
    try {
      const keyEndpoint = new URL(voice.endpoint);
      if (keyEndpoint.protocol !== 'https:') {
        throw new Error('_protocol');
      }
    } catch (error) {
      throw new Error(
        error instanceof Error && error.message === '_protocol'
          ? 'Voice transcription API keys require an HTTPS endpoint'
          : 'Voice transcription endpoint must be a valid URL before saving an API key'
      );
    }
    voice.hasApiKey = true;
    voice.apiKeyEndpoint = normalizeEndpoint(voice.endpoint);
    mutation.storeKey = newApiKey;
  } else if (clearRequested && persistedVoice?.hasApiKey === true) {
    mutation.remove = true;
  } else if (persistedVoice?.apiKey?.trim()) {
    voice.hasApiKey = true;
    voice.apiKeyEndpoint = normalizeEndpoint(persistedVoice.endpoint ?? '');
    mutation.storeKey = persistedVoice.apiKey.trim();
  } else if (persistedVoice) {
    voice.hasApiKey = persistedVoice.hasApiKey;
    voice.apiKeyEndpoint = persistedVoice.apiKeyEndpoint;
  }

  return { ...updates, voice };
}

function normalizeEndpoint(endpoint: string): string {
  try {
    return new URL(endpoint).toString();
  } catch {
    return endpoint;
  }
}

export function sanitizeGlobalSettings(
  settings: GlobalSettings,
  credentialManager?: ProviderCredentialManager
): GlobalSettings {
  if (!settings.voice) return settings;
  const voice = { ...settings.voice };
  const hadInlineApiKey = !!voice.apiKey?.trim();
  delete voice.apiKey;
  if (hadInlineApiKey || credentialManager) voice.hasApiKey = voice.hasApiKey ?? hadInlineApiKey;
  return { ...settings, voice };
}
