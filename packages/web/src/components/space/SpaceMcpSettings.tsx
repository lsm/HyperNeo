import { useSignalEffect } from '@preact/signals';
import { useMemo, useState } from 'preact/hooks';
import type { McpImportsRefreshResponse, SpaceMcpEntry } from '@hyperneo/shared';
import { spaceMcpStore } from '../../lib/space-mcp-store.ts';
import { connectionManager } from '../../lib/connection-manager.ts';
import { toast } from '../../lib/toast.ts';
import { Spinner } from '../ui/Spinner.tsx';
import { Button } from '../ui/Button.tsx';
import { SettingsSection, SettingsToggle } from '../settings/SettingsSection.tsx';

interface SpaceMcpSettingsProps {
  spaceId: string;
  disabled?: boolean;
}

type GroupKey = 'builtin' | 'user' | 'imported';

const GROUP_LABELS: Record<GroupKey, string> = {
  builtin: 'Built-in',
  user: 'Added in HyperNeo',
  imported: 'Imported from .mcp.json',
};

const GROUP_ORDER: GroupKey[] = ['builtin', 'user', 'imported'];

function sourceTypeLabel(sourceType: string): string {
  switch (sourceType) {
    case 'stdio':
      return 'stdio';
    case 'sse':
      return 'SSE';
    case 'http':
      return 'HTTP';
    default:
      return sourceType;
  }
}

export function SpaceMcpSettings({ spaceId, disabled = false }: SpaceMcpSettingsProps) {
  const [refreshing, setRefreshing] = useState(false);

  useSignalEffect(() => {
    spaceMcpStore.subscribe(spaceId).catch((err) => {
      // eslint-disable-next-line no-console
      toast.error(
        `Failed to load MCP servers: ${err instanceof Error ? err.message : String(err)}`
      );
    });
    return () => {
      spaceMcpStore.unsubscribe();
    };
  });

  const entriesMap = spaceMcpStore.entries.value;
  const loading = spaceMcpStore.loading.value;

  const grouped = useMemo(() => {
    const out: Record<GroupKey, SpaceMcpEntry[]> = {
      builtin: [],
      user: [],
      imported: [],
    };
    for (const entry of entriesMap.values()) {
      const key: GroupKey =
        entry.source === 'builtin' ? 'builtin' : entry.source === 'imported' ? 'imported' : 'user';
      out[key].push(entry);
    }
    for (const key of GROUP_ORDER) {
      out[key].sort((a, b) => a.name.localeCompare(b.name));
    }
    return out;
  }, [entriesMap]);

  const totalEntries = entriesMap.size;

  async function handleToggle(entry: SpaceMcpEntry, nextEnabled: boolean): Promise<void> {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    try {
      await hub.request('space.mcp.setEnabled', {
        spaceId,
        serverId: entry.serverId,
        enabled: nextEnabled,
      });
    } catch (err) {
      toast.error(
        `Failed to ${nextEnabled ? 'enable' : 'disable'} ${entry.name}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  async function handleClearOverride(entry: SpaceMcpEntry): Promise<void> {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    try {
      await hub.request('space.mcp.clearOverride', {
        spaceId,
        serverId: entry.serverId,
      });
      toast.success(`${entry.name} now follows the global default`);
    } catch (err) {
      toast.error(
        `Failed to reset ${entry.name}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async function handleRefreshImports(): Promise<void> {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) {
      toast.error('Not connected to server');
      return;
    }
    try {
      setRefreshing(true);
      const result = await hub.request<McpImportsRefreshResponse>('mcp.imports.refresh', {});
      const summary =
        result.imported > 0 || result.removed > 0
          ? `Refreshed: ${result.imported} imported, ${result.removed} removed`
          : 'No changes from .mcp.json scan';
      toast.success(summary);
      for (const note of result.notes) {
        toast.info(note);
      }
    } catch (err) {
      toast.error(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <SettingsSection
      title="Tools"
      description="Enable or disable MCP servers for tasks spawned in this space. Each toggle overrides the global default. Changes apply to new sessions; already-running tasks keep the MCP set they started with."
      actions={
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={refreshing}
          disabled={disabled || refreshing}
          onClick={handleRefreshImports}
          data-testid="space-mcp-refresh-imports"
        >
          Refresh imports
        </Button>
      }
    >
      <div data-testid="space-mcp-settings">
        {loading && totalEntries === 0 ? (
          <div class="flex items-center gap-2 py-2">
            <Spinner size="sm" />
            <span class="text-xs text-fg-muted">Loading MCP servers…</span>
          </div>
        ) : totalEntries === 0 ? (
          <div class="st-group">
            <div class="st-empty">
              <p class="st-empty-title">No MCP servers configured</p>
              <p class="st-empty-desc">
                Add one in global MCP settings, or drop a .mcp.json into the space workspace and
                press Refresh imports.
              </p>
            </div>
          </div>
        ) : (
          GROUP_ORDER.map((groupKey) => {
            const group = grouped[groupKey];
            if (group.length === 0) return null;
            return (
              <div key={groupKey}>
                <div class="st-group-cap">{GROUP_LABELS[groupKey]}</div>
                <div class="st-group">
                  {group.map((entry) => (
                    <SpaceMcpEntryRow
                      key={entry.serverId}
                      entry={entry}
                      disabled={disabled}
                      onToggle={(next) => handleToggle(entry, next)}
                      onClearOverride={() => handleClearOverride(entry)}
                    />
                  ))}
                </div>
              </div>
            );
          })
        )}
      </div>
    </SettingsSection>
  );
}

interface SpaceMcpEntryRowProps {
  entry: SpaceMcpEntry;
  disabled: boolean;
  onToggle: (next: boolean) => Promise<void>;
  onClearOverride: () => Promise<void>;
}

function SpaceMcpEntryRow({ entry, disabled, onToggle, onClearOverride }: SpaceMcpEntryRowProps) {
  const badges: Array<{ label: string; tone: 'override' | 'muted' | 'info' }> = [];
  if (entry.overridden) {
    badges.push({ label: 'space override', tone: 'override' });
  }
  if (!entry.overridden && !entry.globallyEnabled) {
    badges.push({ label: 'disabled globally', tone: 'muted' });
  }
  if (entry.source === 'imported') {
    badges.push({ label: 'imported', tone: 'info' });
  }

  return (
    <div
      class={disabled ? 'st-trow opacity-60' : 'st-trow'}
      data-testid={`space-mcp-entry-${entry.name}`}
    >
      <div class="st-trow-body">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="st-trow-name">{entry.name}</span>
          {badges.map((b) => (
            <span
              key={b.label}
              class={
                b.tone === 'override'
                  ? 'st-chip st-chip-accent'
                  : b.tone === 'info'
                    ? 'st-chip st-chip-warn'
                    : 'st-chip'
              }
            >
              {b.label}
            </span>
          ))}
        </div>
        {entry.description && <p class="st-trow-desc">{entry.description}</p>}
        <p class="mt-0.5 font-mono text-[11px] text-fg-faint">
          {sourceTypeLabel(entry.sourceType)}
          {entry.source === 'imported' && entry.sourcePath ? ` — ${entry.sourcePath}` : ''}
        </p>
      </div>
      <span class="st-trow-acts">
        {entry.overridden && (
          <button
            type="button"
            class="st-act"
            onClick={() => onClearOverride()}
            disabled={disabled}
            data-testid={`space-mcp-reset-${entry.name}`}
            title="Reset to the global default"
          >
            Reset
          </button>
        )}
        <SettingsToggle
          checked={entry.enabled}
          disabled={disabled}
          onChange={(next) => onToggle(next)}
          data-testid={`space-mcp-toggle-${entry.name}`}
        />
      </span>
    </div>
  );
}
