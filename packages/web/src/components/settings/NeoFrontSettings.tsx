import { t } from '../../lib/i18n/index.ts';
import { useState } from 'preact/hooks';
import { globalSettings } from '../../lib/state.ts';
import { connectionManager } from '../../lib/connection-manager';
import { invokeOperation } from '../../lib/operations.ts';

export function NeoFrontSettings() {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const neo = globalSettings.value?.neo;
  async function save(enabled: boolean) {
    setSaving(true);
    setError('');
    try {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) throw new Error(t('dual.reconnect'));
      const result = await invokeOperation<{ ok: boolean }>(hub, 'neo.front.set', { enabled });
      if (!result.ok) throw new Error(t('dual.saveError'));
    } catch {
      setError(t('dual.saveError'));
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <label class="flex cursor-pointer items-center justify-between gap-5 rounded-xl border border-line bg-surface px-4 py-4 sm:px-5">
        <span class="min-w-0">
          <span class="block text-sm font-medium text-fg">{t('dual.label')}</span>
          <span class="mt-1 block text-xs leading-relaxed text-fg-muted">
            {t('dual.description')}
          </span>
        </span>
        <span class="relative inline-flex shrink-0">
          <input
            class="peer absolute inset-0 z-10 h-full w-full cursor-pointer opacity-0"
            aria-label={t('dual.label')}
            type="checkbox"
            checked={neo?.front?.enabled === true}
            disabled={saving}
            onChange={(event) => save(event.currentTarget.checked)}
          />
          <span
            aria-hidden="true"
            class="h-6 w-10 rounded-full bg-fill-strong transition-colors peer-checked:bg-accent peer-focus-visible:ring-2 peer-focus-visible:ring-accent peer-disabled:opacity-50"
          />
          <span
            aria-hidden="true"
            class="pointer-events-none absolute left-1 top-1 h-4 w-4 rounded-full bg-fg transition-transform peer-checked:translate-x-4 peer-checked:bg-surface"
          />
        </span>
      </label>
      {error ? (
        <p role="alert" class="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}
