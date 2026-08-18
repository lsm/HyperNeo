import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import { isSDKResultSuccess, isSDKResultError } from '@hyperneo/shared/sdk/type-guards';
import { useState } from 'preact/hooks';

type ResultMessage = Extract<SDKMessage, { type: 'result' }>;

interface Props {
  message: ResultMessage;
}

export function SDKResultMessage({ message }: Props) {
  const [showDetails, setShowDetails] = useState(false);
  const isSuccess = isSDKResultSuccess(message);
  const isError = isSDKResultError(message);

  const usage = (message as unknown as { usage?: Record<string, number | undefined> }).usage ?? {};
  const inputTokens = (usage.input_tokens as number | undefined) ?? 0;
  const outputTokens = (usage.output_tokens as number | undefined) ?? 0;
  const cacheReadTokens = (usage.cache_read_input_tokens as number | undefined) ?? 0;
  const cacheCreationTokens = (usage.cache_creation_input_tokens as number | undefined) ?? 0;

  return (
    <div
      class={`rounded border mb-4 ${
        isSuccess
          ? 'bg-green-50 dark:bg-green-900/10 border-green-200 dark:border-green-800'
          : 'bg-red-50 dark:bg-red-900/10 border-red-200 dark:border-red-800'
      }`}
    >
      <button
        onClick={() => setShowDetails(!showDetails)}
        class="w-full px-3 py-2 flex items-center justify-between hover:bg-green-100 dark:hover:bg-green-900/20 transition-colors"
      >
        <div class="flex items-center gap-2 text-xs">
          {isSuccess ? (
            <svg
              class="w-4 h-4 text-green-600 dark:text-green-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          ) : (
            <svg
              class="w-4 h-4 text-red-600 dark:text-red-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          )}
          <span class="font-medium text-green-900 dark:text-green-100">
            {inputTokens}→{outputTokens} tokens
          </span>
          <span class="text-green-700 dark:text-green-300">•</span>
          <span class="font-mono text-green-700 dark:text-green-300">
            ${message.total_cost_usd.toFixed(4)}
          </span>
          <span class="text-green-700 dark:text-green-300">•</span>
          <span class="text-green-700 dark:text-green-300">
            {(message.duration_ms / 1000).toFixed(2)}s
          </span>
        </div>
        <svg
          class={`w-4 h-4 text-green-600 dark:text-green-400 transition-transform ${showDetails ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {showDetails && (
        <div class="p-3 border-t border-green-200 dark:border-green-800 bg-white dark:bg-gray-900 space-y-3">
          <div class="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <StatCard
              label="Input Tokens"
              value={inputTokens.toLocaleString()}
              icon={
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 11l5-5m0 0l5 5m-5-5v12"
                  />
                </svg>
              }
            />
            <StatCard
              label="Output Tokens"
              value={outputTokens.toLocaleString()}
              icon={
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M17 13l-5 5m0 0l-5-5m5 5V6"
                  />
                </svg>
              }
            />
            <StatCard
              label="Cost"
              value={`$${message.total_cost_usd.toFixed(4)}`}
              icon={
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              }
              highlight={true}
            />
            <StatCard
              label="Duration"
              value={`${(message.duration_ms / 1000).toFixed(2)}s`}
              icon={
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              }
            />
          </div>

          {(cacheReadTokens > 0 || cacheCreationTokens > 0) && (
            <div class="pt-2 border-t border-green-200 dark:border-green-800">
              <div class="flex items-center gap-4 text-xs text-green-700 dark:text-green-300">
                <div class="flex items-center gap-1">
                  <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                  <span>Cache Read: {cacheReadTokens.toLocaleString()} tokens</span>
                </div>
                {cacheCreationTokens > 0 && (
                  <div class="flex items-center gap-1">
                    <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M12 4v16m8-8H4"
                      />
                    </svg>
                    <span>Cache Created: {cacheCreationTokens.toLocaleString()} tokens</span>
                  </div>
                )}
              </div>
            </div>
          )}

          <div class="text-xs text-gray-600 dark:text-gray-400">
            Completed in {message.num_turns} turn
            {message.num_turns !== 1 ? 's' : ''}
            {' • '}
            API time: {(message.duration_api_ms / 1000).toFixed(2)}s
          </div>

          {Object.keys(message.modelUsage).length > 0 && (
            <div>
              <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">
                Model Usage Breakdown
              </h4>
              <div class="space-y-2">
                {Object.entries(message.modelUsage).map(([modelName, usage]) => (
                  <div
                    key={modelName}
                    class="bg-gray-50 dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700"
                  >
                    <div class="font-mono text-sm font-medium text-gray-900 dark:text-gray-100 mb-1">
                      {modelName}
                    </div>
                    <div class="grid grid-cols-2 gap-2 text-xs text-gray-600 dark:text-gray-400">
                      <div>
                        Input: {(usage as { inputTokens: number }).inputTokens.toLocaleString()}
                      </div>
                      <div>
                        Output: {(usage as { outputTokens: number }).outputTokens.toLocaleString()}
                      </div>
                      <div>
                        Cache Read:{' '}
                        {(
                          usage as { cacheReadInputTokens: number }
                        ).cacheReadInputTokens.toLocaleString()}
                      </div>
                      <div>
                        Cache Created:{' '}
                        {(
                          usage as { cacheCreationInputTokens: number }
                        ).cacheCreationInputTokens.toLocaleString()}
                      </div>
                      <div>Cost: ${(usage as { costUSD: number }).costUSD.toFixed(4)}</div>
                      <div>
                        Context:{' '}
                        {(usage as { contextWindow: number }).contextWindow.toLocaleString()}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {message.permission_denials && message.permission_denials.length > 0 && (
            <div>
              <h4 class="text-sm font-semibold text-yellow-700 dark:text-yellow-300 mb-2 flex items-center gap-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
                Permissions Denied ({message.permission_denials.length})
              </h4>
              <div class="space-y-2">
                {message.permission_denials.map(
                  (denial: { tool_name: string; tool_use_id: string }, idx: number) => (
                    <div
                      key={idx}
                      class="bg-yellow-50 dark:bg-yellow-900/20 p-3 rounded border border-yellow-200 dark:border-yellow-800 text-sm"
                    >
                      <div class="font-medium text-yellow-900 dark:text-yellow-100">
                        {denial.tool_name}
                      </div>
                      <div class="text-yellow-700 dark:text-yellow-300 mt-1 text-xs font-mono">
                        {denial.tool_use_id}
                      </div>
                    </div>
                  )
                )}
              </div>
            </div>
          )}

          {isSuccess && message.structured_output && (
            <div>
              <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
                  />
                </svg>
                Structured Output
              </h4>
              <pre class="bg-gray-50 dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700 text-xs overflow-x-auto">
                {JSON.stringify(message.structured_output, null, 2)}
              </pre>
            </div>
          )}

          {isError && 'errors' in message && message.errors && (
            <div>
              <h4 class="text-sm font-semibold text-red-700 dark:text-red-300 mb-2">Errors</h4>
              <div class="space-y-2">
                {message.errors.map((error: string, idx: number) => (
                  <div
                    key={idx}
                    class="bg-red-50 dark:bg-red-900/20 p-3 rounded border border-red-200 dark:border-red-800 text-sm text-red-700 dark:text-red-300"
                  >
                    {error}
                  </div>
                ))}
              </div>
            </div>
          )}

          {isSuccess && 'result' in message && (
            <div>
              <h4 class="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Result</h4>
              <div class="bg-gray-50 dark:bg-gray-800 p-3 rounded border border-gray-200 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-300">
                {message.result}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  highlight = false,
}: {
  label: string;
  value: string;
  icon: unknown;
  highlight?: boolean;
}) {
  return (
    <div
      class={`${highlight ? 'bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700' : ''} p-2 rounded`}
    >
      <div class="flex items-center gap-1 text-gray-500 dark:text-gray-400 mb-1">
        {icon}
        <span class="text-xs">{label}</span>
      </div>
      <div
        class={`font-mono font-semibold ${highlight ? 'text-lg text-indigo-600 dark:text-indigo-400' : 'text-gray-900 dark:text-gray-100'}`}
      >
        {value}
      </div>
    </div>
  );
}
