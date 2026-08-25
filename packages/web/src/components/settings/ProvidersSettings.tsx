import { useEffect, useRef, useState } from 'preact/hooks';
import { useSignalEffect } from '@preact/signals';
import type { ProviderRecord, CredentialStoreStatus } from '@hyperneo/shared';
import type { ProviderAuthStatus, CuratedModel } from '@hyperneo/shared/provider';
import {
  listProviders,
  deleteProvider,
  updateProvider,
  setDefaultProvider,
  testProvider,
  listProviderAuthStatus,
  loginProvider,
  logoutProvider,
  refreshProvider,
  listProviderRemoteModels,
} from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import { connectionManager } from '../../lib/connection-manager.ts';
import { ConnectionNotReadyError, ConnectionTimeoutError } from '../../lib/errors.ts';
import { connectionState, credentialStoreStatus } from '../../lib/state.ts';
import { SettingsSection } from './SettingsSection.tsx';
import { Button } from '../ui/Button.tsx';
import { AddProviderModal } from './AddProviderModal.tsx';
import { OAuthModal, type OAuthFlowState } from './OAuthModal.tsx';
import {
  EditorModal,
  existingToEditor,
  editorToConfig,
  validateEditor,
  testCustomEndpoint,
  type EditorState,
} from './CustomEndpointEditor.tsx';
import { useFetchModels } from './useFetchModels.ts';
import { AcpEditorModal, type AcpConfiguredModel } from './AcpEditorModal.tsx';

interface EnrichedProvider extends ProviderRecord {
  available: boolean;
  authStatus?: ProviderAuthStatus;
}

function readKimiRegion(provider: EnrichedProvider): 'china' | 'global' {
  if (!provider.configJson) return 'china';
  try {
    const parsed = JSON.parse(provider.configJson) as { region?: unknown };
    return parsed.region === 'global' ? 'global' : 'china';
  } catch {
    return 'china';
  }
}

function mergeProviderConfig(
  configJson: string | undefined,
  patch: Record<string, unknown>
): string {
  let base: Record<string, unknown> = {};
  if (configJson) {
    try {
      const parsed: unknown = JSON.parse(configJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        base = parsed as Record<string, unknown>;
      }
    } catch {
      base = {};
    }
  }
  return JSON.stringify({ ...base, ...patch });
}

function readAcpCommand(provider: EnrichedProvider): string {
  if (!provider.configJson) return '';
  try {
    const parsed = JSON.parse(provider.configJson) as { command?: unknown };
    return typeof parsed.command === 'string' ? parsed.command : '';
  } catch {
    return '';
  }
}

function readCuratedModels(provider: EnrichedProvider): CuratedModel[] | undefined {
  if (!provider.configJson) return undefined;
  try {
    const parsed = JSON.parse(provider.configJson) as { models?: unknown };
    if (!Array.isArray(parsed.models)) return undefined;
    if (parsed.models.length === 0) return [];
    const valid = parsed.models.flatMap((model) => {
      if (!model || typeof model !== 'object') return [];
      const { id, name } = model as { id?: unknown; name?: unknown };
      if (typeof id !== 'string') return [];
      return [{ id, ...(typeof name === 'string' ? { name } : {}) }];
    });
    return valid.length > 0 ? valid : undefined;
  } catch {
    return undefined;
  }
}

const KIMI_REGION_LABELS: Record<'china' | 'global', string> = {
  china: 'China (api.kimi.com)',
  global: 'Global (api.moonshot.ai)',
};

const CONNECTION_GATE_TIMEOUT_MS = 10000;

interface VisibleModelsPanelState {
  fetching: boolean;
  error: string | null;
  candidates: Array<{ id: string; name?: string }> | null;
  fingerprint?: string;
  draftCheckedIds?: Set<string>;
  cachedOnlyIds?: Set<string>;
}

const EMPTY_VISIBLE_MODELS_PANEL: VisibleModelsPanelState = {
  fetching: false,
  error: null,
  candidates: null,
};

function getVisibleModelsFingerprint(provider: EnrichedProvider): string {
  const tokens: Array<string | undefined> = [
    provider.providerId,
    readAcpCommand(provider),
    provider.baseUrl,
    provider.configJson,
    String(provider.available),
  ];
  return tokens.map((t) => t ?? '').join('|');
}

function mergeVisibleModelCandidates(
  lists: Array<Array<{ id: string; name?: string }> | undefined>
): Array<{ id: string; name?: string }> {
  const merged = new Map<string, { id: string; name?: string }>();
  for (const list of lists) {
    for (const model of list ?? []) {
      const existing = merged.get(model.id);
      if (!existing) {
        merged.set(model.id, {
          id: model.id,
          ...(model.name !== undefined ? { name: model.name } : {}),
        });
      } else if (existing.name === undefined && model.name !== undefined) {
        merged.set(model.id, { ...existing, name: model.name });
      }
    }
  }
  return [...merged.values()];
}

function getDefaultVisibleCheckedIds(
  provider: EnrichedProvider,
  visibleRows: Array<{ id: string }>,
  cachedOnlyIds?: Set<string>
): Set<string> {
  const curatedList = readCuratedModels(provider);
  if (curatedList !== undefined) {
    return new Set(curatedList.map((model) => model.id));
  }
  return new Set(
    visibleRows.filter((model) => !cachedOnlyIds?.has(model.id)).map((model) => model.id)
  );
}

export function ProvidersSettings() {
  const [providers, setProviders] = useState<EnrichedProvider[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [gateTimeout, setGateTimeout] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(
    () => new URLSearchParams(window.location.search).get('reason') === 'session_expired'
  );
  const loadGenerationRef = useRef(0);
  const hasLoadedProvidersRef = useRef(false);
  const reconnectPendingRef = useRef(false);
  const autoRetriedRef = useRef(false);
  const autoRetryShowsLoadingRef = useRef(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [oauthFlow, setOauthFlow] = useState<OAuthFlowState | null>(null);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [acpEditor, setAcpEditor] = useState<{
    providerId: string;
    providerName: string;
    command: string;
    models?: AcpConfiguredModel[];
    envBacked?: boolean;
    configJson?: string;
  } | null>(null);
  const [kimiRegions, setKimiRegions] = useState<Record<string, 'china' | 'global'>>({});
  const lastSyncedKimiRegions = useRef<Record<string, 'china' | 'global'>>({});
  const [customEditor, setCustomEditor] = useState<EditorState | null>(null);
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null);
  const [savingCustom, setSavingCustom] = useState(false);
  const [testingCustom, setTestingCustom] = useState(false);
  const [visibleModelsPanels, setVisibleModelsPanels] = useState<
    Record<string, VisibleModelsPanelState>
  >({});
  const visibleModelsGenRef = useRef<Record<string, number>>({});
  const previousProvidersRef = useRef<EnrichedProvider[]>([]);
  const providersRef = useRef<EnrichedProvider[]>([]);
  providersRef.current = providers;
  const [credentialStore, setCredentialStore] = useState<CredentialStoreStatus | null>(
    credentialStoreStatus.value
  );
  useSignalEffect(() => {
    setCredentialStore(credentialStoreStatus.value);
  });
  const { fetchingModels, fetchedModels, fetchModelsError, fetchedAt, handleFetchModels } =
    useFetchModels(customEditor);

  const loadProviders = async (showLoading = true) => {
    const generation = ++loadGenerationRef.current;
    autoRetryShowsLoadingRef.current = showLoading;
    try {
      if (showLoading) setLoading(true);
      setLoadError(false);
      setGateTimeout(false);
      await connectionManager.onConnected(CONNECTION_GATE_TIMEOUT_MS);
      if (generation !== loadGenerationRef.current) return;
      const [{ providers: records }, authResponse] = await Promise.all([
        listProviders(),
        listProviderAuthStatus().catch((_err) => {
          toast.warning('Auth status unavailable — showing cached state');
          return null;
        }),
      ]);
      if (generation !== loadGenerationRef.current) return;
      autoRetriedRef.current = false;
      hasLoadedProvidersRef.current = true;
      if (sessionExpired) {
        setSessionExpired(false);
        const params = new URLSearchParams(window.location.search);
        params.delete('reason');
        const query = params.toString();
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${query ? `?${query}` : ''}`
        );
      }
      const authById = new Map(authResponse?.providers.map((a) => [a.id, a]));
      const previousAuthById = new Map(providers.map((p) => [p.providerId, p.authStatus]));
      const enriched = records.map((r) => ({
        ...r,
        authStatus: authResponse ? authById.get(r.providerId) : previousAuthById.get(r.providerId),
      }));
      setProviders(enriched);
      const nextRegions: Record<string, 'china' | 'global'> = {};
      for (const p of enriched) {
        if (p.providerId === 'kimi') {
          nextRegions[p.id] = readKimiRegion(p);
        }
      }
      const syncedRegions = lastSyncedKimiRegions.current;
      setKimiRegions((prev) => {
        const merged: Record<string, 'china' | 'global'> = { ...nextRegions };
        for (const [id, edited] of Object.entries(prev)) {
          if (id in nextRegions && edited !== syncedRegions[id]) {
            merged[id] = edited;
          }
        }
        return merged;
      });
      lastSyncedKimiRegions.current = nextRegions;
      if (oauthFlow && !enriched.some((p) => p.providerId === oauthFlow.providerId)) {
        setOauthFlow(null);
      }
    } catch (err) {
      if (generation !== loadGenerationRef.current) return;
      setLoadError(true);
      setGateTimeout(
        err instanceof ConnectionTimeoutError || err instanceof ConnectionNotReadyError
      );
      if (showLoading) toast.error('Failed to load providers');
    } finally {
      if (generation === loadGenerationRef.current) {
        setLoading(false);
      }
    }
  };

  const loadProvidersRef = useRef(loadProviders);
  loadProvidersRef.current = loadProviders;

  useEffect(() => {
    loadProviders();
    return () => {
      loadGenerationRef.current++;
    };
  }, []);

  useEffect(() => {
    const previousById = new Map(previousProvidersRef.current.map((p) => [p.id, p]));
    previousProvidersRef.current = providers;
    setVisibleModelsPanels((prev) => {
      let changed = false;
      const next: Record<string, VisibleModelsPanelState> = {};
      for (const [id, panel] of Object.entries(prev)) {
        const provider = providers.find((p) => p.id === id);
        if (!provider) {
          changed = true;
          continue;
        }
        if (previousById.get(id) !== provider) {
          visibleModelsGenRef.current[id] = (visibleModelsGenRef.current[id] ?? 0) + 1;
          if (panel.fetching) {
            next[id] = EMPTY_VISIBLE_MODELS_PANEL;
            changed = true;
            continue;
          }
        }
        const fingerprint = getVisibleModelsFingerprint(provider);
        if (panel.fingerprint && panel.fingerprint !== fingerprint) {
          next[id] = {
            ...panel,
            candidates: null,
            error: null,
            fingerprint: undefined,
            draftCheckedIds: undefined,
          };
          changed = true;
        } else {
          next[id] = panel;
        }
      }
      return changed ? next : prev;
    });
  }, [providers]);

  useEffect(() => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      if (hasLoadedProvidersRef.current) reconnectPendingRef.current = true;
      return;
    }
    if (reconnectPendingRef.current) {
      reconnectPendingRef.current = false;
      if (!loadError || autoRetriedRef.current) {
        loadProvidersRef.current(false);
      }
    }
    const unsub = hub.onEvent('providers.changed', () => {
      loadProvidersRef.current(!hasLoadedProvidersRef.current);
    });
    return () => {
      unsub();
    };
  }, [connectionState.value]);

  useEffect(() => {
    if (connectionState.value !== 'connected' || !loadError) return;
    if (autoRetriedRef.current) return;
    autoRetriedRef.current = true;
    loadProviders(autoRetryShowsLoadingRef.current);
  }, [connectionState.value, loadError]);

  const handleRetry = () => {
    if (!connectionManager.isConnected()) {
      connectionManager.reconnect();
    }
    loadProviders();
  };

  useEffect(() => {
    if (!oauthFlow) return;
    const pollInterval = setInterval(async () => {
      try {
        const response = await listProviderAuthStatus();
        const provider = response.providers.find((p) => p.id === oauthFlow.providerId);
        if (provider?.isAuthenticated) {
          setOauthFlow(null);
          toast.success(`${oauthFlow.providerName} authenticated successfully`);
          await loadProviders();
        }
      } catch {}
    }, 2000);
    return () => clearInterval(pollInterval);
  }, [oauthFlow]);

  const handleToggleEnabled = async (provider: EnrichedProvider) => {
    setPendingId(provider.id);
    try {
      await updateProvider(provider.id, { isEnabled: !provider.isEnabled });
      toast.success(`${provider.displayName} ${provider.isEnabled ? 'disabled' : 'enabled'}`);
      await loadProviders();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setPendingId(null);
    }
  };

  const handleSetDefault = async (provider: EnrichedProvider) => {
    if (provider.isDefault) return;
    setPendingId(provider.id);
    try {
      await setDefaultProvider(provider.id);
      toast.success(`${provider.displayName} set as default`);
      await loadProviders();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setPendingId(null);
    }
  };

  const handleDelete = async (provider: EnrichedProvider) => {
    if (!confirm(`Delete provider "${provider.displayName}"?`)) return;
    setPendingId(provider.id);
    try {
      await deleteProvider(provider.id);
      toast.success(`${provider.displayName} deleted`);
      await loadProviders();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setPendingId(null);
    }
  };

  const handleTest = async (provider: EnrichedProvider) => {
    setPendingId(provider.id);
    try {
      const result = await testProvider(provider.id);
      if (result.healthy) {
        toast.success(`${provider.displayName} is healthy`);
      } else {
        toast.error(`${provider.displayName} unhealthy: ${result.error || 'unknown'}`);
      }
      await loadProviders();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Test failed');
    } finally {
      setPendingId(null);
    }
  };

  const handleUpdateApiKey = async (provider: EnrichedProvider) => {
    const key = apiKeys[provider.id]?.trim();
    if (!key) {
      toast.error('API key is required');
      return;
    }
    setPendingId(provider.id);
    try {
      await updateProvider(provider.id, {}, { apiKey: key });
      toast.success(`API key updated for ${provider.displayName}`);
      setApiKeys((prev) => ({ ...prev, [provider.id]: '' }));
      await loadProviders();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setPendingId(null);
    }
  };

  const handleUpdateKimiRegion = async (provider: EnrichedProvider) => {
    const region = kimiRegions[provider.id] ?? 'china';
    setPendingId(provider.id);
    try {
      await updateProvider(provider.id, {
        configJson: mergeProviderConfig(provider.configJson, { region }),
      });
      lastSyncedKimiRegions.current = {
        ...lastSyncedKimiRegions.current,
        [provider.id]: region,
      };
      toast.success(`${provider.displayName} region set to ${KIMI_REGION_LABELS[region]}`);
      await loadProviders();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed');
    } finally {
      setPendingId(null);
    }
  };

  const handleOAuthLogin = async (provider: EnrichedProvider) => {
    setPendingId(provider.id);
    try {
      const response = await loginProvider(provider.providerId);
      if (!response.success) {
        toast.error(response.error || 'Failed to start OAuth flow');
        return;
      }
      if (response.authUrl) {
        window.open(response.authUrl, '_blank');
      }
      setOauthFlow({
        providerId: provider.providerId,
        providerName: provider.displayName,
        authUrl: response.authUrl,
        userCode: response.userCode,
        verificationUri: response.verificationUri,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setPendingId(null);
    }
  };

  const handleOAuthLogout = async (provider: EnrichedProvider) => {
    setPendingId(provider.id);
    try {
      const response = await logoutProvider(provider.providerId);
      if (!response.success) {
        toast.error(response.error || 'Logout failed');
        return;
      }
      toast.success(`Logged out from ${provider.displayName}`);
      await loadProviders();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Logout failed');
    } finally {
      setPendingId(null);
    }
  };

  const handleOAuthRefresh = async (provider: EnrichedProvider) => {
    setPendingId(provider.id);
    try {
      const response = await refreshProvider(provider.providerId);
      if (response.success) {
        toast.success(`Token refreshed for ${provider.displayName}`);
        await loadProviders();
      } else {
        toast.error(response.error || 'Refresh failed');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Refresh failed');
    } finally {
      setPendingId(null);
    }
  };

  const handleEditCustom = (provider: EnrichedProvider) => {
    if (!provider.customEndpointConfigJson) return;
    try {
      const config = JSON.parse(
        provider.customEndpointConfigJson
      ) as import('@hyperneo/shared').CustomEndpointConfig;
      setCustomEditor(existingToEditor(config));
      setEditingCustomId(provider.id);
    } catch {
      toast.error('Failed to parse custom endpoint config');
    }
  };

  const handleSaveCustom = async () => {
    if (!customEditor || !editingCustomId) return;
    const err = validateEditor(customEditor);
    if (err) {
      toast.error(err);
      return;
    }
    try {
      setSavingCustom(true);
      const config = editorToConfig(customEditor);
      await updateProvider(
        editingCustomId,
        {
          displayName: config.name,
          baseUrl: config.baseUrl,
          customEndpointConfigJson: JSON.stringify(config),
        },
        config.apiKey ? { apiKey: config.apiKey } : undefined
      );
      toast.success(`Updated '${config.name}'`);
      setCustomEditor(null);
      setEditingCustomId(null);
      await loadProviders();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSavingCustom(false);
    }
  };

  const handleTestCustom = async () => {
    if (!customEditor) return;
    try {
      setTestingCustom(true);
      const result = await testCustomEndpoint(customEditor);
      if (result.success) {
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Test failed');
    } finally {
      setTestingCustom(false);
    }
  };

  const isStaleVisibleModelsFetch = (
    provider: EnrichedProvider,
    generation: number,
    fingerprint: string
  ): boolean => {
    if (generation !== visibleModelsGenRef.current[provider.id]) return true;
    const currentProvider = providersRef.current.find((p) => p.id === provider.id);
    if (!currentProvider || fingerprint !== getVisibleModelsFingerprint(currentProvider)) {
      setVisibleModelsPanels((prev) => ({
        ...prev,
        [provider.id]: EMPTY_VISIBLE_MODELS_PANEL,
      }));
      return true;
    }
    return false;
  };

  const handleFetchVisibleModels = async (provider: EnrichedProvider) => {
    const fingerprint = getVisibleModelsFingerprint(provider);
    const generation = (visibleModelsGenRef.current[provider.id] ?? 0) + 1;
    visibleModelsGenRef.current[provider.id] = generation;
    setVisibleModelsPanels((prev) => ({
      ...prev,
      [provider.id]: { ...EMPTY_VISIBLE_MODELS_PANEL, fetching: true },
    }));
    const options =
      provider.providerId === 'acp'
        ? { command: readAcpCommand(provider) }
        : provider.baseUrl
          ? { baseUrl: provider.baseUrl }
          : undefined;
    const remote = await listProviderRemoteModels(provider.id, { ...options, force: true }).catch(
      (err) => ({ models: [], error: err })
    );
    if (isStaleVisibleModelsFetch(provider, generation, fingerprint)) return;
    const curatedList = readCuratedModels(provider);
    if ('error' in remote) {
      const candidates = mergeVisibleModelCandidates([curatedList]);
      setVisibleModelsPanels((prev) => ({
        ...prev,
        [provider.id]: {
          fetching: false,
          error:
            remote.error instanceof Error ? remote.error.message : 'Failed to fetch remote models',
          candidates,
          fingerprint,
          draftCheckedIds: getDefaultVisibleCheckedIds(provider, candidates),
        },
      }));
    } else {
      const cached = (await connectionManager
        .getHubIfConnected()
        ?.request('models.list', { useCache: true })
        .catch(() => null)) as {
        models?: Array<{ id?: unknown; display_name?: unknown; provider?: unknown }>;
      } | null;
      if (isStaleVisibleModelsFetch(provider, generation, fingerprint)) return;
      const cachedProviderModels = (cached?.models ?? []).flatMap((model) =>
        model.provider === provider.providerId && typeof model.id === 'string'
          ? [
              {
                id: model.id,
                ...(typeof model.display_name === 'string' ? { name: model.display_name } : {}),
              },
            ]
          : []
      );
      const candidates = mergeVisibleModelCandidates([
        curatedList,
        remote.models,
        cachedProviderModels,
      ]);
      const discoveryIds = new Set(
        mergeVisibleModelCandidates([curatedList, remote.models]).map((model) => model.id)
      );
      const cachedOnlyIds = new Set(
        candidates.map((model) => model.id).filter((id) => !discoveryIds.has(id))
      );
      setVisibleModelsPanels((prev) => ({
        ...prev,
        [provider.id]: {
          fetching: false,
          error: null,
          candidates,
          fingerprint,
          draftCheckedIds: getDefaultVisibleCheckedIds(provider, candidates, cachedOnlyIds),
          cachedOnlyIds,
        },
      }));
    }
  };

  const handleToggleVisibleModel = (provider: EnrichedProvider, modelId: string) => {
    setVisibleModelsPanels((prev) => {
      const panel = prev[provider.id] ?? EMPTY_VISIBLE_MODELS_PANEL;
      const visibleRows = panel.candidates ?? readCuratedModels(provider) ?? [];
      const checkedIds = new Set(
        panel.draftCheckedIds ??
          getDefaultVisibleCheckedIds(provider, visibleRows, panel.cachedOnlyIds)
      );
      if (checkedIds.has(modelId)) {
        checkedIds.delete(modelId);
      } else {
        checkedIds.add(modelId);
      }
      return {
        ...prev,
        [provider.id]: {
          ...panel,
          fingerprint: panel.fingerprint ?? getVisibleModelsFingerprint(provider),
          draftCheckedIds: checkedIds,
        },
      };
    });
  };

  const handleSaveVisibleModels = async (provider: EnrichedProvider) => {
    const panel = visibleModelsPanels[provider.id] ?? EMPTY_VISIBLE_MODELS_PANEL;
    const visibleRows = panel.candidates ?? readCuratedModels(provider) ?? [];
    const checkedIds =
      panel.draftCheckedIds ??
      getDefaultVisibleCheckedIds(provider, visibleRows, panel.cachedOnlyIds);
    const models = visibleRows
      .filter((model) => checkedIds.has(model.id))
      .map((model) => ({ id: model.id, ...(model.name ? { name: model.name } : {}) }));

    if (models.length === 0) {
      const confirmed = confirm(
        'Saving with no models selected will hide all models for this provider. Continue?'
      );
      if (!confirmed) return;
    }

    const configJson = mergeProviderConfig(provider.configJson, { models });
    if (configJson.length > 64 * 1024) {
      toast.error(
        `${provider.displayName} curation is too large to store (${configJson.length} chars, limit 65536). Select fewer models.`
      );
      return;
    }

    setPendingId(provider.id);
    try {
      await updateProvider(provider.id, { configJson });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save curation');
      setPendingId(null);
      return;
    }
    const hub = connectionManager.getHubIfConnected();
    if (hub) {
      try {
        const response = (await hub.request('models.list', {})) as {
          models?: Array<{ id?: string; provider?: string }>;
        };
        if (provider.isEnabled) {
          const providerModels = (response.models ?? []).filter(
            (model) => model.provider === provider.providerId
          );
          const visibleIds = new Set(providerModels.map((model) => model.id));
          const coherent =
            models.every((model) => visibleIds.has(model.id)) &&
            providerModels.every((model) => !!model.id && checkedIds.has(model.id));
          if (!coherent) {
            toast.warning(
              `${provider.displayName} curation saved, but the refreshed model list does not match yet. Try fetching models again.`
            );
          }
        }
      } catch {
        toast.warning(
          `${provider.displayName} curation saved, but the refresh could not be verified.`
        );
      }
    }
    await loadProviders();
    toast.success(`${provider.displayName} curation saved`);
    setPendingId(null);
  };

  const healthDotClass = (status: string) => {
    switch (status) {
      case 'healthy':
        return 'bg-green-500';
      case 'unhealthy':
        return 'bg-red-500';
      default:
        return 'bg-gray-500';
    }
  };

  const formatHealthTime = (ts?: number) => {
    if (!ts) return 'Never';
    return new Date(ts).toLocaleString();
  };

  if (loading) {
    return (
      <SettingsSection title="Providers">
        <div class="text-gray-400 text-sm">Loading providers...</div>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection title="Providers">
        <div class="space-y-3">
          <div class="flex items-center justify-between">
            <p class="text-sm text-gray-400">
              Manage AI providers. Enable, disable, and configure authentication.
            </p>
            <Button size="sm" variant="primary" onClick={() => setShowAddModal(true)}>
              Add Provider
            </Button>
          </div>

          {(credentialStore?.backend === 'keychain-unavailable' ||
            credentialStore?.backend === 'keychain-fallback') && (
            <div
              class={`rounded-lg border px-4 py-3 ${
                credentialStore.backend === 'keychain-fallback'
                  ? 'border-blue-500/30 bg-blue-500/10'
                  : 'border-yellow-500/30 bg-yellow-500/10'
              }`}
            >
              <p
                class={`text-sm font-medium ${
                  credentialStore.backend === 'keychain-fallback'
                    ? 'text-blue-400'
                    : 'text-yellow-400'
                }`}
              >
                {credentialStore.backend === 'keychain-fallback'
                  ? 'Using local encrypted storage (macOS Keychain unavailable)'
                  : 'macOS Keychain unavailable'}
              </p>
              <p
                class={`text-xs mt-1 ${
                  credentialStore.backend === 'keychain-fallback'
                    ? 'text-blue-400/80'
                    : 'text-yellow-400/80'
                }`}
              >
                {credentialStore.backend === 'keychain-fallback'
                  ? (credentialStore.warning ??
                      'macOS Keychain is locked or unavailable; using local encrypted file storage. ' +
                        'Run `security unlock-keychain` (prompts for your login password) or restart ' +
                        'HyperNeo from a GUI session to restore Keychain persistence.') +
                    ' Note: file storage is encrypted but weaker than Keychain — any same-user process can read both the encrypted file and its key. Use environment variables for stronger isolation on headless deployments.'
                  : (credentialStore.warning ??
                    'Persistent credential storage is unavailable until macOS Keychain is unlocked. Run `security unlock-keychain`, launch HyperNeo from a desktop/GUI session, or use environment variables / a secret manager for headless deployments.')}
              </p>
            </div>
          )}

          {loadError && autoRetryShowsLoadingRef.current && providers.length > 0 && (
            <div class="flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2">
              <p class="text-sm text-red-300">
                {sessionExpired
                  ? 'Your session expired.'
                  : gateTimeout
                    ? 'Could not reach the HyperNeo daemon — showing cached providers.'
                    : 'Failed to reload providers — showing cached providers.'}
              </p>
              <Button size="sm" variant="secondary" onClick={handleRetry}>
                Retry
              </Button>
            </div>
          )}

          {loadError && autoRetryShowsLoadingRef.current && providers.length === 0 ? (
            <div class="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-6 text-center">
              <p class="text-sm text-red-300">
                {sessionExpired ? 'Your session expired.' : 'Failed to load providers.'}
              </p>
              <p class="text-xs text-gray-400 mt-1">
                {sessionExpired
                  ? 'Re-authenticate, then retry to reload your providers.'
                  : gateTimeout
                    ? 'Could not reach the HyperNeo daemon — check that it is running, then retry.'
                    : 'The load failed. Try again in a moment.'}
              </p>
              <div class="mt-3">
                <Button size="sm" variant="secondary" onClick={handleRetry}>
                  Retry
                </Button>
              </div>
            </div>
          ) : providers.length === 0 ? (
            <div class="rounded-lg border border-dashed border-dark-600 px-4 py-6 text-center">
              <p class="text-sm text-gray-400">No providers configured.</p>
              <p class="text-xs text-gray-500 mt-1">Add a provider to start using AI models.</p>
            </div>
          ) : null}

          {providers.length > 0 && (
            <div class="space-y-2">
              {providers.map((provider) => {
                const isExpanded = expandedId === provider.id;
                const isPending = pendingId === provider.id;
                const isCustom = provider.kind === 'custom_endpoint';
                const auth = provider.authStatus;
                const isAuthenticated = provider.available || auth?.isAuthenticated;
                const needsRefresh = auth?.needsRefresh;
                const visiblePanel = visibleModelsPanels[provider.id] ?? EMPTY_VISIBLE_MODELS_PANEL;
                const curatedList = readCuratedModels(provider);
                const storedCuratedIds =
                  curatedList !== undefined
                    ? new Set(curatedList.map((model) => model.id))
                    : undefined;
                const visibleRows = visiblePanel.candidates ?? curatedList ?? [];
                const defaultCheckedIds = getDefaultVisibleCheckedIds(
                  provider,
                  visibleRows,
                  visiblePanel.cachedOnlyIds
                );
                const draftCheckedIds = visiblePanel.draftCheckedIds ?? defaultCheckedIds;
                const visibleCheckedCount = visibleRows.filter((model) =>
                  draftCheckedIds.has(model.id)
                ).length;
                const hasUnsavedVisibleModels = Boolean(
                  visiblePanel.draftCheckedIds !== undefined &&
                    (draftCheckedIds.size !== defaultCheckedIds.size ||
                      [...draftCheckedIds].some((id) => !defaultCheckedIds.has(id)))
                );

                return (
                  <div
                    key={provider.id}
                    class="rounded-lg border border-white/[0.08] bg-white/[0.025] overflow-hidden"
                  >
                    <div
                      class="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-white/[0.02] transition-colors"
                      onClick={() => setExpandedId(isExpanded ? null : provider.id)}
                    >
                      <div
                        class={`w-2 h-2 rounded-full flex-shrink-0 ${healthDotClass(provider.healthStatus)}`}
                        title={`Health: ${provider.healthStatus}`}
                      />

                      <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                          <span class="text-sm font-medium text-gray-100">
                            {provider.displayName}
                          </span>
                          <span class="text-[10px] uppercase tracking-wide text-gray-500 px-1.5 py-0.5 rounded bg-dark-800">
                            {isCustom ? 'Custom' : 'Built-in'}
                          </span>
                          <span
                            class={`text-[10px] px-1.5 py-0.5 rounded-full ${
                              provider.authType === 'api_key'
                                ? 'bg-blue-900/40 text-blue-300'
                                : provider.authType === 'oauth'
                                  ? 'bg-purple-900/40 text-purple-300'
                                  : 'bg-gray-800 text-gray-400'
                            }`}
                          >
                            {provider.authType === 'api_key'
                              ? 'API Key'
                              : provider.authType === 'oauth'
                                ? 'OAuth'
                                : 'None'}
                          </span>
                          {needsRefresh && (
                            <span class="text-[10px] px-1.5 py-0.5 rounded-full bg-yellow-900/40 text-yellow-300">
                              Refresh Needed
                            </span>
                          )}
                        </div>
                        <div class="text-xs text-gray-500 font-mono mt-0.5">
                          {provider.providerId}
                        </div>
                      </div>

                      <div class="flex items-center gap-2 flex-shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleSetDefault(provider);
                          }}
                          disabled={isPending || provider.isDefault}
                          class={`p-1 rounded transition-colors ${
                            provider.isDefault
                              ? 'text-yellow-400'
                              : 'text-gray-600 hover:text-yellow-400'
                          }`}
                          title={provider.isDefault ? 'Default provider' : 'Set as default'}
                        >
                          <svg
                            class="w-4 h-4"
                            fill={provider.isDefault ? 'currentColor' : 'none'}
                            viewBox="0 0 24 24"
                            stroke="currentColor"
                          >
                            <path
                              stroke-linecap="round"
                              stroke-linejoin="round"
                              stroke-width={2}
                              d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
                            />
                          </svg>
                        </button>

                        <button
                          type="button"
                          role="switch"
                          aria-checked={provider.isEnabled}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleToggleEnabled(provider);
                          }}
                          disabled={isPending}
                          class={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full transition-colors ${
                            provider.isEnabled ? 'bg-blue-600' : 'bg-dark-700'
                          }`}
                        >
                          <span
                            class={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow transition duration-200 ease-in-out mt-0.5 ml-0.5 ${
                              provider.isEnabled ? 'translate-x-4' : 'translate-x-0'
                            }`}
                          />
                        </button>

                        <svg
                          class={`w-4 h-4 text-gray-500 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                          fill="none"
                          viewBox="0 0 24 24"
                          stroke="currentColor"
                        >
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width={2}
                            d="M19 9l-7 7-7-7"
                          />
                        </svg>
                      </div>
                    </div>

                    {isExpanded && (
                      <div class="px-4 pb-4 border-t border-white/[0.06] space-y-4">
                        <div class="pt-3">
                          <h5 class="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
                            Authentication
                          </h5>
                          {provider.authType === 'api_key' && (
                            <div class="flex gap-2">
                              <input
                                type="password"
                                placeholder={isAuthenticated ? 'Update API key' : 'Enter API key'}
                                value={apiKeys[provider.id] ?? ''}
                                onInput={(e) =>
                                  setApiKeys((prev) => ({
                                    ...prev,
                                    [provider.id]: e.currentTarget.value,
                                  }))
                                }
                                class="flex-1 min-w-0 bg-dark-950 border border-dark-700 rounded px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500 font-mono"
                              />
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => handleUpdateApiKey(provider)}
                                loading={isPending}
                                disabled={isPending}
                              >
                                {isAuthenticated ? 'Update key' : 'Set key'}
                              </Button>
                            </div>
                          )}
                          {provider.authType === 'oauth' && (
                            <div class="flex gap-2">
                              {needsRefresh && (
                                <Button
                                  size="sm"
                                  variant="warning"
                                  onClick={() => handleOAuthRefresh(provider)}
                                  loading={isPending}
                                  disabled={isPending}
                                >
                                  Refresh Login
                                </Button>
                              )}
                              {isAuthenticated || needsRefresh ? (
                                <Button
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => handleOAuthLogout(provider)}
                                  loading={isPending}
                                  disabled={isPending}
                                >
                                  Logout
                                </Button>
                              ) : (
                                <Button
                                  size="sm"
                                  variant="primary"
                                  onClick={() => handleOAuthLogin(provider)}
                                  loading={isPending}
                                  disabled={isPending}
                                >
                                  Login
                                </Button>
                              )}
                            </div>
                          )}
                          {provider.authType === 'none' && (
                            <p class="text-xs text-gray-500">No authentication required.</p>
                          )}
                        </div>

                        {isCustom && provider.baseUrl && (
                          <div>
                            <h5 class="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1">
                              Configuration
                            </h5>
                            <div class="text-xs text-gray-500 font-mono">{provider.baseUrl}</div>
                          </div>
                        )}

                        {provider.providerId === 'kimi' && !isCustom && (
                          <div>
                            <label
                              for={`kimi-region-${provider.id}`}
                              class="block text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2"
                            >
                              Region
                            </label>
                            <div class="flex gap-2 items-center">
                              <select
                                id={`kimi-region-${provider.id}`}
                                value={kimiRegions[provider.id] ?? 'china'}
                                onChange={(e) =>
                                  setKimiRegions((prev) => ({
                                    ...prev,
                                    [provider.id]: e.currentTarget.value as 'china' | 'global',
                                  }))
                                }
                                class="flex-1 min-w-0 bg-dark-950 border border-dark-700 rounded px-2 py-1.5 text-sm text-gray-100 focus:outline-none focus:border-blue-500"
                              >
                                <option value="china">{KIMI_REGION_LABELS.china}</option>
                                <option value="global">{KIMI_REGION_LABELS.global}</option>
                              </select>
                              <Button
                                size="sm"
                                variant="primary"
                                onClick={() => handleUpdateKimiRegion(provider)}
                                loading={isPending}
                                disabled={
                                  isPending ||
                                  (kimiRegions[provider.id] ?? 'china') === readKimiRegion(provider)
                                }
                              >
                                Save
                              </Button>
                            </div>
                            <p class="text-[11px] text-gray-500 mt-1">
                              Switching region changes the upstream base URL — use the endpoint that
                              matches your Kimi account.
                            </p>
                          </div>
                        )}

                        {provider.providerId === 'acp' && !isCustom && (
                          <div>
                            <div class="flex items-center justify-between gap-2">
                              <div class="min-w-0">
                                <h5 class="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1">
                                  Configuration
                                </h5>
                                <div class="text-xs text-gray-500 font-mono truncate">
                                  {readAcpCommand(provider) ||
                                    (provider.available
                                      ? 'Using HYPERNEO_ACP_COMMAND'
                                      : 'No command set')}
                                </div>
                                {(readCuratedModels(provider)?.length ?? 0) > 0 && (
                                  <div class="mt-1 flex flex-wrap gap-1">
                                    {readCuratedModels(provider)?.map((model) => (
                                      <span
                                        key={model.id}
                                        class="text-[10px] px-1.5 py-0.5 rounded bg-dark-800 text-gray-300"
                                      >
                                        {model.name ?? model.id}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() =>
                                  setAcpEditor({
                                    providerId: provider.id,
                                    providerName: provider.displayName,
                                    command: readAcpCommand(provider),
                                    models: readCuratedModels(provider),
                                    envBacked: !readAcpCommand(provider),
                                    configJson: provider.configJson,
                                  })
                                }
                                disabled={isPending}
                              >
                                Edit
                              </Button>
                            </div>
                          </div>
                        )}

                        {!isCustom && (
                          <div data-testid="visible-models-panel">
                            <div class="flex items-center justify-between gap-2">
                              <h5 class="text-xs font-semibold uppercase tracking-wider text-gray-400">
                                Visible models
                              </h5>
                              <Button
                                size="xs"
                                variant="secondary"
                                onClick={() => handleFetchVisibleModels(provider)}
                                loading={visiblePanel.fetching}
                                disabled={
                                  visiblePanel.fetching ||
                                  !provider.isEnabled ||
                                  hasUnsavedVisibleModels
                                }
                                title={
                                  !provider.isEnabled
                                    ? 'Enable this provider to fetch model candidates'
                                    : hasUnsavedVisibleModels
                                      ? 'Save or revert your selection before fetching again'
                                      : 'Fetch remote model candidates'
                                }
                              >
                                Fetch models
                              </Button>
                            </div>
                            {visiblePanel.error && (
                              <p class="text-xs text-red-400 mt-2">{visiblePanel.error}</p>
                            )}
                            {visibleRows.length === 0 ? (
                              <p class="text-xs text-gray-500 italic mt-2">
                                {storedCuratedIds
                                  ? 'No visible models curated.'
                                  : visiblePanel.error
                                    ? 'No stored curation to display.'
                                    : 'No curation stored — every static and discovered model is visible.'}
                              </p>
                            ) : (
                              <div>
                                <p class="text-[11px] text-gray-500 mt-2">
                                  {storedCuratedIds
                                    ? `${visibleCheckedCount} of ${visibleRows.length} visible.`
                                    : hasUnsavedVisibleModels
                                      ? `${visibleCheckedCount} of ${visibleRows.length} selected (unsaved).`
                                      : `${visibleCheckedCount} of ${visibleRows.length} selected.`}
                                </p>
                                <div class="max-h-48 overflow-y-auto space-y-1 mt-1">
                                  {visibleRows.map((model) => (
                                    <label
                                      key={model.id}
                                      class="flex items-center gap-2 text-xs text-gray-200 rounded px-1 py-0.5"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={draftCheckedIds.has(model.id)}
                                        disabled={isPending || visiblePanel.fetching}
                                        onChange={() =>
                                          handleToggleVisibleModel(provider, model.id)
                                        }
                                        class="rounded border-dark-600 bg-dark-900 text-blue-600 focus:ring-blue-500 focus:ring-offset-0"
                                      />
                                      <span class="font-mono break-all">{model.id}</span>
                                      {model.name && model.name !== model.id && (
                                        <span class="text-gray-500">{model.name}</span>
                                      )}
                                    </label>
                                  ))}
                                </div>
                                <div class="flex items-center justify-end mt-2">
                                  <Button
                                    size="xs"
                                    variant="primary"
                                    onClick={() => handleSaveVisibleModels(provider)}
                                    loading={isPending}
                                    disabled={isPending || !hasUnsavedVisibleModels}
                                  >
                                    Save curation
                                  </Button>
                                </div>
                              </div>
                            )}
                            <p class="text-[11px] text-gray-500 mt-1">
                              {visibleRows.length === 0
                                ? 'Fetch candidates, then check the models you want to make visible.'
                                : 'Check the models you want visible, then save.'}
                            </p>
                          </div>
                        )}

                        <div>
                          <h5 class="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
                            Health
                          </h5>
                          <div class="flex items-center gap-3">
                            <div class="flex items-center gap-1.5">
                              <div
                                class={`w-2 h-2 rounded-full ${healthDotClass(provider.healthStatus)}`}
                              />
                              <span class="text-xs text-gray-300 capitalize">
                                {provider.healthStatus}
                              </span>
                            </div>
                            <span class="text-xs text-gray-500">
                              Last checked: {formatHealthTime(provider.lastHealthCheckAt)}
                            </span>
                            <Button
                              size="xs"
                              variant="secondary"
                              onClick={() => handleTest(provider)}
                              loading={isPending}
                              disabled={isPending}
                            >
                              Test connection
                            </Button>
                          </div>
                        </div>

                        <div class="flex gap-2 pt-1">
                          {isCustom && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => handleEditCustom(provider)}
                              disabled={isPending}
                            >
                              Edit
                            </Button>
                          )}
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => handleDelete(provider)}
                            loading={isPending}
                            disabled={isPending}
                          >
                            Delete
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SettingsSection>

      {showAddModal && (
        <AddProviderModal
          existingProviderIds={providers.map((p) => p.providerId)}
          onClose={() => setShowAddModal(false)}
          onProviderAdded={loadProviders}
        />
      )}

      {oauthFlow && (
        <OAuthModal
          providerName={oauthFlow.providerName}
          authUrl={oauthFlow.authUrl}
          userCode={oauthFlow.userCode}
          verificationUri={oauthFlow.verificationUri}
          onCancel={() => {
            setOauthFlow(null);
            loadProviders();
          }}
          onComplete={() => {
            setOauthFlow(null);
            loadProviders();
          }}
        />
      )}

      {customEditor && editingCustomId && (
        <EditorModal
          state={customEditor}
          existingIds={[]}
          onChange={setCustomEditor}
          onSave={handleSaveCustom}
          onClose={() => {
            setCustomEditor(null);
            setEditingCustomId(null);
          }}
          saving={savingCustom}
          onTest={handleTestCustom}
          testing={testingCustom}
          onFetchModels={handleFetchModels}
          fetchingModels={fetchingModels}
          fetchedModels={fetchedModels}
          fetchModelsError={fetchModelsError}
          fetchedAt={fetchedAt}
        />
      )}

      {acpEditor && (
        <AcpEditorModal
          providerId={acpEditor.providerId}
          providerName={acpEditor.providerName}
          command={acpEditor.command}
          models={acpEditor.models}
          envBacked={acpEditor.envBacked}
          configJson={acpEditor.configJson}
          onClose={() => setAcpEditor(null)}
          onSaved={() => {
            setAcpEditor(null);
            loadProviders();
          }}
        />
      )}
    </>
  );
}
