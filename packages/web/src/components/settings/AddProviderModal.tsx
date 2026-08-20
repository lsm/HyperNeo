import { useState } from 'preact/hooks';
import { createProvider, loginProvider } from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import { Button } from '../ui/Button.tsx';
import { OAuthModal, type OAuthFlowState } from './OAuthModal.tsx';
import {
  EditorModal,
  PresetPicker,
  presetToEditor,
  editorToConfig,
  validateEditor,
  testCustomEndpoint,
  type EditorState,
} from './CustomEndpointEditor.tsx';
import { useFetchModels } from './useFetchModels.ts';
import type { ProviderAuthResponse } from '@hyperneo/shared/provider';

interface BuiltInProviderPreset {
  providerId: string;
  displayName: string;
  authType: 'api_key' | 'oauth' | 'none';
  description: string;
  configField?: 'command';
}

const QUICK_ADD_PROVIDERS: BuiltInProviderPreset[] = [
  {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    authType: 'api_key',
    description: 'Claude models',
  },
  {
    providerId: 'anthropic-codex',
    displayName: 'OpenAI Codex',
    authType: 'oauth',
    description: 'GPT-4o, Codex via OpenAI',
  },
  {
    providerId: 'anthropic-copilot',
    displayName: 'GitHub Copilot',
    authType: 'oauth',
    description: 'Copilot models',
  },
  {
    providerId: 'openrouter',
    displayName: 'OpenRouter',
    authType: 'api_key',
    description: 'Multi-model hub',
  },
  {
    providerId: 'glm',
    displayName: 'Z.ai',
    authType: 'api_key',
    description: 'Zhipu AI models',
  },
  {
    providerId: 'ollama',
    displayName: 'Ollama',
    authType: 'none',
    description: 'Local models at localhost',
  },
];

const MORE_PROVIDERS: BuiltInProviderPreset[] = [
  {
    providerId: 'kimi',
    displayName: 'Kimi',
    authType: 'api_key',
    description: 'Moonshot AI models',
  },
  {
    providerId: 'minimax',
    displayName: 'MiniMax',
    authType: 'api_key',
    description: 'MiniMax models',
  },
  {
    providerId: 'deepseek',
    displayName: 'DeepSeek',
    authType: 'api_key',
    description: 'DeepSeek V4 models',
  },
  {
    providerId: 'ollama-cloud',
    displayName: 'Ollama Cloud',
    authType: 'api_key',
    description: 'Cloud Ollama endpoints',
  },
  {
    providerId: 'acp',
    displayName: 'ACP Agent',
    authType: 'none',
    description: 'ACP agent (e.g. Devin) via a shell command',
    configField: 'command',
  },
];

interface AddProviderModalProps {
  existingProviderIds: string[];
  onClose: () => void;
  onProviderAdded: () => void;
}

const KIMI_REGION_OPTIONS = [
  { value: 'china', label: 'China (api.kimi.com)' },
  { value: 'global', label: 'Global (api.moonshot.ai)' },
] as const;

export function AddProviderModal({
  existingProviderIds,
  onClose,
  onProviderAdded,
}: AddProviderModalProps) {
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [acpCommands, setAcpCommands] = useState<Record<string, string>>({});
  const [addingId, setAddingId] = useState<string | null>(null);
  const [oauthFlow, setOauthFlow] = useState<OAuthFlowState | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [customEditor, setCustomEditor] = useState<EditorState | null>(null);
  const [showPresets, setShowPresets] = useState(false);
  const [savingCustom, setSavingCustom] = useState(false);
  const [testingCustom, setTestingCustom] = useState(false);
  const [kimiRegion, setKimiRegion] = useState<'china' | 'global'>('china');
  const { fetchingModels, fetchedModels, fetchModelsError, fetchedAt, handleFetchModels } =
    useFetchModels(customEditor);

  const isAdded = (providerId: string) => existingProviderIds.includes(providerId);

  const handleApiKeyChange = (providerId: string, value: string) => {
    setApiKeys((prev) => ({ ...prev, [providerId]: value }));
  };

  const handleAddBuiltIn = async (preset: BuiltInProviderPreset) => {
    const key = apiKeys[preset.providerId]?.trim();
    const command =
      preset.configField === 'command' ? acpCommands[preset.providerId]?.trim() : undefined;
    if (preset.authType === 'api_key' && !key) {
      toast.error('API key is required');
      return;
    }
    if (preset.configField === 'command' && !command) {
      toast.error('ACP command is required');
      return;
    }
    setAddingId(preset.providerId);
    try {
      await createProvider(
        {
          providerId: preset.providerId,
          displayName: preset.displayName,
          kind: 'built_in',
          authType: preset.authType,
          isEnabled: true,
          configJson:
            preset.providerId === 'kimi'
              ? JSON.stringify({ region: kimiRegion })
              : preset.configField === 'command'
                ? JSON.stringify({ command })
                : undefined,
        },
        preset.authType === 'api_key' && key ? { apiKey: key } : undefined
      );
      toast.success(`${preset.displayName} added`);
      onProviderAdded();
      if (!oauthFlow) onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to add provider');
    } finally {
      setAddingId(null);
    }
  };

  const handleOAuthLogin = async (preset: BuiltInProviderPreset) => {
    setAddingId(preset.providerId);
    try {
      const response: ProviderAuthResponse = await loginProvider(preset.providerId);
      if (!response.success) {
        toast.error(response.error || 'Failed to start OAuth flow');
        return;
      }

      await createProvider(
        {
          providerId: preset.providerId,
          displayName: preset.displayName,
          kind: 'built_in',
          authType: 'oauth',
          isEnabled: true,
        },
        undefined
      );
      onProviderAdded();

      if (response.authUrl) {
        window.open(response.authUrl, '_blank');
      }
      setOauthFlow({
        providerId: preset.providerId,
        providerName: preset.displayName,
        authUrl: response.authUrl,
        userCode: response.userCode,
        verificationUri: response.verificationUri,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to start login');
    } finally {
      setAddingId(null);
    }
  };

  const handleOAuthCancel = () => {
    setOauthFlow(null);
  };

  const handleOAuthComplete = () => {
    setOauthFlow(null);
    onProviderAdded();
    onClose();
  };

  const handlePickPreset = (preset: import('./customEndpointPresets.ts').CustomEndpointPreset) => {
    setShowPresets(false);
    let candidateId = preset.template.id ?? 'custom';
    const taken = new Set(existingProviderIds.map((id) => id.replace(/^custom:/, '')));
    let suffix = 1;
    const base = candidateId;
    while (taken.has(candidateId)) {
      suffix += 1;
      candidateId = `${base}-${suffix}`;
    }
    setCustomEditor({ ...presetToEditor(preset), id: candidateId });
  };

  const handleSaveCustom = async () => {
    if (!customEditor) return;
    const err = validateEditor(customEditor);
    if (err) {
      toast.error(err);
      return;
    }
    try {
      setSavingCustom(true);
      const config = editorToConfig(customEditor);
      await createProvider(
        {
          providerId: `custom:${config.id}`,
          displayName: config.name,
          kind: 'custom_endpoint',
          authType: config.apiKey ? 'api_key' : 'none',
          baseUrl: config.baseUrl,
          customEndpointConfigJson: JSON.stringify(config),
        },
        config.apiKey ? { apiKey: config.apiKey } : undefined
      );
      toast.success(`Added '${config.name}'`);
      setCustomEditor(null);
      onProviderAdded();
      onClose();
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

  const renderProviderCard = (preset: BuiltInProviderPreset) => {
    const added = isAdded(preset.providerId);
    const showRegionPicker = preset.providerId === 'kimi' && !added;
    return (
      <div
        key={preset.providerId}
        class={`rounded-lg border border-dark-600 bg-dark-850 p-3 flex flex-col gap-2 ${added ? 'opacity-50' : ''}`}
      >
        <div class="flex items-center justify-between">
          <div>
            <div class="text-sm font-medium text-gray-100">{preset.displayName}</div>
            <div class="text-xs text-gray-500">{preset.description}</div>
          </div>
          <span
            class={`text-[10px] px-1.5 py-0.5 rounded-full ${
              preset.authType === 'api_key'
                ? 'bg-blue-900/40 text-blue-300'
                : preset.authType === 'oauth'
                  ? 'bg-purple-900/40 text-purple-300'
                  : 'bg-gray-800 text-gray-400'
            }`}
          >
            {preset.authType === 'api_key'
              ? 'API Key'
              : preset.authType === 'oauth'
                ? 'OAuth'
                : 'None'}
          </span>
        </div>

        {showRegionPicker && (
          <div class="flex flex-col gap-1">
            <label
              for={`kimi-region-${preset.providerId}`}
              class="text-[10px] uppercase tracking-wider text-gray-500"
            >
              Region
            </label>
            <select
              id={`kimi-region-${preset.providerId}`}
              value={kimiRegion}
              onChange={(e) => setKimiRegion(e.currentTarget.value as 'china' | 'global')}
              class="bg-dark-950 border border-dark-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-blue-500"
            >
              {KIMI_REGION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {added ? (
          <div class="text-xs text-gray-500">Already added</div>
        ) : preset.authType === 'api_key' ? (
          <div class="flex gap-2">
            <input
              type="password"
              placeholder="API key"
              value={apiKeys[preset.providerId] ?? ''}
              onInput={(e) => handleApiKeyChange(preset.providerId, e.currentTarget.value)}
              class="flex-1 min-w-0 bg-dark-950 border border-dark-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-blue-500 font-mono"
            />
            <Button
              size="xs"
              variant="primary"
              onClick={() => handleAddBuiltIn(preset)}
              loading={addingId === preset.providerId}
              disabled={addingId !== null}
            >
              Add
            </Button>
          </div>
        ) : preset.configField === 'command' ? (
          <div class="flex gap-2">
            <input
              type="text"
              placeholder="e.g. devin acp"
              value={acpCommands[preset.providerId] ?? ''}
              onInput={(e) =>
                setAcpCommands((prev) => ({
                  ...prev,
                  [preset.providerId]: e.currentTarget.value,
                }))
              }
              class="flex-1 min-w-0 bg-dark-950 border border-dark-700 rounded px-2 py-1 text-xs text-gray-100 focus:outline-none focus:border-blue-500 font-mono"
            />
            <Button
              size="xs"
              variant="primary"
              onClick={() => handleAddBuiltIn(preset)}
              loading={addingId === preset.providerId}
              disabled={addingId !== null}
            >
              Add
            </Button>
          </div>
        ) : preset.authType === 'oauth' ? (
          <Button
            size="xs"
            variant="primary"
            onClick={() => handleOAuthLogin(preset)}
            loading={addingId === preset.providerId}
            disabled={addingId !== null}
            fullWidth
          >
            Connect
          </Button>
        ) : (
          <Button
            size="xs"
            variant="primary"
            onClick={() => handleAddBuiltIn(preset)}
            loading={addingId === preset.providerId}
            disabled={addingId !== null}
            fullWidth
          >
            Add
          </Button>
        )}
      </div>
    );
  };

  return (
    <>
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
        <div class="bg-dark-850 border border-dark-600 rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] flex flex-col">
          <div class="flex items-center justify-between px-4 py-3 border-b border-dark-700">
            <h3 class="text-sm font-semibold text-gray-100">Add Provider</h3>
            <button
              type="button"
              onClick={onClose}
              class="p-1 rounded hover:bg-dark-700"
              aria-label="Close"
            >
              <svg
                class="w-4 h-4 text-gray-400"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  stroke-width={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </button>
          </div>

          <div class="flex-1 overflow-y-auto p-4 space-y-4">
            <div>
              <h4 class="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-2">
                Quick Add
              </h4>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {QUICK_ADD_PROVIDERS.map(renderProviderCard)}
              </div>
            </div>

            <div>
              <button
                type="button"
                onClick={() => setShowMore((v) => !v)}
                class="flex items-center gap-1 text-xs font-medium text-gray-400 hover:text-gray-200 transition-colors"
              >
                <svg
                  class={`w-3 h-3 transition-transform ${showMore ? 'rotate-90' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M9 5l7 7-7 7"
                  />
                </svg>
                More providers
              </button>
              {showMore && (
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
                  {MORE_PROVIDERS.map(renderProviderCard)}
                </div>
              )}
            </div>

            <div class="pt-2 border-t border-dark-700">
              <button
                type="button"
                onClick={() => setShowPresets(true)}
                class="w-full text-left px-3 py-2.5 rounded-lg border border-dashed border-dark-600 hover:border-dark-500 hover:bg-white/5 transition-colors"
              >
                <div class="text-sm font-medium text-gray-200">Custom endpoint</div>
                <div class="text-xs text-gray-500 mt-0.5">
                  Self-hosted or third-party API (Ollama, LM Studio, LiteLLM...)
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>

      {showPresets && (
        <PresetPicker onPick={handlePickPreset} onClose={() => setShowPresets(false)} />
      )}

      {customEditor && (
        <EditorModal
          state={customEditor}
          existingIds={existingProviderIds
            .filter((id) => id.startsWith('custom:'))
            .map((id) => id.slice(7))}
          onChange={setCustomEditor}
          onSave={handleSaveCustom}
          onClose={() => setCustomEditor(null)}
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

      {oauthFlow && (
        <OAuthModal
          providerName={oauthFlow.providerName}
          authUrl={oauthFlow.authUrl}
          userCode={oauthFlow.userCode}
          verificationUri={oauthFlow.verificationUri}
          onCancel={handleOAuthCancel}
          onComplete={handleOAuthComplete}
        />
      )}
    </>
  );
}
