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
      if (!hub) throw new Error('Reconnect before changing fast replies.');
      const result = await invokeOperation<{ ok: boolean }>(hub, 'neo.front.set', { enabled });
      if (!result.ok) throw new Error('Could not save fast replies.');
    } catch {
      setError('Could not save fast reply settings.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <section class="mt-4 rounded-xl border border-line bg-surface p-4">
      <label class="flex items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={neo?.front?.enabled === true}
          disabled={saving}
          onChange={(event) => save(event.currentTarget.checked)}
        />
        Fast replies for text and voice
      </label>
      {error ? (
        <p role="alert" class="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
