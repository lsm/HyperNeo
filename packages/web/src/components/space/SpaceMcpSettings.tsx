import { useSignalEffect } from '@preact/signals';
import { useMemo, useState } from 'preact/hooks';
import type { McpImportsRefreshResponse, SpaceMcpEntry } from '@hyperneo/shared';
import { spaceMcpStore } from '../../lib/space-mcp-store.ts';
import { connectionManager } from '../../lib/connection-manager.ts';
import { toast } from '../../lib/toast.ts';
import { cn } from '../../lib/utils.ts';
import { Spinner } from '../ui/Spinner.tsx';
import { Button } from '../ui/Button.tsx';

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
    <section class="space-y-3" data-testid="space-mcp-settings">
      <div class="flex items-center justify-between">
        <h3 class="text-xs font-semibold text-fg-muted uppercase tracking-wider">MCP Servers</h3>
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
      </div>
      <p class="text-xs text-fg-muted">
        Enable or disable MCP servers for tasks spawned in this space. Each toggle overrides the
        global default. Changes apply to <strong>new</strong> sessions; already-running tasks keep
        the MCP set they started with.
      </p>

      {loading && totalEntries === 0 ? (
        <div class="flex items-center gap-2 py-2">
          <Spinner size="sm" />
          <span class="text-xs text-fg-muted">Loading MCP servers…</span>
        </div>
      ) : totalEntries === 0 ? (
        <div class="text-sm text-fg-muted bg-surface-raised border border-line rounded-lg px-3 py-3">
          No MCP servers configured. Add one in global MCP settings, or drop a
          <span class="font-mono mx-1">.mcp.json</span>
          into the space workspace and press <strong>Refresh imports</strong>.
        </div>
      ) : (
        <div class="space-y-4">
          {GROUP_ORDER.map((groupKey) => {
            const group = grouped[groupKey];
            if (group.length === 0) return null;
            return (
              <div key={groupKey} class="space-y-2">
                <div class="text-[11px] uppercase tracking-wider text-fg-muted">
                  {GROUP_LABELS[groupKey]}
                </div>
                <div class="space-y-2">
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
          })}
        </div>
      )}
    </section>
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
    <label
      class={cn(
        'flex items-start gap-3 bg-surface-raised border border-line-strong rounded-lg px-3 py-2.5 cursor-pointer hover:border-line-strong transition-colors',
        disabled && 'opacity-60 cursor-not-allowed'
      )}
      data-testid={`space-mcp-entry-${entry.name}`}
    >
      <input
        type="checkbox"
        checked={entry.enabled}
        disabled={disabled}
        onChange={async () => {
          await onToggle(!entry.enabled);
        }}
        class="w-4 h-4 mt-0.5 rounded border-line-strong bg-fill-strong text-accent focus:ring-accent focus:ring-offset-dark-900 cursor-pointer"
        data-testid={`space-mcp-toggle-${entry.name}`}
      />
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-sm font-medium text-fg-soft">{entry.name}</span>
          {badges.map((b) => (
            <span
              key={b.label}
              class={cn(
                'text-xs px-1.5 py-0.5 rounded',
                b.tone === 'override' && 'bg-accent/15 text-accent-soft',
                b.tone === 'muted' && 'bg-fill-strong text-fg-muted',
                b.tone === 'info' && 'bg-cat-purple/15 text-cat-purple'
              )}
            >
              {b.label}
            </span>
          ))}
        </div>
        {entry.description && (
          <p class="text-xs text-fg-muted mt-0.5 truncate">{entry.description}</p>
        )}
        <p class="text-xs text-fg-muted mt-0.5 font-mono">
          {sourceTypeLabel(entry.sourceType)}
          {entry.source === 'imported' && entry.sourcePath ? ` — ${entry.sourcePath}` : ''}
        </p>
        {entry.overridden && (
          <button
            type="button"
            class="text-xs text-fg-muted hover:text-fg-soft mt-1 disabled:opacity-40"
            onClick={async (e) => {
              e.preventDefault();
              e.stopPropagation();
              await onClearOverride();
            }}
            disabled={disabled}
            data-testid={`space-mcp-reset-${entry.name}`}
          >
            Reset to global default
          </button>
        )}
      </div>
    </label>
  );
}
