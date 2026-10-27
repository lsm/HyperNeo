import type { VoiceSettings as VoiceSettingsConfig } from '@hyperneo/shared';
import { useEffect, useRef, useState } from 'preact/hooks';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { connectionManager } from '../../lib/connection-manager.ts';
import { globalSettings } from '../../lib/state.ts';
import { toast } from '../../lib/toast.ts';
import {
  getVoiceLanguage,
  setVoiceLanguage,
  type VoiceLanguage,
} from '../../lib/voice/voice-language.ts';
import { FORM_CONTROL_CLASS } from '../ui/FormField.tsx';
import { SettingsGroup, SettingsRow, SettingsSection, SettingsToggle } from './SettingsSection.tsx';

const DEFAULT_VOICE: VoiceSettingsConfig = {
  enabled: false,
  endpoint: '',
  streamEndpoint: '',
  model: '',
  allowInsecureTls: false,
  allowPrivateNetwork: false,
};

const PRESETS = {
  openai: {
    endpoint: 'https://api.openai.com/v1/audio/transcriptions',
    streamEndpoint: '',
    model: 'whisper-1',
    allowInsecureTls: false,
    allowPrivateNetwork: false,
  },
  local: {
    endpoint: '',
    streamEndpoint: '',
    model: '',
  },
};

export function VoiceSettings() {
  const [language, updateLanguage] = useState(getVoiceLanguage);
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

  const patchOnBlur = (field: 'endpoint' | 'streamEndpoint' | 'model') => {
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
      <SettingsGroup>
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

        <SettingsRow
          label="Live transcription language"
          description="Saved in this browser. Applies to the next live ASR connection only, excluding batch transcription and fallback. Auto keeps server defaults."
        >
          <select
            aria-label="Live transcription language"
            value={language}
            onChange={(event) => {
              const next = event.currentTarget.value as VoiceLanguage;
              try {
                setVoiceLanguage(next);
                updateLanguage(next);
              } catch {
                toast.error('Could not save voice language in this browser');
              }
            }}
            class={FORM_CONTROL_CLASS}
          >
            <option value="auto">Auto</option>
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select>
        </SettingsRow>

        <SettingsRow label="Preset" description="Prefill endpoint and model for common backends.">
          <div class="flex gap-2">
            <button
              type="button"
              onClick={() => applyPreset('openai')}
              disabled={saving}
              class="rounded-md border border-line px-2.5 py-1 text-xs text-fg-soft transition-colors hover:bg-fill-soft hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              OpenAI
            </button>
            <button
              type="button"
              onClick={() => applyPreset('local')}
              disabled={saving}
              class="rounded-md border border-line px-2.5 py-1 text-xs text-fg-soft transition-colors hover:bg-fill-soft hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
            >
              Local / custom
            </button>
          </div>
        </SettingsRow>

        <SettingsRow
          label="Batch endpoint"
          description="Full HTTP or HTTPS URL for batch transcription. Used exactly as entered."
          layout="stacked"
        >
          <input
            type="url"
            aria-label="Batch endpoint"
            value={draft.endpoint}
            disabled={saving}
            onInput={(event) => setDraft({ ...draft, endpoint: event.currentTarget.value })}
            onBlur={() => patchOnBlur('endpoint')}
            placeholder="https://api.openai.com/v1/audio/transcriptions"
            class={FORM_CONTROL_CLASS}
          />
        </SettingsRow>

        <SettingsRow
          label="Live endpoint"
          description="Full WebSocket URL for live transcription. Leave empty for batch only."
          layout="stacked"
        >
          <input
            type="url"
            aria-label="Live endpoint"
            value={draft.streamEndpoint ?? ''}
            disabled={saving}
            onInput={(event) => setDraft({ ...draft, streamEndpoint: event.currentTarget.value })}
            onBlur={() => patchOnBlur('streamEndpoint')}
            placeholder="wss://asr.example.com/v1/listen"
            class={FORM_CONTROL_CLASS}
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
            class={FORM_CONTROL_CLASS}
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
              class={FORM_CONTROL_CLASS}
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
                    <div
                      class={keyScopedElsewhere ? 'text-xs text-warning' : 'text-xs text-success'}
                    >
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
                      class="rounded-md border border-danger/40 px-2 py-1 text-xs text-danger-soft transition-colors hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
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
            class="rounded-md bg-accent-hover px-2.5 py-1 text-xs font-medium text-accent-fg transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
          >
            {testing ? 'Testing…' : 'Test connection'}
          </button>
        </SettingsRow>
      </SettingsGroup>
    </SettingsSection>
  );
}
