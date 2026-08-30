import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';

type ResultMessage = Extract<SDKMessage, { type: 'result' }>;

interface Props {
  result: ResultMessage;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const rem = Math.round(sec - min * 60);
  return rem === 0 ? `${min}m` : `${min}m ${rem}s`;
}

function formatTokens(n: number | undefined | null): string {
  if (n === undefined || n === null) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatCost(usd: number | undefined | null): string {
  if (usd === undefined || usd === null) return '$0.0000';
  return `$${usd.toFixed(4)}`;
}

export function ResultInfoDropdown({ result }: Props) {
  const isError = result.subtype !== 'success';
  const usage = (result as unknown as { usage?: Record<string, number | undefined> }).usage ?? {};
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const totalCost = (result as { total_cost_usd?: number }).total_cost_usd;
  const durationMs = (result as { duration_ms?: number }).duration_ms;
  const apiDurationMs = (result as { duration_api_ms?: number }).duration_api_ms;
  const numTurns = (result as { num_turns?: number }).num_turns;
  const stopReason = (result as { stop_reason?: string | null }).stop_reason;
  const errors = (result as { errors?: string[] }).errors;
  const modelUsage = (result as { modelUsage?: Record<string, unknown> }).modelUsage;

  const t = isError
    ? {
        bg: 'bg-warning/10',
        border: 'border-warning/40',
        headText: 'text-warning-soft',
        subText: 'text-warning',
        body: 'text-warning',
        bodyBg: 'bg-warning/15',
        icon: 'text-warning',
      }
    : {
        bg: 'bg-emerald-50 dark:bg-emerald-900/70',
        border: 'border-emerald-200 dark:border-emerald-800',
        headText: 'text-success-soft',
        subText: 'text-success',
        body: 'text-success',
        bodyBg: 'bg-emerald-100 dark:bg-emerald-900/30',
        icon: 'text-success',
      };

  return (
    <div
      class={`w-80 max-h-[60vh] overflow-y-scroll ${t.bg} rounded-lg border ${t.border} p-3 space-y-3 shadow-2xl backdrop-blur-sm`}
      data-testid="result-info-dropdown"
    >
      <div class={`flex items-center gap-2 pb-2 border-b ${t.border}`}>
        <svg class={`w-4 h-4 ${t.icon}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          {isError ? (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 9v2m0 4h.01M5.07 19h13.86a2 2 0 001.74-3L13.74 4a2 2 0 00-3.48 0L3.33 16a2 2 0 001.74 3z"
            />
          ) : (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          )}
        </svg>
        <div class="text-sm">
          <span class={`font-medium ${t.headText}`}>{isError ? 'Run Error' : 'Run Complete'}</span>
          <span class={`${t.subText} ml-2`}>{result.subtype}</span>
        </div>
      </div>

      <div>
        <div class={`text-xs font-medium ${t.headText} mb-1`}>Usage</div>
        <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <div class="flex justify-between">
            <span class={t.subText}>Input</span>
            <span class={`font-mono ${t.body}`}>{formatTokens(inputTokens)}</span>
          </div>
          <div class="flex justify-between">
            <span class={t.subText}>Output</span>
            <span class={`font-mono ${t.body}`}>{formatTokens(outputTokens)}</span>
          </div>
          {cacheRead > 0 && (
            <div class="flex justify-between">
              <span class={t.subText}>Cache read</span>
              <span class={`font-mono ${t.body}`}>{formatTokens(cacheRead)}</span>
            </div>
          )}
          {cacheCreate > 0 && (
            <div class="flex justify-between">
              <span class={t.subText}>Cache write</span>
              <span class={`font-mono ${t.body}`}>{formatTokens(cacheCreate)}</span>
            </div>
          )}
        </div>
      </div>

      <div>
        <div class={`text-xs font-medium ${t.headText} mb-1`}>Run</div>
        <div class="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          {durationMs !== undefined && (
            <div class="flex justify-between">
              <span class={t.subText}>Duration</span>
              <span class={`font-mono ${t.body}`}>{formatDuration(durationMs)}</span>
            </div>
          )}
          {apiDurationMs !== undefined && (
            <div class="flex justify-between">
              <span class={t.subText}>API time</span>
              <span class={`font-mono ${t.body}`}>{formatDuration(apiDurationMs)}</span>
            </div>
          )}
          {numTurns !== undefined && (
            <div class="flex justify-between">
              <span class={t.subText}>Turns</span>
              <span class={`font-mono ${t.body}`}>{numTurns}</span>
            </div>
          )}
          {totalCost !== undefined && (
            <div class="flex justify-between">
              <span class={t.subText}>Cost</span>
              <span class={`font-mono ${t.body}`}>{formatCost(totalCost)}</span>
            </div>
          )}
        </div>
      </div>

      {isError && errors && errors.length > 0 && (
        <div>
          <div class={`text-xs font-medium ${t.headText} mb-1`}>Errors ({errors.length})</div>
          <div class="space-y-1">
            {errors.map((err, idx) => (
              <div
                key={idx}
                class={`font-mono text-[11px] ${t.body} ${t.bodyBg} rounded px-2 py-1 break-all`}
              >
                {err}
              </div>
            ))}
          </div>
        </div>
      )}

      {modelUsage && Object.keys(modelUsage).length > 0 && (
        <div>
          <div class={`text-xs font-medium ${t.headText} mb-1`}>
            Models ({Object.keys(modelUsage).length})
          </div>
          <div class="flex flex-wrap gap-1">
            {Object.keys(modelUsage).map((m) => (
              <span key={m} class={`px-2 py-0.5 ${t.bodyBg} ${t.body} rounded text-xs font-mono`}>
                {m}
              </span>
            ))}
          </div>
        </div>
      )}

      {stopReason && (
        <div
          class={`flex flex-wrap gap-x-3 gap-y-1 text-xs ${t.subText} pt-2 border-t ${t.border}`}
        >
          <div>
            <span class="font-medium">Stop reason:</span> {stopReason}
          </div>
        </div>
      )}
    </div>
  );
}
