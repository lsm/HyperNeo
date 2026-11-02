import { useState } from 'preact/hooks';
import type { DriverHealth } from '@hyperneo/shared/types/settings';
import { globalSettings } from '../../lib/state.ts';
import { connectionManager } from '../../lib/connection-manager';
import { invokeOperation } from '../../lib/operations.ts';
import { Button } from '../ui/Button.tsx';
import { SettingsSection } from './SettingsSection.tsx';

const names: Record<string, string> = {
  hyperneo: 'HyperNeo',
  'codex-desktop': 'Codex Desktop',
  'claude-desktop': 'Claude Desktop',
  'claude-code': 'Claude Code',
  'copilot-cli': 'Copilot',
};

export function DriverHealthSettings() {
  const [latest, setLatest] = useState<Record<string, DriverHealth> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const health = latest ?? globalSettings.value?.driverHealth ?? {};
  async function check() {
    setBusy(true);
    setError('');
    try {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) throw new Error('Reconnect to check worker clients.');
      const result = await invokeOperation<{ ok: true; health: Record<string, DriverHealth> }>(
        hub,
        'work.health',
        { action: 'check' },
        { timeout: 60_000 }
      );
      setLatest(result.health);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not check worker clients.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <SettingsSection
      title="Worker client health"
      description="Checked when HyperNeo starts and once a day. Newer unverified versions remain usable when their health is available."
      actions={
        <Button disabled={busy} onClick={check}>
          {busy ? 'Checking…' : 'Check now'}
        </Button>
      }
    >
      {error && (
        <p role="alert" class="text-sm text-danger">
          {error}
        </p>
      )}
      {!Object.keys(health).length && (
        <p class="text-sm text-fg-faint">Health checks are starting.</p>
      )}
      {Object.entries(health).map(([id, result]) => (
        <div key={id} class="space-y-1 py-3 border-b border-line">
          <div class="text-sm font-semibold">
            {names[id] ?? id}{' '}
            <span class="font-normal text-fg-faint">
              {result.status === 'ok'
                ? 'Available'
                : result.status === 'degraded'
                  ? 'Needs attention'
                  : 'Unavailable'}
            </span>
          </div>
          <p class="text-sm text-fg-soft">{result.reason}</p>
          <p class="text-xs text-fg-faint">
            {Object.entries(result.clientVersions)
              .map(([name, version]) => `${name} ${version}`)
              .join(' · ')}
          </p>
          {result.unverifiedVersion && <p class="text-xs text-warning">Unverified version</p>}
          <p class="text-xs text-fg-faint">
            Checked {new Date(result.checkedAt).toLocaleString()}
            {result.verifiedVersions
              ? ` · Verified ${Object.values(result.verifiedVersions).join(' / ')}`
              : ''}
          </p>
        </div>
      ))}
    </SettingsSection>
  );
}
