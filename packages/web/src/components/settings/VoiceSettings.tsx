import { useEffect, useState } from 'preact/hooks';
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

  useEffect(() => {
    setDraft(globalSettings.value?.voice ?? DEFAULT_VOICE);
  }, [settings]);

  const save = async (next: VoiceSettingsConfig) => {
    setDraft(next);
    setSaving(true);
    try {
      // hasApiKey is server-owned (the daemon projects it). Sending the
      // projected `false` back would otherwise be read as a credential-clear on
      // every ordinary voice edit, so omit it; only an explicit Remove-key
      // signals removal.
      const { hasApiKey: _omitHasApiKey, ...payload } = next;
      await updateGlobalSettings({ voice: payload }, { timeout: 50_000 });
    } catch (error) {
      // Roll back to the last server-backed values so the panel does not keep
      // showing unsaved/optimistic state that a later edit could resubmit.
      setDraft(globalSettings.value?.voice ?? DEFAULT_VOICE);
      toast.error(error instanceof Error ? error.message : 'Failed to save voice settings');
    } finally {
      setSaving(false);
    }
  };

  const patch = (updates: Partial<VoiceSettingsConfig>) => {
    void save({ ...draft, ...updates });
  };

  // Explicit credential removal: send the current voice block with hasApiKey
  // cleared. Ordinary saves omit hasApiKey (server-owned), so only this path
  // signals a delete to the daemon.
  const removeKey = async () => {
    setSaving(true);
    try {
      await updateGlobalSettings(
        { voice: { ...draft, hasApiKey: false, apiKey: undefined } },
        { timeout: 50_000 }
      );
      setDraft({ ...draft, hasApiKey: false, apiKey: undefined });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove voice key');
    } finally {
      setSaving(false);
    }
  };

  // Only persist on blur when the trimmed value actually changed; otherwise a
  // plain focus/blur (e.g. before clicking another control) triggers a
  // redundant save that disables the panel mid-click.
  const patchOnBlur = (field: 'endpoint' | 'model') => {
    const current = draft[field]?.trim() ?? '';
    if (current === (settings[field] ?? '').trim()) return;
    patch({ [field]: current } as Partial<VoiceSettingsConfig>);
  };

  const applyPreset = (preset: keyof typeof PRESETS) => {
    patch(PRESETS[preset]);
  };

  const testConnection = async () => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected');
      return;
    }
    setTesting(true);
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
            class="rounded-lg border border-white/[0.08] px-3 py-1.5 text-sm text-gray-200 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
          >
            OpenAI
          </button>
          <button
            type="button"
            onClick={() => applyPreset('local')}
            disabled={saving}
            class="rounded-lg border border-white/[0.08] px-3 py-1.5 text-sm text-gray-200 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
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
          class="w-full rounded-lg border border-white/[0.08] bg-dark-800 px-3 py-2 text-sm text-gray-200 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
          class="w-full rounded-lg border border-white/[0.08] bg-dark-800 px-3 py-2 text-sm text-gray-200 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
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
              if (apiKey) patch({ apiKey });
            }}
            placeholder="sk-..."
            class="w-full rounded-lg border border-white/[0.08] bg-dark-800 px-3 py-2 text-sm text-gray-200 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          {draft.hasApiKey && !draft.apiKey && (
            <div class="flex items-center justify-between gap-3">
              <div class="text-xs text-emerald-400">Key saved. Enter a new key to replace it.</div>
              <button
                type="button"
                onClick={() => {
                  void removeKey();
                }}
                disabled={saving}
                class="rounded-md border border-red-400/30 px-2 py-1 text-xs text-red-300 hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Remove key
              </button>
            </div>
          )}
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
          class="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {testing ? 'Testing…' : 'Test connection'}
        </button>
      </SettingsRow>
    </SettingsSection>
  );
}
