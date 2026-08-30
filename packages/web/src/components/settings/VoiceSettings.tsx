import { useEffect, useRef, useState } from 'preact/hooks';
import type { VoiceSettings as VoiceSettingsConfig } from '@hyperneo/shared';
import { globalSettings } from '../../lib/state.ts';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { connectionManager } from '../../lib/connection-manager.ts';
import { toast } from '../../lib/toast.ts';
import { SettingsRow, SettingsSection, SettingsToggle } from './SettingsSection.tsx';

const DEFAULT_VOICE: VoiceSettingsConfig = {
  enabled: false,
  endpoint: '',
  model: '',
  allowInsecureTls: false,
  allowPrivateNetwork: false,
};

const PRESETS = {
  openai: {
    endpoint: 'https://api.openai.com/v1/audio/transcriptions',
    model: 'whisper-1',
    allowInsecureTls: false,
    allowPrivateNetwork: false,
  },
  local: {
    endpoint: '',
    model: '',
  },
};

export function VoiceSettings() {
  const settings = globalSettings.value?.voice ?? DEFAULT_VOICE;
  const [draft, setDraft] = useState<VoiceSettingsConfig>(settings);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const pendingSaveRef = useRef<Promise<void>>(Promise.resolve());
  const lastSaveFailedRef = useRef(false);

  useEffect(() => {
    setDraft(globalSettings.value?.voice ?? DEFAULT_VOICE);
  }, [settings]);

  const save = async (next: VoiceSettingsConfig, options?: { silent?: boolean }) => {
    const { hasApiKey: _omitHasApiKey, ...payload } = next;
    setDraft(next);
    if (next.apiKey?.trim()) {
      setDraft((d) => ({ ...d, apiKey: '' }));
    }
    if (!options?.silent) setSaving(true);
    const run = async () => {
      try {
        await updateGlobalSettings({ voice: payload }, { timeout: 120_000 });
        lastSaveFailedRef.current = false;
      } catch (error) {
        setDraft(globalSettings.value?.voice ?? DEFAULT_VOICE);
        toast.error(error instanceof Error ? error.message : 'Failed to save voice settings');
        lastSaveFailedRef.current = true;
      } finally {
        if (!options?.silent) setSaving(false);
      }
    };
    pendingSaveRef.current = pendingSaveRef.current.then(run, run);
    return pendingSaveRef.current;
  };

  const patch = (updates: Partial<VoiceSettingsConfig>) => {
    void save({ ...draft, ...updates });
  };

  const removeKey = async () => {
    setSaving(true);
    try {
      await updateGlobalSettings(
        { voice: { ...draft, hasApiKey: false, apiKey: undefined } },
        { timeout: 120_000 }
      );
      setDraft({ ...draft, hasApiKey: false, apiKey: undefined });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove voice key');
    } finally {
      setSaving(false);
    }
  };

  const patchOnBlur = (field: 'endpoint' | 'model') => {
    const current = draft[field]?.trim() ?? '';
    if (current === (settings[field] ?? '').trim()) return;
    void save({ ...draft, [field]: current } as VoiceSettingsConfig, { silent: true });
  };

  const applyPreset = (preset: keyof typeof PRESETS) => {
    patch(PRESETS[preset]);
  };

  const testConnection = async () => {
    if (testing) return;
    setTesting(true);
    try {
      await pendingSaveRef.current;
    } catch {}
    if (lastSaveFailedRef.current) {
      setTesting(false);
      return;
    }
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected');
      setTesting(false);
      return;
    }
    try {
      await hub.request('voice.testConnection', {}, { timeout: 65_000 });
      toast.success('Voice transcription connection succeeded');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Voice transcription connection failed');
    } finally {
      setTesting(false);
    }
  };

  return (
    <SettingsSection title="Voice Input">
      <SettingsRow
        label="Enable voice input"
        description="Show a mic button in the composer and transcribe recorded WAV audio."
      >
        <SettingsToggle
          checked={draft.enabled}
          onChange={(enabled) => patch({ enabled })}
          disabled={saving}
        />
      </SettingsRow>

      <SettingsRow label="Preset" description="Prefill endpoint and model for common backends.">
        <div class="flex gap-2">
          <button
            type="button"
            onClick={() => applyPreset('openai')}
            disabled={saving}
            class="rounded-lg border border-line px-3 py-1.5 text-sm text-fg-soft hover:bg-fill-soft disabled:cursor-not-allowed disabled:opacity-50"
          >
            OpenAI
          </button>
          <button
            type="button"
            onClick={() => applyPreset('local')}
            disabled={saving}
            class="rounded-lg border border-line px-3 py-1.5 text-sm text-fg-soft hover:bg-fill-soft disabled:cursor-not-allowed disabled:opacity-50"
          >
            Local / custom
          </button>
        </div>
      </SettingsRow>

      <SettingsRow
        label="Endpoint"
        description="Full URL to /v1/audio/transcriptions."
        layout="stacked"
      >
        <input
          type="url"
          value={draft.endpoint}
          disabled={saving}
          onInput={(event) => setDraft({ ...draft, endpoint: event.currentTarget.value })}
          onBlur={() => patchOnBlur('endpoint')}
          placeholder="https://api.openai.com/v1/audio/transcriptions"
          class="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg-soft focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </SettingsRow>

      <SettingsRow label="Model" description="Model names vary by backend." layout="stacked">
        <input
          type="text"
          value={draft.model}
          disabled={saving}
          onInput={(event) => setDraft({ ...draft, model: event.currentTarget.value })}
          onBlur={() => patchOnBlur('model')}
          placeholder="whisper-1"
          class="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg-soft focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
        />
      </SettingsRow>

      <SettingsRow
        label="API key"
        description="Optional. Leave blank for local backends that do not require Authorization."
        layout="stacked"
      >
        <div class="space-y-2">
          <input
            type="password"
            value={draft.apiKey ?? ''}
            disabled={saving}
            onInput={(event) => setDraft({ ...draft, apiKey: event.currentTarget.value })}
            onBlur={() => {
              const apiKey = draft.apiKey?.trim();
              if (apiKey) void save({ ...draft, apiKey }, { silent: true });
            }}
            placeholder="sk-..."
            class="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg-soft focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
          {draft.hasApiKey &&
            !draft.apiKey &&
            (() => {
              const normalizeEndpoint = (url: string) => {
                try {
                  return new URL(url.trim()).toString();
                } catch {
                  return url.trim();
                }
              };
              const keyScopedElsewhere =
                draft.apiKeyEndpoint &&
                draft.endpoint.trim() &&
                normalizeEndpoint(draft.apiKeyEndpoint) !== normalizeEndpoint(draft.endpoint);
              return (
                <div class="flex items-center justify-between gap-3">
                  <div class={keyScopedElsewhere ? 'text-xs text-warning' : 'text-xs text-success'}>
                    {keyScopedElsewhere
                      ? 'Saved key is scoped to a different endpoint. Re-enter it for this endpoint.'
                      : 'Key saved. Enter a new key to replace it.'}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      void removeKey();
                    }}
                    disabled={saving}
                    class="rounded-md border border-red-400/30 px-2 py-1 text-xs text-danger-soft hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Remove key
                  </button>
                </div>
              );
            })()}
        </div>
      </SettingsRow>

      <SettingsRow
        label="Allow insecure TLS"
        description="Only enable for trusted self-signed local gateways."
      >
        <SettingsToggle
          checked={draft.allowInsecureTls ?? false}
          onChange={(allowInsecureTls) => patch({ allowInsecureTls })}
          disabled={saving}
        />
      </SettingsRow>

      <SettingsRow
        label="Allow private/LAN endpoints"
        description="Only enable for trusted local ASR servers on private networks."
      >
        <SettingsToggle
          checked={draft.allowPrivateNetwork ?? false}
          onChange={(allowPrivateNetwork) => patch({ allowPrivateNetwork })}
          disabled={saving}
        />
      </SettingsRow>

      <SettingsRow label="Test connection" description="Sends a short silent WAV to the backend.">
        <button
          type="button"
          onClick={() => {
            void testConnection();
          }}
          disabled={testing || saving || !draft.enabled}
          class="rounded-lg bg-accent-hover px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      </SettingsRow>
    </SettingsSection>
  );
}
