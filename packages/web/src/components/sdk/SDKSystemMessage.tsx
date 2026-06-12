/**
 * SDKSystemMessage Renderer
 *
 * Renders system messages:
 * - init: Session initialization with tools, models, permissions
 * - compact_boundary: Compaction metadata
 * - status: Status updates (compacting, etc.)
 * - hook_response: Hook execution results
 */

import { useState } from 'preact/hooks';
import type {
  SDKHookResponseMessage,
  SDKMessage,
  SDKModelRefusalFallbackMessage,
  SDKStatusMessage,
} from '@neokai/shared/sdk/sdk.d.ts';
import {
  isSDKSystemInit,
  isSDKCompactBoundary,
  isSDKStatusMessage,
  isSDKHookResponse,
  isSDKModelRefusalFallbackMessage,
} from '@neokai/shared/sdk/type-guards';
import { customColors } from '../../lib/design-tokens.ts';

type SystemMessage = Extract<SDKMessage, { type: 'system' }>;

interface Props {
  message: SystemMessage;
}

export function SDKSystemMessage({ message }: Props) {
  // Init message - session started
  if (isSDKSystemInit(message)) {
    return <SystemInitMessage message={message} />;
  }

  // Compact boundary - shows when message compaction occurred
  if (isSDKCompactBoundary(message)) {
    return <CompactBoundaryMessage message={message} />;
  }

  // Status message
  if (isSDKStatusMessage(message)) {
    const statusMessage = message as SDKStatusMessage;
    if (statusMessage.status === 'compacting') {
      return (
        <div class="flex items-center gap-3 py-4">
          <div
            class="flex-1 h-px"
            style={{ backgroundColor: customColors.canaryYellow.light }}
          ></div>
          <span class="text-xs font-medium text-yellow-600 dark:text-yellow-400">
            Compact Boundary
          </span>
          <div
            class="flex-1 h-px"
            style={{ backgroundColor: customColors.canaryYellow.light }}
          ></div>
        </div>
      );
    }
    return null; // Don't show null status
  }

  // Hook response
  if (isSDKHookResponse(message)) {
    const hookMessage = message as SDKHookResponseMessage;
    return <HookResponseCard message={hookMessage} />;
  }

  if (isSDKModelRefusalFallbackMessage(message)) {
    return <ModelRefusalFallbackMessage message={message} />;
  }

  return null;
}

function ModelRefusalFallbackMessage({ message }: { message: SDKModelRefusalFallbackMessage }) {
  return (
    <div class="my-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100">
      <div class="mb-1 font-semibold">Model fallback</div>
      <div>{message.content}</div>
      <div class="mt-2 text-xs text-amber-700 dark:text-amber-300">
        {message.original_model} → {message.fallback_model}
      </div>
    </div>
  );
}

/**
 * System Init Message - Shows session startup info
 */
function SystemInitMessage({ message }: { message: Extract<SystemMessage, { subtype: 'init' }> }) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div class="py-2 bg-indigo-50 dark:bg-indigo-900/20 rounded border border-indigo-200 dark:border-indigo-800">
      <button
        onClick={() => setShowDetails(!showDetails)}
        class="w-full flex items-center justify-between hover:bg-indigo-100 dark:hover:bg-indigo-900/30 transition-colors -m-1 p-1 rounded"
      >
        <div class="flex items-center gap-2">
          <svg
            class="w-4 h-4 text-indigo-600 dark:text-indigo-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M13 10V3L4 14h7v7l9-11h-7z"
            />
          </svg>
          <div class="text-xs">
            <span class="font-medium text-indigo-900 dark:text-indigo-100">Session Started</span>
            <span class="text-indigo-600 dark:text-indigo-400 ml-2">
              {message.model.replace('claude-', '')} • {message.permissionMode}
            </span>
          </div>
        </div>
        <svg
          class={`w-4 h-4 text-indigo-600 dark:text-indigo-400 transition-transform ${showDetails ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {showDetails && (
        <div class="mt-3 pt-3 border-t border-indigo-200 dark:border-indigo-800 space-y-2 text-sm">
          <div>
            <div class="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-1">
              Working Directory
            </div>
            <div class="font-mono text-xs text-indigo-900 dark:text-indigo-100 bg-indigo-100 dark:bg-indigo-900/30 px-2 py-1 rounded">
              {message.cwd}
            </div>
          </div>

          <div>
            <div class="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-1">
              Tools ({message.tools.length})
            </div>
            <div class="flex flex-wrap gap-1">
              {message.tools.map((tool: string) => (
                <span
                  key={tool}
                  class="text-xs bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200 px-2 py-0.5 rounded font-mono"
                >
                  {tool}
                </span>
              ))}
            </div>
          </div>

          {message.mcp_servers.length > 0 && (
            <div>
              <div class="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-1">
                MCP Servers ({message.mcp_servers.length})
              </div>
              <div class="space-y-1">
                {message.mcp_servers.map((server: { name: string; status: string }) => (
                  <div
                    key={server.name}
                    class="text-xs bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200 px-2 py-1 rounded flex items-center justify-between"
                  >
                    <span class="font-mono">{server.name}</span>
                    <span
                      class={`text-xs ${server.status === 'connected' ? 'text-green-600 dark:text-green-400' : 'text-gray-500'}`}
                    >
                      {server.status}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {message.slash_commands.length > 0 && (
            <div>
              <div class="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-1">
                Slash Commands ({message.slash_commands.length})
              </div>
              <div class="flex flex-wrap gap-1">
                {message.slash_commands.map((cmd: string) => (
                  <span
                    key={cmd}
                    class="text-xs bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200 px-2 py-0.5 rounded font-mono"
                  >
                    /{cmd}
                  </span>
                ))}
              </div>
            </div>
          )}

          {message.agents && message.agents.length > 0 && (
            <div>
              <div class="text-xs font-semibold text-indigo-700 dark:text-indigo-300 mb-1">
                Agents ({message.agents.length})
              </div>
              <div class="flex flex-wrap gap-1">
                {message.agents.map((agent: string) => (
                  <span
                    key={agent}
                    class="text-xs bg-indigo-100 dark:bg-indigo-900/30 text-indigo-800 dark:text-indigo-200 px-2 py-0.5 rounded"
                  >
                    {agent}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div class="text-xs text-indigo-600 dark:text-indigo-400">
            API Key Source: {message.apiKeySource} • Output: {message.output_style}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Hook Response Card - Collapsible card for hook execution results
 * Matches the visual pattern of ToolResultCard (header button + chevron + expand/collapse).
 * Default collapsed since hooks are noise, not signal.
 */
function HookResponseCard({ message }: { message: SDKHookResponseMessage }) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Muted slate/violet color scheme
  const colors = {
    bg: 'bg-slate-50 dark:bg-slate-900/30',
    border: 'border-slate-200 dark:border-slate-700',
    text: 'text-slate-900 dark:text-slate-100',
    lightText: 'text-slate-600 dark:text-slate-400',
    iconColor: 'text-slate-500 dark:text-slate-400',
  };

  // Truncated first line of stdout for summary
  const summary = message.stdout?.trim() ? message.stdout.split('\n')[0].slice(0, 80) : undefined;

  return (
    <div class="my-2">
      <div class={`border rounded-lg overflow-hidden ${colors.bg} ${colors.border}`}>
        {/* Header - clickable to expand/collapse */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          class="w-full flex items-center justify-between p-3 transition-colors hover:bg-opacity-80 dark:hover:bg-opacity-80"
        >
          <div class="flex items-center gap-2 min-w-0 flex-1">
            {/* Hook icon - link/chain */}
            <svg
              class={`w-5 h-5 flex-shrink-0 ${colors.iconColor}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
              />
            </svg>
            <span class={`font-semibold text-sm flex-shrink-0 ${colors.text}`}>
              {message.hook_name}
            </span>
            <span
              class={`text-xs px-1.5 py-0.5 rounded font-mono ${colors.lightText} bg-slate-100 dark:bg-slate-800`}
            >
              {message.hook_event}
            </span>
            {summary && (
              <span class={`text-sm font-mono truncate ${colors.lightText}`}>{summary}</span>
            )}
          </div>

          <div class="flex items-center gap-2 flex-shrink-0">
            {/* Error indicator */}
            {message.exit_code !== undefined && message.exit_code !== 0 && (
              <svg
                class="w-4 h-4 text-red-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            )}
            {/* Chevron */}
            <svg
              class={`w-5 h-5 transition-transform ${colors.iconColor} ${isExpanded ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </div>
        </button>

        {/* Expanded content */}
        {isExpanded && (
          <div class={`p-3 border-t bg-white dark:bg-gray-900 space-y-2 ${colors.border}`}>
            {message.stdout?.trim() && (
              <pre class="text-xs font-mono whitespace-pre-wrap overflow-x-auto bg-slate-50 dark:bg-slate-800 p-2 rounded border border-slate-200 dark:border-slate-700 text-slate-800 dark:text-slate-200">
                {message.stdout}
              </pre>
            )}
            {message.stderr?.trim() && (
              <pre class="text-xs font-mono whitespace-pre-wrap overflow-x-auto bg-red-50 dark:bg-red-900/20 p-2 rounded border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300">
                {message.stderr}
              </pre>
            )}
            {message.exit_code !== undefined && (
              <div class={`text-xs ${colors.lightText}`}>Exit code: {message.exit_code}</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Compact Boundary Message - Shows compaction metadata only
 */
function CompactBoundaryMessage({
  message,
}: {
  message: Extract<SystemMessage, { subtype: 'compact_boundary' }>;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  // Yellow/amber color scheme with canary yellow borders for visibility
  const colors = {
    bg: 'bg-yellow-50 dark:bg-yellow-900/20',
    text: 'text-yellow-900 dark:text-yellow-100',
    borderColor: customColors.canaryYellow.light,
    iconColor: 'text-yellow-600 dark:text-yellow-400',
    lightText: 'text-yellow-700 dark:text-yellow-300',
  };

  const trigger = message.compact_metadata.trigger === 'manual' ? 'Manual' : 'Auto';
  const preTokens = message.compact_metadata.pre_tokens.toLocaleString();

  return (
    <div class="my-2">
      <div
        class={`border rounded-lg overflow-hidden ${colors.bg}`}
        style={{ borderColor: colors.borderColor }}
      >
        {/* Header - clickable to expand/collapse */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          class="w-full flex items-center justify-between p-3 transition-colors hover:bg-opacity-80 dark:hover:bg-opacity-80"
        >
          <div class="flex items-center gap-2 min-w-0 flex-1">
            {/* Compress/zip icon */}
            <svg
              class={`w-5 h-5 flex-shrink-0 ${colors.iconColor}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
              />
            </svg>
            <span class={`font-semibold text-sm flex-shrink-0 ${colors.text}`}>Compact</span>
            <span class={`text-sm font-mono truncate ${colors.lightText}`}>
              {trigger} • {preTokens} tokens
            </span>
          </div>

          <div class="flex items-center gap-2 flex-shrink-0">
            {/* Chevron icon */}
            <svg
              class={`w-5 h-5 transition-transform ${colors.iconColor} ${isExpanded ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </div>
        </button>

        {/* Expanded content - metadata details */}
        {isExpanded && (
          <div
            class="p-3 border-t bg-white dark:bg-gray-900"
            style={{ borderColor: colors.borderColor }}
          >
            <div class={`text-xs font-semibold mb-2 ${colors.lightText}`}>Metadata:</div>
            <pre
              class={`text-xs font-mono whitespace-pre-wrap overflow-x-auto bg-yellow-100 dark:bg-yellow-900/30 p-2 rounded ${colors.text}`}
            >
              {JSON.stringify(message.compact_metadata, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
