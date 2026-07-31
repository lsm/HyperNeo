/**
 * Settings RPC Handlers
 *
 * Provides RPC methods for managing global and session-specific settings.
 *
 * MIGRATION NOTE: `settings.updated` events are published through
 * `internalEventBus`. See docs/plans/internal-event-command-query-architecture.md.
 */

import type { MessageHub } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { GlobalSettings, SessionSettings } from '@hyperneo/shared';
import type { SettingsManager } from '../settings-manager';
import type { Database } from '../../storage/database';
import type { McpImportService } from '../mcp';
import type { ProviderCredentialManager } from '../credentials/provider-credential-manager';

const VOICE_CREDENTIAL_PROVIDER_ID = 'voice-transcription';

export async function syncProviderModelAllowlists(
  allowlists?: Record<string, string[]>
): Promise<void> {
  applyProviderModelAllowlistsToEnv(allowlists);
  const { clearModelsCache } = await import('../model-service');
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
  /**
   * Get global settings
   */
  messageHub.onRequest('settings.global.get', async () => {
    return sanitizeGlobalSettings(settingsManager.getGlobalSettings(), credentialManager);
  });

  /**
   * Update global settings (partial update)
   */
  messageHub.onRequest(
    'settings.global.update',
    async (data: { updates: Partial<GlobalSettings> }) => {
      const touchesCustomEndpoints = data.updates.customEndpoints !== undefined;
      // Always serialise through the customEndpoints lock. Even when the
      // update payload omits `customEndpoints`, `updateGlobalSettings`
      // performs a full read-merge-write of the settings row that includes
      // the customEndpoints field — without the lock a concurrent
      // `customEndpoints.add/update/remove` could persist a stale snapshot
      // and silently drop the other mutation.
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
        // Snapshot the prior voice block and credential so a failed credential
        // write can be fully rolled back (settings + stored key), keeping scope
        // and credential consistent.
        const priorVoice = settingsManager.getGlobalSettings().voice;
        // Only read the credential store when a voice-key mutation is actually
        // pending — getCredentials() can hit the (un-timed-out) macOS Keychain,
        // so we must not block every unrelated settings update on it.
        const needsCredentialSnapshot = credentialManager
          ? Boolean(voiceMutation.storeKey || voiceMutation.remove)
          : false;
        const priorCredential = needsCredentialSnapshot
          ? await credentialManager!.getCredentials(VOICE_CREDENTIAL_PROVIDER_ID).catch(() => null)
          : null;
        const updated = settingsManager.updateGlobalSettings(updates);
        try {
          await applyVoiceCredentialMutation(voiceMutation, credentialManager);
        } catch (error) {
          settingsManager.updateGlobalSettings({
            voice: priorVoice ?? { enabled: false, endpoint: '', model: '' },
          });
          await restorePriorVoiceCredential(priorCredential, credentialManager);
          throw error;
        }
        if (data.updates.providerModelAllowlists !== undefined) {
          await syncProviderModelAllowlists(data.updates.providerModelAllowlists);
        }
        if (touchesCustomEndpoints) {
          const { filterDisabledCustomEndpoints, syncCustomEndpointsToProviderTable } =
            await import('./custom-endpoint-handlers.js');
          // Update provider rows for ALL endpoints (including disabled) so
          // re-enablement picks up the latest config instead of a stale one.
          syncCustomEndpointsToProviderTable(db, data.updates.customEndpoints ?? []);
          const endpointsToSync = filterDisabledCustomEndpoints(
            data.updates.customEndpoints ?? [],
            db
          );
          const { syncCustomEndpointProviders } = await import('../providers/factory.js');
          await syncCustomEndpointProviders(endpointsToSync);
          // Stale model cache would still list removed custom models and
          // miss newly added ones until the TTL expires.
          const { clearModelsCache } = await import('../model-service');
          clearModelsCache();
        }
        // Emit event for StateManager to broadcast (global event)
        internalEventBus.publishAsync('settings.updated', {
          namespaceId: 'global',
          settings: sanitizeGlobalSettings(updated, credentialManager),
        });
        if (touchesCustomEndpoints || data.updates.providerModelAllowlists !== undefined) {
          internalEventBus.publishAsync('providers.changed', { sessionId: 'global' });
        }

        // Note: showArchived filter is now handled client-side via LiveQuery (sessions.list)

        return { success: true, settings: sanitizeGlobalSettings(updated, credentialManager) };
      };
      const { withCustomEndpointsLock } = await import('./custom-endpoint-handlers.js');
      return withCustomEndpointsLock(run);
    }
  );

  /**
   * Save global settings (full replace)
   */
  messageHub.onRequest('settings.global.save', async (data: { settings: GlobalSettings }) => {
    // `customEndpoints` is optional in GlobalSettings, so a legacy caller
    // that sends a partial payload would otherwise unregister every custom
    // endpoint at runtime (and overwrite persisted state) just by omitting
    // the field. Only touch the registry when the payload actually
    // declares the key, even if its value is `[]` (explicit clear).
    const customEndpointsProvided = Object.prototype.hasOwnProperty.call(
      data.settings,
      'customEndpoints'
    );
    const run = async () => {
      if (customEndpointsProvided) {
        const { validateCustomEndpoints } = await import('./custom-endpoint-handlers.js');
        validateCustomEndpoints(data.settings.customEndpoints);
      }
      // When the payload omits the field, merge the currently-persisted
      // list back into what we write to disk. Snapshot INSIDE the lock so
      // a concurrent customEndpoints.add/update/remove cannot land between
      // the snapshot and the saveGlobalSettings call — otherwise that
      // mutation would be overwritten by this stale copy.
      const voiceMutation: VoiceCredentialMutation = {};
      const preparedSettings = (await prepareGlobalSettingsUpdate(
        data.settings,
        credentialManager,
        settingsManager,
        voiceMutation
      )) as GlobalSettings;
      // Snapshot the prior persisted settings so omitted optional fields can be
      // merged back, and so a failed credential write can be rolled back to keep
      // endpoint scope and stored credential consistent. Snapshot INSIDE the
      // lock for the same ordering reason as customEndpoints above.
      const priorSettings = settingsManager.getGlobalSettings();
      // Only read the credential store when a voice-key mutation is pending, to
      // avoid blocking every full save on the (un-timed-out) macOS Keychain.
      const needsCredentialSnapshot = credentialManager
        ? Boolean(voiceMutation.storeKey || voiceMutation.remove)
        : false;
      const priorCredential = needsCredentialSnapshot
        ? await credentialManager!.getCredentials(VOICE_CREDENTIAL_PROVIDER_ID).catch(() => null)
        : null;
      const voiceProvided = Object.prototype.hasOwnProperty.call(data.settings, 'voice');
      // Preserve currently-persisted optional blocks (customEndpoints, voice)
      // when the payload omits them, mirroring the customEndpoints contract: a
      // legacy full save must not wipe voice settings (or orphan its credential).
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
      if (data.settings.providerModelAllowlists !== undefined) {
        await syncProviderModelAllowlists(data.settings.providerModelAllowlists);
      }
      if (customEndpointsProvided) {
        const { filterDisabledCustomEndpoints, syncCustomEndpointsToProviderTable } = await import(
          './custom-endpoint-handlers.js'
        );
        // Update provider rows for ALL endpoints (including disabled) so
        // re-enablement picks up the latest config instead of a stale one.
        syncCustomEndpointsToProviderTable(db, data.settings.customEndpoints ?? []);
        const endpointsToSync = filterDisabledCustomEndpoints(
          data.settings.customEndpoints ?? [],
          db
        );
        const { syncCustomEndpointProviders } = await import('../providers/factory.js');
        await syncCustomEndpointProviders(endpointsToSync);
        const { clearModelsCache } = await import('../model-service');
        clearModelsCache();
      }
      // Emit event for StateManager to broadcast (global event)
      internalEventBus.publishAsync('settings.updated', {
        namespaceId: 'global',
        settings: sanitizeGlobalSettings(settingsToPersist, credentialManager),
      });
      if (customEndpointsProvided || data.settings.providerModelAllowlists !== undefined) {
        internalEventBus.publishAsync('providers.changed', { sessionId: 'global' });
      }
      return { success: true };
    };
    // Always serialise through the customEndpoints lock — even when the
    // payload omits the field we read+merge the persisted list inside `run`,
    // and that read-modify-write must be ordered with concurrent CRUD RPCs.
    const { withCustomEndpointsLock } = await import('./custom-endpoint-handlers.js');
    return withCustomEndpointsLock(run);
  });

  /**
   * Read file-only settings from .claude/settings.local.json
   */
  messageHub.onRequest('settings.fileOnly.read', async () => {
    return settingsManager.readFileOnlySettings();
  });

  /**
   * List MCP servers from enabled setting sources
   *
   * IMPORTANT: Reads from session-specific workspace path for worktree isolation.
   * - If sessionId provided: Reads from session's workspace (worktree or shared)
   * - If sessionId omitted: Reads from global workspace root (for GlobalSettingsEditor)
   */
  messageHub.onRequest('settings.mcp.listFromSources', async (data?: { sessionId?: string }) => {
    let effectiveSettings = settingsManager; // Default: global workspace root

    // If sessionId provided, use session-specific workspace path
    if (data?.sessionId) {
      const session = db.getSession(data.sessionId);
      if (!session) {
        throw new Error(`Session not found: ${data.sessionId}`);
      }

      // Create session-specific SettingsManager with session's workspace path
      // This ensures we read .mcp.json and settings files from the correct location:
      // - Worktree sessions: .worktrees/{sessionId}/.mcp.json
      // - Non-worktree sessions: {workspaceRoot}/.mcp.json
      const workspacePath = session.worktree?.worktreePath ?? session.workspacePath ?? undefined;
      effectiveSettings = new (await import('../settings-manager')).SettingsManager(
        db,
        workspacePath
      );
    }

    return {
      servers: effectiveSettings.listMcpServersFromSources(),
    };
  });

  /**
   * Refresh `.mcp.json` imports.
   *
   * Rescans every known workspace's `.mcp.json` plus `~/.claude/.mcp.json`
   * and reconciles `source='imported'` rows in `app_mcp_servers`. Triggered
   * manually from the MCP Servers settings UI ("Refresh imports" button).
   *
   * Returns a per-file summary so the UI can surface which files were scanned,
   * which added/updated/removed rows, and which were malformed.
   *
   * Never throws — per-file parse errors are captured in the result.
   */
  messageHub.onRequest('settings.mcp.refreshImports', async () => {
    if (!mcpImportService) {
      // Should never happen in production wiring; guard for test-only callers
      // that construct handlers without the service (e.g. isolated unit tests).
      return { results: [] };
    }
    const workspacePaths = db.workspaceHistory.list(100).map((row) => row.path);
    const results = mcpImportService.refreshAll(workspacePaths);
    // Emit so LiveQuery subscribers (MCP Servers page) invalidate. The repo
    // already calls `reactiveDb.notifyChange('app_mcp_servers')` on every
    // insert/update/delete; this event is for UI-level toast/status messaging.
    internalEventBus.publishAsync('settings.updated', {
      namespaceId: 'global',
      settings: sanitizeGlobalSettings(settingsManager.getGlobalSettings(), credentialManager),
    });
    return { results };
  });

  /**
   * Get session settings (placeholder for future session-specific settings)
   *
   * Currently, session settings are stored in session.config, but this
   * handler provides a unified interface for future expansion.
   */
  messageHub.onRequest('settings.session.get', async (data: { sessionId: string }) => {
    // Future: retrieve session-specific settings
    // For now, return empty object
    return {
      sessionId: data.sessionId,
      settings: {},
    };
  });

  /**
   * Update session settings (placeholder for future session-specific settings)
   */
  messageHub.onRequest(
    'settings.session.update',
    async (data: { sessionId: string; updates: Partial<SessionSettings> }) => {
      // Future: update session-specific settings
      // For now, do nothing
      return { success: true, sessionId: data.sessionId };
    }
  );

  /**
   * Calculate usage analytics from all user sessions.
   *
   * Aggregates cost, tokens, and messages from the sessions table.
   * Filters out internal room/space/agent sessions server-side.
   * Called on-demand when the Usage Analytics settings tab is opened.
   */
  messageHub.onRequest('usage.calculate', async () => {
    const database = db.getDatabase();

    // Aggregate totals
    const totals = database
      .prepare(
        `SELECT
					COALESCE(SUM(json_extract(metadata, '$.totalCost')), 0) as totalCost,
					COALESCE(SUM(json_extract(metadata, '$.totalTokens')), 0) as totalTokens,
					COALESCE(SUM(json_extract(metadata, '$.messageCount')), 0) as totalMessages,
				COUNT(*) as sessionCount
				FROM sessions
				WHERE type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
					  AND json_extract(session_context, '$.roomId') IS NULL
					  AND json_extract(session_context, '$.spaceId') IS NULL`
      )
      .get() as {
      totalCost: number;
      totalTokens: number;
      totalMessages: number;
      sessionCount: number;
    };

    // Top 10 sessions by cost
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
				  AND json_extract(session_context, '$.roomId') IS NULL
				  AND json_extract(session_context, '$.spaceId') IS NULL
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

    // Daily costs for last 14 days
    const dailyCosts = database
      .prepare(
        `SELECT
					date(created_at) as date,
					COALESCE(SUM(json_extract(metadata, '$.totalCost')), 0) as cost
				FROM sessions
				WHERE type NOT IN ('lobby', 'spaces_global', 'room_chat', 'planner', 'coder', 'leader', 'space_chat', 'space_task_agent')
				  AND json_extract(session_context, '$.roomId') IS NULL
				  AND json_extract(session_context, '$.spaceId') IS NULL
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

// Best-effort restore of the prior credential after a partial write failure
// (storeApiKey writes the secret before updating the auth row, so a later
// SQLite error can leave a new key in the singleton slot). Never throws — the
// original mutation error is the one that propagates.
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
  } catch {
    // Store is broken; nothing more we can do — surface the original error.
  }
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
  // Credential scope/flags are server-owned: never trust client-supplied
  // hasApiKey/apiKeyEndpoint, which could otherwise redirect a stored key to an
  // attacker endpoint (forged scope).
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
      new URL(voice.endpoint);
    } catch {
      throw new Error('Voice transcription endpoint must be a valid URL before saving an API key');
    }
    voice.hasApiKey = true;
    voice.apiKeyEndpoint = normalizeEndpoint(voice.endpoint);
    // Defer the credential write until after the settings row is persisted, so
    // a failed settings write cannot leave a new key bound to a stale scope.
    mutation.storeKey = newApiKey;
  } else if (clearRequested) {
    mutation.remove = true;
  } else if (persistedVoice?.apiKey?.trim()) {
    // Migrate a legacy inline key into the credential store so a save does not
    // silently drop the only credential.
    voice.hasApiKey = true;
    voice.apiKeyEndpoint = normalizeEndpoint(persistedVoice.endpoint ?? '');
    mutation.storeKey = persistedVoice.apiKey.trim();
  } else if (persistedVoice) {
    // Preserve the server-owned scope; resolveApiKey only sends the stored key
    // when the current endpoint matches this saved scope.
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
