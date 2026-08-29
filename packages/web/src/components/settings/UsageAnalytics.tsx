import { useCallback, useEffect, useState } from 'preact/hooks';
import { connectionManager } from '../../lib/connection-manager.ts';
import { formatTokens } from '../../lib/utils.ts';
import { SettingsSection } from './SettingsSection.tsx';

interface SessionCostEntry {
  id: string;
  title: string;
  cost: number;
  tokens: number;
  messages: number;
}

interface DailyCost {
  date: string;
  cost: number;
}

interface UsageData {
  totalCost: number;
  totalTokens: number;
  totalMessages: number;
  sessionCount: number;
  topSessions: SessionCostEntry[];
  dailyCosts: DailyCost[];
}

function StatCard({ label, value, subtext }: { label: string; value: string; subtext?: string }) {
  return (
    <div class="bg-fill-soft border border-line rounded-lg p-4">
      <div class="text-xs text-fg-muted mb-1">{label}</div>
      <div class="text-xl font-semibold text-fg">{value}</div>
      {subtext && <div class="text-xs text-fg-faint mt-1">{subtext}</div>}
    </div>
  );
}

function CostBar({ maxCost, entry }: { maxCost: number; entry: SessionCostEntry }) {
  const width = maxCost > 0 ? (entry.cost / maxCost) * 100 : 0;
  return (
    <div class="flex items-center gap-3 py-1.5">
      <div class="flex-1 min-w-0">
        <div class="text-xs text-fg-soft truncate">{entry.title}</div>
        <div class="mt-1 h-2 bg-fill-strong rounded-full overflow-hidden">
          <div
            class="h-full bg-success/60 rounded-full transition-all"
            style={{ width: `${width}%` }}
          />
        </div>
      </div>
      <div class="text-xs font-mono text-success flex-shrink-0 w-20 text-right">
        ${entry.cost.toFixed(4)}
      </div>
    </div>
  );
}

function DailyChart({ dailyCosts }: { dailyCosts: DailyCost[] }) {
  if (dailyCosts.length === 0) {
    return <div class="text-xs text-fg-faint text-center py-4">No cost data available</div>;
  }

  const maxDailyCost = Math.max(...dailyCosts.map((d) => d.cost));

  return (
    <div class="flex items-end gap-1 h-24">
      {dailyCosts.map((day) => {
        const height = maxDailyCost > 0 ? (day.cost / maxDailyCost) * 100 : 0;
        const dateLabel = day.date.slice(5);
        return (
          <div key={day.date} class="flex-1 flex flex-col items-center gap-1">
            <div class="w-full flex items-end justify-center" style={{ height: '80px' }}>
              <div
                class="w-full max-w-[20px] bg-accent/50 rounded-t transition-all hover:bg-accent/80"
                style={{ height: `${Math.max(height, 2)}%` }}
                title={`${dateLabel}: $${day.cost.toFixed(4)}`}
              />
            </div>
            <div class="text-[9px] text-fg-faint whitespace-nowrap">{dateLabel}</div>
          </div>
        );
      })}
    </div>
  );
}

export function UsageAnalytics() {
  const [data, setData] = useState<UsageData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchUsage = useCallback(async () => {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;

    setLoading(true);
    try {
      const result = await hub.request<UsageData>('usage.calculate', {});
      setData(result);
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  return (
    <div class="space-y-6">
      <div class="flex items-center justify-between">
        <div>
          <h3 class="text-sm font-medium text-fg-soft">Usage Analytics</h3>
          <p class="text-xs text-fg-faint">Pre-calculated from session data</p>
        </div>
        <button
          type="button"
          onClick={fetchUsage}
          disabled={loading}
          class="flex items-center gap-1.5 rounded-lg border border-line bg-surface-raised px-2.5 py-1.5 text-xs text-fg-soft transition-colors hover:border-line-strong hover:bg-fill-strong hover:text-fg disabled:opacity-50"
        >
          <svg
            class={`w-3 h-3 ${loading ? 'animate-spin' : ''}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          Recalculate
        </button>
      </div>

      {!data && loading && <div class="text-xs text-fg-faint text-center py-8">Calculating...</div>}

      {!data && !loading && (
        <div class="text-xs text-fg-faint text-center py-8">No data available</div>
      )}

      {data && (
        <>
          <SettingsSection title="Overview">
            <div class="grid grid-cols-3 gap-3">
              <StatCard
                label="Total Cost"
                value={`$${data.totalCost.toFixed(2)}`}
                subtext={`${data.sessionCount} sessions`}
              />
              <StatCard
                label="Total Tokens"
                value={formatTokens(data.totalTokens)}
                subtext={`${data.totalMessages} messages`}
              />
              <StatCard
                label="Avg Cost / Session"
                value={`$${data.sessionCount > 0 ? (data.totalCost / data.sessionCount).toFixed(4) : '0.00'}`}
              />
            </div>
          </SettingsSection>

          <SettingsSection title="Daily Cost (Last 14 Days)">
            <DailyChart dailyCosts={data.dailyCosts} />
          </SettingsSection>

          <SettingsSection title="Top Sessions by Cost">
            {data.topSessions.length === 0 ? (
              <div class="text-xs text-fg-faint text-center py-4">No session cost data yet</div>
            ) : (
              <div class="space-y-1">
                {data.topSessions.map((entry) => (
                  <CostBar key={entry.id} entry={entry} maxCost={data.topSessions[0].cost} />
                ))}
              </div>
            )}
          </SettingsSection>
        </>
      )}
    </div>
  );
}
