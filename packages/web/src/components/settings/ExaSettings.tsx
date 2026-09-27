import { useEffect, useState } from 'preact/hooks';
import type { ExaSettings as ExaSettingsConfig } from '@hyperneo/shared';
import { globalSettings } from '../../lib/state.ts';
import { updateGlobalSettings } from '../../lib/api-helpers.ts';
import { toast } from '../../lib/toast.ts';
import { SettingsRow, SettingsSection, SettingsToggle } from './SettingsSection.tsx';

const DEFAULT_EXA: ExaSettingsConfig = {
  enabled: false,
};

export function ExaSettings() {
  const settings = globalSettings.value?.exa ?? DEFAULT_EXA;
  const [draft, setDraft] = useState<ExaSettingsConfig>(settings);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(globalSettings.value?.exa ?? DEFAULT_EXA);
  }, [settings]);

  const save = async (next: ExaSettingsConfig) => {
    const { hasApiKey: _omitHasApiKey, ...payload } = next;
    setDraft(next);
    if (next.apiKey?.trim()) {
      setDraft((d) => ({ ...d, apiKey: '' }));
    }
    setSaving(true);
    try {
      await updateGlobalSettings({ exa: payload }, { timeout: 120_000 });
    } catch (error) {
      setDraft(globalSettings.value?.exa ?? DEFAULT_EXA);
      toast.error(error instanceof Error ? error.message : 'Failed to save Exa settings');
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async () => {
    setSaving(true);
    try {
      await updateGlobalSettings(
        { exa: { ...draft, hasApiKey: false, apiKey: undefined } },
        { timeout: 120_000 }
      );
      setDraft({ ...draft, hasApiKey: false, apiKey: undefined });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to remove Exa API key');
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection title="Exa Web Search">
      <SettingsRow
        label="Enable Exa web search"
        description="Replace the built-in WebSearch/WebFetch tools with Exa's search MCP for providers that don't support them natively (anything other than Anthropic and z.ai/GLM)."
      >
        <SettingsToggle
          checked={draft.enabled}
          onChange={(enabled) => void save({ ...draft, enabled })}
          disabled={saving}
        />
      </SettingsRow>

      <SettingsRow
        label="API key"
        description="From dashboard.exa.ai. Exa offers a free monthly credit tier that covers typical personal usage. If the daemon runs with EXA_API_KEY set, that key is used as a fallback."
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
              if (apiKey) void save({ ...draft, apiKey });
            }}
            placeholder="exa-..."
            class="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-sm text-fg-soft focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
          />
          {draft.hasApiKey && !draft.apiKey && (
            <div class="flex items-center justify-between gap-3">
              <div class="text-xs text-success">Key saved. Enter a new key to replace it.</div>
              <button
                type="button"
                onClick={() => {
                  void removeKey();
                }}
                disabled={saving}
                class="rounded-md border border-danger/30 px-2 py-1 text-xs text-danger-soft hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                Remove key
              </button>
            </div>
          )}
        </div>
      </SettingsRow>

      <SettingsRow
        label="How it works"
        description="When a session uses a provider without native web tools, the built-in WebSearch and WebFetch are hidden and an Exa MCP server (web_search_exa, web_fetch_exa) is attached instead. Anthropic and GLM sessions are unaffected."
        layout="stacked"
      >
        <div />
      </SettingsRow>
    </SettingsSection>
  );
}
