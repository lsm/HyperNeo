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
      <label class="flex items-center gap-1 text-xs text-fg">
        <span>Front</span>
        <input
          aria-label={t('dual.label')}
          type="checkbox"
          checked={neo?.front?.enabled === true}
          disabled={saving}
          onChange={(event) => save(event.currentTarget.checked)}
        />
        <span title={t('dual.description')}>{t('dual.label')}</span>
      </label>
      {error ? (
        <p role="alert" class="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </>
  );
}
