import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import type {
  SDKAPIRetryMessage,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKHookStartedMessage,
  SDKInformationalMessage,
  SDKMessage,
  SDKModelRefusalFallbackMessage,
  SDKModelRefusalNoFallbackMessage,
  SDKNotificationMessage,
  SDKPermissionDeniedMessage,
  SDKFilesPersistedEvent,
  SDKPluginInstallMessage,
  SDKTaskNotificationMessage,
  SDKMemoryRecallMessage,
  SDKLocalCommandOutputMessage,
  SDKStatusMessage,
  SDKWorkerShuttingDownMessage,
} from '@hyperneo/shared/sdk/sdk.d.ts';
import {
  isSDKSystemInit,
  isSDKCompactBoundary,
  isSDKStatusMessage,
  isSDKHookResponse,
  isSDKAPIRetryMessage,
  isSDKModelRefusalFallbackMessage,
} from '@hyperneo/shared/sdk/type-guards';

type SystemMessage = Extract<SDKMessage, { type: 'system' }>;

interface Props {
  message: SystemMessage;
  isLiveTail?: boolean;
  completedHookUuids?: Set<string>;
}

export function SDKSystemMessage({ message, isLiveTail = false, completedHookUuids }: Props) {
  if (isSDKSystemInit(message)) {
    return <SystemInitMessage message={message} />;
  }

  if (isSDKCompactBoundary(message)) {
    return <CompactBoundaryMessage message={message} />;
  }

  if (isSDKStatusMessage(message)) {
    const statusMessage = message as SDKStatusMessage;
    if (statusMessage.status === 'compacting') {
      return (
        <div class="flex items-center gap-3 py-4">
          <div class="flex-1 h-px bg-warning"></div>
          <span class="text-xs font-medium text-warning">Compact Boundary</span>
          <div class="flex-1 h-px bg-warning"></div>
        </div>
      );
    }
    return null;
  }

  if (message.subtype === 'hook_started') {
    return (
      <HookRunningCard
        message={message as SDKHookStartedMessage}
        progress={undefined}
        completed={isHookPhaseCompleted(message as { uuid?: string }, completedHookUuids)}
      />
    );
  }
  if (message.subtype === 'hook_progress') {
    return (
      <HookRunningCard
        message={undefined}
        progress={message as SDKHookProgressMessage}
        completed={isHookPhaseCompleted(message as { uuid?: string }, completedHookUuids)}
      />
    );
  }

  if (isSDKHookResponse(message)) {
    const hookMessage = message as SDKHookResponseMessage;
    return <HookResponseCard message={hookMessage} />;
  }

  if (isSDKAPIRetryMessage(message)) {
    return <ApiRetryMessage message={message as SDKAPIRetryMessage} />;
  }

  if (message.subtype === 'informational') {
    if ((message as SDKInformationalMessage).level === 'info') return null;
    return <InformationalMessage message={message as SDKInformationalMessage} />;
  }

  if (message.subtype === 'worker_shutting_down' && isLiveTail) {
    return <WorkerShuttingDownMessage message={message as SDKWorkerShuttingDownMessage} />;
  }

  if (isSDKModelRefusalFallbackMessage(message)) {
    return <ModelRefusalFallbackMessage message={message} />;
  }

  if (message.subtype === 'model_refusal_no_fallback') {
    return <ModelRefusalNoFallbackMessage message={message as SDKModelRefusalNoFallbackMessage} />;
  }

  if (message.subtype === 'permission_denied') {
    return <PermissionDeniedMessage message={message as SDKPermissionDeniedMessage} />;
  }

  if (message.subtype === 'task_notification') {
    return <TaskNotificationMessage message={message as SDKTaskNotificationMessage} />;
  }

  if (message.subtype === 'memory_recall') {
    return <MemoryRecallMessage message={message as SDKMemoryRecallMessage} />;
  }

  if (message.subtype === 'local_command_output') {
    return <LocalCommandOutputMessage message={message as SDKLocalCommandOutputMessage} />;
  }

  if (message.subtype === 'notification') {
    return <NotificationMessage message={message as SDKNotificationMessage} />;
  }

  if (message.subtype === 'files_persisted') {
    const filesMsg = message as SDKFilesPersistedEvent;
    if (filesMsg.failed.length === 0) return null;
    return <FilesPersistedMessage message={filesMsg} />;
  }

  if (message.subtype === 'plugin_install') {
    const pluginMsg = message as SDKPluginInstallMessage;
    if (pluginMsg.status === 'started' || pluginMsg.status === 'installed') return null;
    return <PluginInstallMessage message={pluginMsg} />;
  }

  return null;
}

function OperationalSystemMessage({
  title,
  children,
}: {
  title: string;
  children: ComponentChildren;
}) {
  return (
    <div class="my-2 rounded-lg border border-line bg-surface-raised p-3 text-sm text-fg dark:text-slate-100">
      <div class="mb-1 text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</div>
      <div>{children}</div>
    </div>
  );
}

function InformationalMessage({ message }: { message: SDKInformationalMessage }) {
  return (
    <OperationalSystemMessage title={`Info: ${message.level}`}>
      {message.content}
      {message.prevent_continuation && (
        <div class="mt-1 text-xs text-fg-muted">Continuation stopped</div>
      )}
    </OperationalSystemMessage>
  );
}

function ApiRetryMessage({ message }: { message: SDKAPIRetryMessage }) {
  const maxRetries = message.max_retries;
  const currentAttempt = message.attempt;
  const delayMs = message.retry_delay_ms;
  const errorStatus = message.error_status;
  const errorMessage = message.error;

  return (
    <OperationalSystemMessage title="API retry">
      <div class="flex flex-col gap-1">
        <div class="flex items-center gap-2 text-xs">
          <span class="font-medium">Attempt {currentAttempt}</span>
          {maxRetries > 0 && <span class="text-fg-muted">of {maxRetries}</span>}
          {delayMs > 0 && <span class="text-fg-muted">• delay {delayMs}ms</span>}
        </div>
        {errorStatus && <div class="text-xs text-fg-muted">Status: {errorStatus}</div>}
        <div class="text-xs text-warning-soft font-mono break-words">{errorMessage}</div>
      </div>
    </OperationalSystemMessage>
  );
}

function WorkerShuttingDownMessage({ message }: { message: SDKWorkerShuttingDownMessage }) {
  return (
    <OperationalSystemMessage title="Worker shutting down">
      <span class="font-mono">{message.reason}</span>
    </OperationalSystemMessage>
  );
}

function ModelRefusalFallbackMessage({ message }: { message: SDKModelRefusalFallbackMessage }) {
  const refusalCategory = message.api_refusal_category?.trim() || null;
  const refusalExplanation = message.api_refusal_explanation?.trim() || null;

  return (
    <div class="my-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm text-warning-soft">
      <div class="mb-1 flex flex-wrap items-center gap-2 font-semibold">
        Model fallback
        {refusalCategory && (
          <span
            class="rounded bg-warning/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide text-warning-soft"
            data-testid="api-refusal-category"
          >
            {refusalCategory}
          </span>
        )}
      </div>
      <div>{message.content}</div>
      {refusalExplanation && (
        <div class="mt-1 text-xs text-warning-soft" data-testid="api-refusal-explanation">
          {refusalExplanation}
        </div>
      )}
      <div class="mt-2 text-xs text-warning-soft">
        {message.original_model} → {message.fallback_model}
      </div>
    </div>
  );
}

function ModelRefusalNoFallbackMessage({ message }: { message: SDKModelRefusalNoFallbackMessage }) {
  return (
    <div class="my-2 rounded-lg border border-danger/40 bg-danger/15 p-3 text-sm text-danger-soft">
      <div class="mb-1 font-semibold">Model refusal</div>
      <div>{message.content}</div>
      <div class="mt-2 text-xs text-danger-soft">{message.original_model}</div>
    </div>
  );
}

function PermissionDeniedMessage({ message }: { message: SDKPermissionDeniedMessage }) {
  return (
    <div class="my-2 rounded-lg border border-cat-rose/40 bg-rose-50 p-3 text-sm text-cat-rose dark:bg-rose-950/30">
      <div class="mb-1 font-semibold">Permission denied</div>
      <div class="font-mono text-xs">{message.tool_name}</div>
      {message.decision_reason && (
        <div class="mt-1 text-xs text-cat-rose">{message.decision_reason}</div>
      )}
      <div class="mt-1 text-xs text-cat-rose">{message.message}</div>
      {message.agent_id && (
        <div class="mt-1 text-xs text-cat-rose">Subagent: {message.agent_id.slice(0, 8)}...</div>
      )}
    </div>
  );
}

function TaskNotificationMessage({ message }: { message: SDKTaskNotificationMessage }) {
  const isSuccess = message.status === 'completed';
  const isError = message.status === 'failed' || message.status === 'stopped';

  return (
    <div
      class={`my-2 rounded-lg border p-3 text-sm ${
        isSuccess
          ? 'border-success/40 bg-success/10 text-success-soft'
          : isError
            ? 'border-danger/40 bg-danger/15 text-danger-soft'
            : 'border-line bg-surface-raised text-fg'
      }`}
    >
      <div class="mb-1 font-semibold">
        {message.status === 'completed' && 'Task completed'}
        {message.status === 'failed' && 'Task failed'}
        {message.status === 'stopped' && 'Task stopped'}
      </div>
      <div class="text-xs">{message.summary}</div>
      {message.usage && (
        <div class="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs font-mono opacity-80">
          <span>{message.usage.total_tokens.toLocaleString()} tokens</span>
          <span>{message.usage.tool_uses} tool uses</span>
          <span>{(message.usage.duration_ms / 1000).toFixed(1)}s</span>
        </div>
      )}
    </div>
  );
}

function MemoryRecallMessage({ message }: { message: SDKMemoryRecallMessage }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div class="my-2 rounded-lg border border-cat-violet/40 bg-cat-violet/10 p-3 text-sm text-cat-violet">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        class="w-full flex items-center justify-between"
      >
        <div class="flex items-center gap-2">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 7v10c0 2 1 3 3 3h10c2 0 3-1 3-3V7c0-2-1-3-3-3H7C5 4 4 5 4 7z"
            />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h8" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 8h8" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16h8" />
          </svg>
          <span class="font-semibold">Memory recalled</span>
          <span class="text-xs opacity-80">({message.memories.length} items)</span>
        </div>
        <svg
          class={`w-4 h-4 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {isExpanded && (
        <div class="mt-2 space-y-1">
          {message.memories.map((memory, index) => (
            <div
              key={index}
              class="flex items-start gap-2 text-xs bg-surface rounded p-2 border border-cat-violet/40"
            >
              <span class="font-mono text-cat-violet flex-shrink-0">{memory.scope}</span>
              <span class="font-mono text-cat-violet truncate">{memory.path}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LocalCommandOutputMessage({ message }: { message: SDKLocalCommandOutputMessage }) {
  return (
    <div class="my-2 rounded-lg border border-line bg-surface-raised p-3 text-sm text-fg">
      <pre class="text-xs font-mono whitespace-pre-wrap overflow-x-auto">{message.content}</pre>
    </div>
  );
}

function NotificationMessage({ message }: { message: SDKNotificationMessage }) {
  const priorityColors = {
    low: 'border-accent/40 bg-accent/10 text-accent-soft',
    medium: 'border-warning/40 bg-warning/10 text-warning-soft dark:bg-yellow-950/30',
    high: 'border-warning-soft bg-warning/10 text-warning-soft',
    immediate: 'border-danger/40 bg-danger/15 text-danger-soft',
  };

  const colors = message.color
    ? message.color
    : (priorityColors[message.priority] ?? priorityColors.low);

  return (
    <div class={`my-2 rounded-lg border p-3 text-sm ${colors}`}>
      <div class="font-medium">{message.text}</div>
    </div>
  );
}

function FilesPersistedMessage({ message }: { message: SDKFilesPersistedEvent }) {
  return (
    <div class="my-2 rounded-lg border border-danger/40 bg-danger/15 p-3 text-sm text-danger-soft">
      <div class="mb-1 font-semibold">File persistence failed</div>
      <div class="text-xs">
        {message.failed.length} file{message.failed.length !== 1 ? 's' : ''} failed to persist
      </div>
      {message.failed.length > 0 && (
        <div class="mt-2 space-y-1">
          {message.failed.map((failure, index) => (
            <div
              key={index}
              class="text-xs bg-surface rounded p-2 border border-red-100 dark:border-red-900"
            >
              <div class="font-mono">{failure.filename}</div>
              <div class="text-danger-soft mt-1">{failure.error}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function PluginInstallMessage({ message }: { message: SDKPluginInstallMessage }) {
  const isSuccess = message.status === 'completed' || message.status === 'installed';
  const isError = message.status === 'failed';

  return (
    <div
      class={`my-2 rounded-lg border p-3 text-sm ${
        isSuccess
          ? 'border-success/40 bg-success/10 text-success-soft'
          : isError
            ? 'border-danger/40 bg-danger/15 text-danger-soft'
            : 'border-line bg-surface-raised text-fg'
      }`}
    >
      <div class="font-semibold">
        {message.name && <span class="font-mono">{message.name}</span>}
        {!message.name && 'Plugin'}
        {isSuccess && ' installed'}
        {isError && ' installation failed'}
      </div>
      {message.error && <div class="mt-1 text-xs text-danger-soft">{message.error}</div>}
    </div>
  );
}

function SystemInitMessage({ message }: { message: Extract<SystemMessage, { subtype: 'init' }> }) {
  const [showDetails, setShowDetails] = useState(false);

  return (
    <div class="py-2 bg-cat-indigo/10 rounded border border-cat-indigo/40">
      <button
        onClick={() => setShowDetails(!showDetails)}
        class="w-full flex items-center justify-between hover:bg-indigo-100 dark:hover:bg-indigo-900/30 transition-colors -m-1 p-1 rounded"
      >
        <div class="flex items-center gap-2">
          <svg
            class="w-4 h-4 text-cat-indigo"
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
            <span class="font-medium text-cat-indigo">Session Started</span>
            <span class="text-cat-indigo ml-2">
              {message.model.replace('claude-', '')} • {message.permissionMode}
            </span>
          </div>
        </div>
        <svg
          class={`w-4 h-4 text-cat-indigo transition-transform ${showDetails ? 'rotate-180' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {showDetails && (
        <div class="mt-3 pt-3 border-t border-cat-indigo/40 space-y-2 text-sm">
          <div>
            <div class="text-xs font-semibold text-cat-indigo mb-1">Working Directory</div>
            <div class="font-mono text-xs text-cat-indigo bg-cat-indigo/15 px-2 py-1 rounded">
              {message.cwd}
            </div>
          </div>

          <div>
            <div class="text-xs font-semibold text-cat-indigo mb-1">
              Tools ({message.tools.length})
            </div>
            <div class="flex flex-wrap gap-1">
              {message.tools.map((tool: string) => (
                <span
                  key={tool}
                  class="text-xs bg-cat-indigo/15 text-cat-indigo px-2 py-0.5 rounded font-mono"
                >
                  {tool}
                </span>
              ))}
            </div>
          </div>

          {message.mcp_servers.length > 0 && (
            <div>
              <div class="text-xs font-semibold text-cat-indigo mb-1">
                MCP Servers ({message.mcp_servers.length})
              </div>
              <div class="space-y-1">
                {message.mcp_servers.map((server: { name: string; status: string }) => (
                  <div
                    key={server.name}
                    class="text-xs bg-cat-indigo/15 text-cat-indigo px-2 py-1 rounded flex items-center justify-between"
                  >
                    <span class="font-mono">{server.name}</span>
                    <span
                      class={`text-xs ${server.status === 'connected' ? 'text-success' : 'text-fg-faint'}`}
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
              <div class="text-xs font-semibold text-cat-indigo mb-1">
                Slash Commands ({message.slash_commands.length})
              </div>
              <div class="flex flex-wrap gap-1">
                {message.slash_commands.map((cmd: string) => (
                  <span
                    key={cmd}
                    class="text-xs bg-cat-indigo/15 text-cat-indigo px-2 py-0.5 rounded font-mono"
                  >
                    /{cmd}
                  </span>
                ))}
              </div>
            </div>
          )}

          {message.agents && message.agents.length > 0 && (
            <div>
              <div class="text-xs font-semibold text-cat-indigo mb-1">
                Agents ({message.agents.length})
              </div>
              <div class="flex flex-wrap gap-1">
                {message.agents.map((agent: string) => (
                  <span
                    key={agent}
                    class="text-xs bg-cat-indigo/15 text-cat-indigo px-2 py-0.5 rounded"
                  >
                    {agent}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div class="text-xs text-cat-indigo">
            API Key Source: {message.apiKeySource} • Output: {message.output_style}
          </div>
        </div>
      )}
    </div>
  );
}

function HookRunningCard({
  message,
  progress,
  completed = false,
}: {
  message: SDKHookStartedMessage | undefined;
  progress: SDKHookProgressMessage | undefined;
  completed?: boolean;
}) {
  const hookName = (message ?? progress)?.hook_name ?? 'hook';
  const hookEvent = (message ?? progress)?.hook_event ?? '';
  const stdout = progress?.stdout?.trim() ?? '';
  const summary = stdout ? stdout.split('\n')[0].slice(0, 80) : undefined;

  return (
    <div class="my-2 flex items-center gap-2 rounded-lg border border-line bg-surface-raised p-2 text-sm">
      {completed ? (
        <svg
          class="h-4 w-4 flex-shrink-0 text-fg-muted"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-label="hook finished"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
        </svg>
      ) : (
        <svg
          class="h-4 w-4 flex-shrink-0 animate-spin text-fg-muted"
          fill="none"
          viewBox="0 0 24 24"
          aria-label="hook running"
        >
          <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path
            class="opacity-75"
            fill="currentColor"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
          />
        </svg>
      )}
      <span class={`font-semibold ${completed ? 'text-fg-muted' : 'text-fg'}`}>{hookName}</span>
      <span class="rounded bg-surface-raised px-1.5 py-0.5 font-mono text-xs text-fg-muted">
        {hookEvent}
      </span>
      {summary && <span class="truncate font-mono text-xs text-fg-muted">{summary}</span>}
    </div>
  );
}

function isHookPhaseCompleted(
  message: { uuid?: string },
  completedHookUuids?: Set<string>
): boolean {
  if (!message.uuid || !completedHookUuids) return false;
  return completedHookUuids.has(message.uuid);
}

function HookResponseCard({ message }: { message: SDKHookResponseMessage }) {
  const [isExpanded, setIsExpanded] = useState(false);

  const colors = {
    bg: 'bg-surface-raised',
    border: 'border-line',
    text: 'text-fg',
    lightText: 'text-fg-muted',
    iconColor: 'text-fg-muted',
  };

  const summary = message.stdout?.trim() ? message.stdout.split('\n')[0].slice(0, 80) : undefined;

  return (
    <div class="my-2">
      <div class={`border rounded-lg overflow-hidden ${colors.bg} ${colors.border}`}>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          class="w-full flex items-center justify-between p-3 transition-colors hover:bg-opacity-80 dark:hover:bg-opacity-80"
        >
          <div class="flex items-center gap-2 min-w-0 flex-1">
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
              class={`text-xs px-1.5 py-0.5 rounded font-mono ${colors.lightText} bg-surface-raised`}
            >
              {message.hook_event}
            </span>
            {summary && (
              <span class={`text-sm font-mono truncate ${colors.lightText}`}>{summary}</span>
            )}
          </div>

          <div class="flex items-center gap-2 flex-shrink-0">
            {message.exit_code !== undefined && message.exit_code !== 0 && (
              <svg
                class="w-4 h-4 text-danger"
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

        {isExpanded && (
          <div class={`p-3 border-t bg-surface space-y-2 ${colors.border}`}>
            {message.stdout?.trim() && (
              <pre class="text-xs font-mono whitespace-pre-wrap overflow-x-auto bg-surface-raised p-2 rounded border border-line text-fg">
                {message.stdout}
              </pre>
            )}
            {message.stderr?.trim() && (
              <pre class="text-xs font-mono whitespace-pre-wrap overflow-x-auto bg-danger/10 p-2 rounded border border-danger/40 text-danger-soft">
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

function CompactBoundaryMessage({
  message,
}: {
  message: Extract<SystemMessage, { subtype: 'compact_boundary' }>;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  const colors = {
    bg: 'bg-warning/10',
    text: 'text-warning-soft',
    borderColor: '#FFEF00',
    iconColor: 'text-warning',
    lightText: 'text-warning',
  };

  const trigger = message.compact_metadata.trigger === 'manual' ? 'Manual' : 'Auto';
  const preTokens = message.compact_metadata.pre_tokens.toLocaleString();

  return (
    <div class="my-2">
      <div
        class={`border rounded-lg overflow-hidden ${colors.bg}`}
        style={{ borderColor: colors.borderColor }}
      >
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          class="w-full flex items-center justify-between p-3 transition-colors hover:bg-opacity-80 dark:hover:bg-opacity-80"
        >
          <div class="flex items-center gap-2 min-w-0 flex-1">
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

        {isExpanded && (
          <div class="p-3 border-t bg-surface" style={{ borderColor: colors.borderColor }}>
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
