import { NativeContentDisclosure } from '../../../ui/NativeContentDisclosure.tsx';
import MarkdownRenderer from '../../../chat/MarkdownRenderer.tsx';
import type { ParsedThreadRow } from '../space-task-thread-events';
import type { ActiveTurnSummary } from '@hyperneo/shared';
import type { MessageReplacementStatus } from '../../../../lib/sdk-message-replacement';
import { getToolDisplayName, getToolColors } from '../../../sdk/tools/tool-utils';
import type {
  ActiveRosterEntry,
  ResultMessage,
  CompletedFeedTurn,
  ActiveFeedTurn,
  TaskKickoffFeedTurn,
  MessageFeedTurn,
  CompactBoundaryFeedTurn,
  SystemFeedTurn,
  FeedTurn,
} from './feed-builders.ts';
import { ToolIcon } from '../../../sdk/tools/ToolIcon';
import { humanizeSystemSubtype, buildFeedTurns } from './feed-builders.ts';
import { isSDKResultError } from '@hyperneo/shared/sdk/type-guards';
import { pushOverlayHistory } from '../../../../lib/router';
import { SpaceTaskThreadMessageActions } from '../SpaceTaskThreadMessageActions';
import { useVisibleTick } from '../../../../hooks/useVisibleTick';
import { formatDuration, formatClock, agentInitial, shortAgentName } from './minimal-mock-data';
import { getAgentColor, getAgentTextColor } from '../space-task-thread-agent-colors';
import { useMemo } from 'preact/hooks';
import { DeliveryStateBadge } from '../../../ui/DeliveryStateBadge';
import { SyntheticMessageBlock } from '../../../sdk/SyntheticMessageBlock';
import { memo } from 'preact/compat';
import { areTurnRowPropsEqual } from './feed-turn-equality';

interface MinimalThreadFeedProps {
  parsedRows: ParsedThreadRow[];
  activeAgentLabels?: ReadonlySet<string>;
  activeTurnSummaries?: ActiveTurnSummary[];
  overlayTaskId?: string;
  overlayTaskReadonly?: boolean;
}

const TASK_THREAD_MESSAGE_BUBBLE_WIDTH_CLASS = 'max-w-[85%] md:max-w-[86%]';

const TASK_THREAD_AGENT_BUBBLE_WIDTH_CLASS = 'max-w-full md:max-w-[86%]';

function ReplacementBadge({ status }: { status?: MessageReplacementStatus }) {
  if (!status) return null;
  const isRetracted = status === 'retracted';
  return (
    <div
      class={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${
        isRetracted ? 'text-cat-rose' : 'text-warning'
      }`}
      data-message-replacement-status={status}
    >
      {isRetracted ? 'Retracted by fallback' : 'Superseded by replacement'}
    </div>
  );
}

function PulseDot({ color }: { color: string }) {
  return (
    <span
      class="inline-block h-2 w-2 rounded-full minimal-thread-live-dot shrink-0"
      style={{ backgroundColor: color }}
    />
  );
}

function StatusPill({ color, status }: { color: string; status: string }) {
  return (
    <span
      class="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-medium"
      data-testid="minimal-thread-status-pill"
      data-status={status}
    >
      <PulseDot color={color} />
      <span style={{ color }}>{status}</span>
    </span>
  );
}

function rosterToolLabel(toolName: string): string {
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.split('__');
    const serverName = parts[1] || 'unknown';
    const toolShortName = parts.slice(2).join('__') || toolName;
    return `${serverName} ${toolShortName}`;
  }
  return getToolDisplayName(toolName);
}

function RosterEntry({ entry, isLatest }: { entry: ActiveRosterEntry; isLatest: boolean }) {
  const fadeClass = isLatest ? 'minimal-thread-roster-fade-in' : '';
  const bodyClass = `truncate ${isLatest ? 'text-fg' : 'text-fg-muted'}`;

  if (entry.kind === 'tool') {
    const toolColor = getToolColors(entry.tool).iconColor;
    const toolLabel = rosterToolLabel(entry.tool);
    const preview = entry.preview.trim();
    const isSuccess = entry.taskStatus === 'completed';
    const isStopped = entry.taskStatus === 'stopped';
    const isError = entry.taskStatus === 'failed';
    const statusLabel = isStopped ? 'Task stopped' : null;
    return (
      <div
        class={`flex items-start gap-2 font-mono text-xs leading-5 ${fadeClass}`}
        data-testid="minimal-thread-roster-entry"
        data-roster-kind="tool"
        data-task-status={entry.taskStatus ?? undefined}
      >
        <span class="mt-1 shrink-0" aria-hidden="true">
          <ToolIcon toolName={entry.tool} size="xs" />
        </span>
        <span class="min-w-0 truncate">
          <span class={`${toolColor} font-semibold`}>{toolLabel}</span>
          {preview ? (
            <>
              <span class="text-fg-muted">: </span>
              <span class={bodyClass}>{preview}</span>
            </>
          ) : null}
          {statusLabel ? (
            <>
              <span class="text-fg-muted"> — </span>
              <span class="text-warning">{statusLabel}</span>
            </>
          ) : null}
          {entry.taskSummary ? (
            <>
              <span class="text-fg-muted"> — </span>
              <span
                class={
                  isSuccess
                    ? 'text-success'
                    : isStopped
                      ? 'text-warning'
                      : isError
                        ? 'text-danger'
                        : bodyClass
                }
              >
                {entry.taskSummary}
              </span>
            </>
          ) : null}
          {entry.taskUsage ? (
            <span class="text-fg-faint">
              {' '}
              · {entry.taskUsage.total_tokens.toLocaleString()} tok · {entry.taskUsage.tool_uses}{' '}
              tool{entry.taskUsage.tool_uses === 1 ? '' : 's'} ·{' '}
              {(entry.taskUsage.duration_ms / 1000).toFixed(1)}s
            </span>
          ) : null}
        </span>
        {isSuccess && (
          <span class="mt-0.5 shrink-0 text-success" aria-label="task completed">
            ✓
          </span>
        )}
        {isStopped && (
          <span class="mt-0.5 shrink-0 text-warning" aria-label="task stopped">
            ■
          </span>
        )}
        {isError && (
          <span class="mt-0.5 shrink-0 text-danger" aria-label="task failed">
            ✗
          </span>
        )}
      </div>
    );
  }

  if (entry.kind === 'api_retry') {
    const status = entry.errorStatus === null ? 'n/a' : String(entry.errorStatus);
    return (
      <div
        class={`flex items-baseline gap-2 font-mono text-xs leading-5 ${fadeClass}`}
        data-testid="minimal-thread-roster-entry"
        data-roster-kind="api_retry"
      >
        <span class="shrink-0 text-warning" aria-hidden="true">
          ↻
        </span>
        <span class="min-w-0 truncate">
          <span class="font-semibold text-warning">API retry</span>
          <span class="text-fg-muted">: </span>
          <span class={bodyClass}>
            attempt {entry.attempt}/{entry.maxRetries} · status {status} · delay{' '}
            {entry.retryDelayMs}ms
          </span>
        </span>
      </div>
    );
  }

  if (entry.kind === 'task_notification') {
    const isSuccess = entry.status === 'completed';
    const isStopped = entry.status === 'stopped';
    const statusLabel = isSuccess ? 'Task completed' : isStopped ? 'Task stopped' : 'Task failed';
    const statusColor = isSuccess ? 'text-success' : isStopped ? 'text-warning' : 'text-danger';
    return (
      <div
        class={`flex items-start gap-2 font-mono text-xs leading-5 ${fadeClass}`}
        data-testid="minimal-thread-roster-entry"
        data-roster-kind="task_notification"
        data-task-status={entry.status}
      >
        <span class="mt-0.5 shrink-0" aria-hidden="true">
          {isSuccess ? (
            <span class="text-success">✓</span>
          ) : isStopped ? (
            <span class="text-warning">■</span>
          ) : (
            <span class="text-danger">✗</span>
          )}
        </span>
        <span class="min-w-0 truncate">
          <span class={`font-semibold ${statusColor}`}>{statusLabel}</span>
          {entry.summary ? (
            <>
              <span class="text-fg-muted"> — </span>
              <span class={bodyClass}>{entry.summary}</span>
            </>
          ) : null}
          {entry.usage ? (
            <span class="text-fg-faint">
              {' '}
              · {entry.usage.total_tokens.toLocaleString()} tok · {entry.usage.tool_uses} tool
              {entry.usage.tool_uses === 1 ? '' : 's'} ·{' '}
              {(entry.usage.duration_ms / 1000).toFixed(1)}s
            </span>
          ) : null}
        </span>
      </div>
    );
  }

  if (entry.kind === 'status') {
    const statusText = `${humanizeSystemSubtype(entry.status)}…`;
    return (
      <div
        class={`flex items-baseline gap-2 text-xs leading-5 ${fadeClass}`}
        data-testid="minimal-thread-roster-entry"
        data-roster-kind="status"
        data-status={entry.status}
      >
        <span class="shrink-0" aria-hidden="true">
          <PulseDot color="#f59e0b" />
        </span>
        <span class={`${bodyClass} italic`}>{statusText}</span>
      </div>
    );
  }

  if (entry.kind === 'hook') {
    const isRunning = entry.status === 'running';
    const isSuccess = entry.status === 'completed';
    const isError = entry.status === 'failed';
    return (
      <div
        class={`flex items-start gap-2 font-mono text-xs leading-5 ${fadeClass}`}
        data-testid="minimal-thread-roster-entry"
        data-roster-kind="hook"
        data-hook-status={entry.status}
      >
        <span class="mt-0.5 shrink-0" aria-hidden="true">
          {isRunning ? (
            <span class="inline-block h-3 w-3 animate-spin rounded-full border border-fg-faint border-t-transparent" />
          ) : isSuccess ? (
            <span class="text-success">✓</span>
          ) : isError ? (
            <span class="text-danger">✗</span>
          ) : null}
        </span>
        <span class="min-w-0 truncate">
          <span class="font-semibold text-fg-soft">{entry.hookName || 'hook'}</span>
          {entry.hookEvent ? (
            <>
              <span class="text-fg-muted"> · </span>
              <span class="text-fg-muted">{entry.hookEvent}</span>
            </>
          ) : null}
          {entry.summary ? <span class={` ${bodyClass}`}> — {entry.summary}</span> : null}
        </span>
      </div>
    );
  }

  if (entry.kind === 'thinking') {
    const thinkBody = `line-clamp-3 whitespace-pre-wrap italic ${isLatest ? 'text-warning-soft' : 'text-warning/70'}`;
    return (
      <div
        class={`flex items-start gap-2 text-xs leading-5 ${fadeClass}`}
        data-testid="minimal-thread-roster-entry"
        data-roster-kind="thinking"
      >
        <span class="mt-1 shrink-0" aria-hidden="true">
          <ToolIcon toolName="Thinking" size="xs" />
        </span>
        <span class={thinkBody}>{entry.preview}</span>
      </div>
    );
  }

  if (entry.kind === 'user') {
    return (
      <div
        class={`flex items-baseline gap-2 text-xs leading-5 ${fadeClass}`}
        data-testid="minimal-thread-roster-entry"
        data-roster-kind="user"
      >
        <span class="shrink-0 text-accent" aria-hidden="true">
          👤
        </span>
        <span class={bodyClass}>{entry.text}</span>
      </div>
    );
  }

  if (entry.kind === 'handoff') {
    return (
      <div
        class={`flex items-baseline gap-2 text-xs leading-5 ${fadeClass}`}
        data-testid="minimal-thread-roster-entry"
        data-roster-kind="handoff"
      >
        <span class="shrink-0 text-fg-muted" aria-hidden="true">
          ↪
        </span>
        <span class={bodyClass}>{entry.text}</span>
      </div>
    );
  }

  return (
    <div
      class={`flex items-baseline gap-2 text-xs leading-5 ${fadeClass}`}
      data-testid="minimal-thread-roster-entry"
      data-roster-kind="message"
    >
      <svg
        class="w-3 h-3 shrink-0 text-fg-muted self-center"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
        />
      </svg>
      <span class={`${bodyClass} italic`}>{entry.text}</span>
    </div>
  );
}

const INLINE_RESULT_ERROR_SUBTYPES: ReadonlySet<string> = new Set([
  'error_during_execution',
  'error_max_turns',
  'error_max_structured_output_retries',
]);

function isInlineTerminalResultError(result: ResultMessage | undefined): boolean {
  if (!result || !isSDKResultError(result)) return false;
  return INLINE_RESULT_ERROR_SUBTYPES.has(result.subtype);
}

const RESULT_ERROR_SUBTYPE_LABELS: Record<string, string> = {
  error_during_execution: 'Error during execution',
  error_max_turns: 'Max turns reached',
  error_max_structured_output_retries: 'Max structured output retries reached',
};

function getResultErrorSummary(result: ResultMessage): string {
  const errors = (result as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    const first = errors.find((e): e is string => typeof e === 'string' && e.trim().length > 0);
    if (first) return first.trim();
  }
  return RESULT_ERROR_SUBTYPE_LABELS[result.subtype] ?? 'Run failed';
}

function openTurnSessionOverlay(args: {
  sessionId: string;
  agent: string;
  highlightMessageUuid?: string;
  overlayTaskId?: string;
  overlayTaskReadonly?: boolean;
  agentKind: string;
  agentRole: string;
  nodeExecutionId?: string | null;
}): void {
  if (args.overlayTaskId && args.agentKind === 'node_agent') {
    pushOverlayHistory(args.sessionId, args.agent, args.highlightMessageUuid, {
      taskId: args.overlayTaskId,
      agentName: args.agentRole,
      ...(args.nodeExecutionId && !args.overlayTaskReadonly
        ? { nodeExecutionId: args.nodeExecutionId }
        : {}),
      ...(args.overlayTaskReadonly ? { sessionId: args.sessionId, readonly: true } : {}),
    });
    return;
  }
  if (args.overlayTaskId && args.overlayTaskReadonly && args.agentKind === 'task_agent') {
    pushOverlayHistory(args.sessionId, args.agent, args.highlightMessageUuid, {
      taskId: args.overlayTaskId,
      agentName: args.agentRole,
      sessionId: args.sessionId,
      readonly: true,
    });
    return;
  }
  pushOverlayHistory(args.sessionId, args.agent, args.highlightMessageUuid);
}

function CompletedBody({
  turn,
  overlayTaskId,
  overlayTaskReadonly,
}: {
  turn: CompletedFeedTurn;
  overlayTaskId?: string;
  overlayTaskReadonly?: boolean;
}) {
  const isTerminalError = isInlineTerminalResultError(turn.resultInfo);
  const errorSummary =
    isTerminalError && turn.resultInfo ? getResultErrorSummary(turn.resultInfo) : null;
  const openSession = turn.sessionId
    ? () => {
        openTurnSessionOverlay({
          sessionId: turn.sessionId as string,
          agent: turn.agent,
          highlightMessageUuid: turn.highlightMessageUuid,
          overlayTaskId,
          overlayTaskReadonly,
          agentKind: turn.agentKind,
          agentRole: turn.agentRole,
          nodeExecutionId: turn.agentNodeExecutionId,
        });
      }
    : undefined;
  const isErrorBubble = isTerminalError || turn.hasError;
  return (
    <div class={`mt-1.5 w-fit ${TASK_THREAD_AGENT_BUBBLE_WIDTH_CLASS}`}>
      <div
        class={`rounded-lg px-3 py-2 ${
          isErrorBubble
            ? 'bg-danger/20 border border-danger'
            : 'bg-surface-raised border border-line'
        }`}
        data-testid="minimal-thread-agent-bubble"
        data-result-error={isTerminalError ? 'true' : undefined}
        data-has-error={turn.hasError || undefined}
      >
        <ReplacementBadge status={turn.replacementStatus} />
        {turn.hasError ? (
          <div class="flex items-center gap-2 text-danger text-sm font-medium mb-1">
            <svg
              class="w-4 h-4 shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
            <span>API Error</span>
          </div>
        ) : null}
        {errorSummary ? (
          <div
            class="mb-2 flex items-start gap-1.5 text-xs text-danger-soft"
            data-testid="minimal-thread-result-error-summary"
          >
            <svg
              class="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01M5.07 19h13.86a2 2 0 001.74-3L13.74 4a2 2 0 00-3.48 0L3.33 16a2 2 0 001.74 3z"
              />
            </svg>
            <span class="break-words line-clamp-2">{errorSummary}</span>
          </div>
        ) : null}
        {turn.roster.length > 0 ? (
          <div class="mb-2 space-y-0.5">
            {turn.roster.map((entry, i) => (
              <RosterEntry key={`${entry.kind}-${i}`} entry={entry} isLatest={false} />
            ))}
          </div>
        ) : null}
        {turn.lastMessage ? (
          <div
            class={
              turn.hasError
                ? 'text-sm text-danger-soft leading-relaxed [&_a]:text-danger-soft'
                : 'text-sm text-fg leading-relaxed [&_a]:text-accent'
            }
          >
            {turn.fallback ? (
              <p class="whitespace-pre-wrap break-words">{turn.lastMessage}</p>
            ) : (
              <MarkdownRenderer content={turn.lastMessage} />
            )}
          </div>
        ) : null}
      </div>
      <SpaceTaskThreadMessageActions
        timestamp={turn.startedAt}
        copyText={turn.lastMessage}
        align="left"
        onOpenSession={openSession}
        openSessionTitle={
          overlayTaskReadonly ? 'Opens read-only — resume the task to chat' : undefined
        }
        resultInfo={turn.resultInfo}
      />
    </div>
  );
}

function ActiveBody({ turn, color }: { turn: ActiveFeedTurn; color: string }) {
  useVisibleTick(1000);
  const elapsedSec = Math.max(0, Math.round((Date.now() - turn.startedAt) / 1000));
  const lastEventSec = Math.max(0, Math.round((Date.now() - turn.lastEventAt) / 1000));
  const hasSummaryCounts =
    turn.thinkingEntries !== null && turn.messageEntries !== null && turn.toolEntries !== null;
  return (
    <div
      class="mt-1.5 pl-3 border-l-2"
      style={{ borderColor: color }}
      data-testid="minimal-thread-active-rail"
    >
      <div class="text-[11px] text-fg-muted mt-0.5" data-testid="minimal-thread-active-meta">
        {hasSummaryCounts ? (
          <>
            ✦ {turn.thinkingEntries} · 💬 {turn.messageEntries} · ⚙ {turn.toolEntries} ·{' '}
            {formatDuration(elapsedSec)}
          </>
        ) : (
          <>
            {turn.toolCalls} {turn.toolCalls === 1 ? 'tool' : 'tools'} ·{' '}
            {formatDuration(elapsedSec)}
          </>
        )}
      </div>
      {turn.roster.length > 0 ? (
        <div class="mt-2 space-y-0.5">
          {turn.roster.map((entry, i) => (
            <RosterEntry
              key={`${entry.kind}-${i}`}
              entry={entry}
              isLatest={i === turn.roster.length - 1}
            />
          ))}
        </div>
      ) : null}
      <div class="mt-1.5 text-[11px] text-fg-muted" data-testid="minimal-thread-last-event">
        last event {lastEventSec < 1 ? 'now' : `${formatDuration(lastEventSec)} ago`} ·{' '}
        {formatClock(turn.lastEventAt)}
      </div>
    </div>
  );
}

function AgentTurnRow({
  turn,
  overlayTaskId,
  overlayTaskReadonly,
}: {
  turn: CompletedFeedTurn | ActiveFeedTurn;
  overlayTaskId?: string;
  overlayTaskReadonly?: boolean;
}) {
  const color = getAgentColor(turn.agent);
  const textColor = getAgentTextColor(turn.agent);
  const initial = agentInitial(turn.agent);
  const openSession = turn.sessionId
    ? () => {
        openTurnSessionOverlay({
          sessionId: turn.sessionId as string,
          agent: turn.agent,
          highlightMessageUuid: turn.state === 'completed' ? turn.highlightMessageUuid : undefined,
          overlayTaskId,
          overlayTaskReadonly,
          agentKind: turn.agentKind,
          agentRole: turn.agentRole,
          nodeExecutionId: turn.agentNodeExecutionId,
        });
      }
    : undefined;
  const headerContent = (
    <>
      <div
        class="h-9 w-9 shrink-0 rounded-md flex items-center justify-center text-sm font-bold text-dark-950"
        style={{ backgroundColor: color }}
        aria-hidden="true"
      >
        {initial}
      </div>
      <div class="flex flex-col gap-0.5 min-w-0">
        <div class="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 min-w-0">
          <span class="font-semibold leading-tight" style={{ color: textColor }}>
            {shortAgentName(turn.agent)}
          </span>
          {turn.state === 'active' ? (
            <span class="text-xs text-fg-muted leading-tight">{formatClock(turn.startedAt)}</span>
          ) : null}
        </div>
        {turn.state === 'completed' ? (
          <div
            class="text-[11px] text-fg-muted leading-tight"
            data-testid="minimal-thread-agent-meta"
          >
            {turn.toolCalls} {turn.toolCalls === 1 ? 'tool call' : 'tool calls'} · {turn.messages}{' '}
            {turn.messages === 1 ? 'message' : 'messages'} · {formatDuration(turn.durationSec)}
          </div>
        ) : (
          <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <StatusPill color={color} status={turn.status} />
            <span class="text-[11px] text-fg-muted leading-tight">
              {turn.messages} {turn.messages === 1 ? 'message' : 'messages'}
            </span>
          </div>
        )}
      </div>
    </>
  );
  return (
    <div
      data-testid="minimal-thread-turn"
      data-agent-label={turn.agent}
      data-agent-color={color}
      data-turn-state={turn.state}
    >
      {openSession ? (
        <button
          type="button"
          class="-m-1 flex min-h-11 max-w-full items-center gap-3 rounded-lg p-1 pr-2 text-left transition-colors hover:bg-surface-raised/55 active:bg-surface-raised/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
          onClick={openSession}
          title={overlayTaskReadonly ? 'Opens read-only — resume the task to chat' : 'Open session'}
          aria-label={`Open ${turn.agent} session${overlayTaskReadonly ? ' read-only' : ''}`}
          data-testid="minimal-thread-agent-open"
        >
          {headerContent}
        </button>
      ) : (
        <div class="flex min-h-11 items-center gap-3">{headerContent}</div>
      )}
      {turn.state === 'active' ? (
        <ActiveBody turn={turn} color={color} />
      ) : (
        <CompletedBody
          turn={turn}
          overlayTaskId={overlayTaskId}
          overlayTaskReadonly={overlayTaskReadonly}
        />
      )}
    </div>
  );
}

function TaskKickoffTurn({ turn }: { turn: TaskKickoffFeedTurn }) {
  const color = getAgentTextColor(turn.agent);
  const undelivered = turn.deliveryState !== null && turn.deliveryState !== 'delivered';
  return (
    <div
      data-testid="minimal-thread-turn"
      data-turn-state="task_kickoff"
      data-agent-label={turn.agent}
      data-agent-color={color}
    >
      <NativeContentDisclosure
        label="Task kickoff"
        summary={
          <span
            class="inline-flex max-w-[calc(100%-3rem)] items-center gap-2 text-xs text-fg-muted"
            data-testid="minimal-thread-task-kickoff"
          >
            <span class="truncate">
              {undelivered ? 'Task for' : 'Task sent to'}{' '}
              <span style={{ color }}>{turn.agent}</span>
            </span>
            {undelivered ? (
              <DeliveryStateBadge
                state={turn.deliveryState}
                class="shrink-0"
                test-id="minimal-thread-delivery-state"
              />
            ) : null}
            <span class="shrink-0 text-[11px] text-fg-faint">{formatClock(turn.createdAt)}</span>
          </span>
        }
      >
        {(control) =>
          control && (
            <div
              class={`mt-2 ${TASK_THREAD_AGENT_BUBBLE_WIDTH_CLASS} rounded-lg border border-line bg-surface/40 px-3 py-2 text-sm text-fg-soft`}
              data-testid="minimal-thread-task-kickoff-body"
            >
              <MarkdownRenderer content={turn.body} />
              <div class="flow-root">{control}</div>
            </div>
          )
        }
      </NativeContentDisclosure>
    </div>
  );
}

function HumanMessageTurn({ turn }: { turn: MessageFeedTurn }) {
  const recipientColor = getAgentColor(turn.toLabel);
  return (
    <div
      class="flex justify-end"
      data-testid="minimal-thread-turn"
      data-turn-state="message"
      data-message-kind="human"
      data-agent-label={turn.toLabel}
      data-agent-color={recipientColor}
      data-from-label={turn.fromLabel}
      data-to-label={turn.toLabel}
    >
      <div class={`${TASK_THREAD_MESSAGE_BUBBLE_WIDTH_CLASS} w-auto`}>
        <div
          class="bg-accent text-accent-fg rounded-[20px] px-4 py-2 leading-relaxed break-words"
          data-testid="minimal-thread-human-bubble"
        >
          <ReplacementBadge status={turn.replacementStatus} />
          {turn.body ? (
            <p class="whitespace-pre-wrap break-words">{turn.body}</p>
          ) : (
            <p class="opacity-70 italic">(empty message)</p>
          )}
        </div>
        {turn.deliveryState && turn.deliveryState !== 'delivered' ? (
          <div class="mt-1 flex justify-end">
            <DeliveryStateBadge
              state={turn.deliveryState}
              test-id="minimal-thread-delivery-state"
            />
          </div>
        ) : null}
        <SpaceTaskThreadMessageActions
          timestamp={turn.createdAt}
          copyText={turn.body}
          align="right"
          sessionInit={turn.sessionInit}
        />
      </div>
    </div>
  );
}

function CompactBoundaryTurn({
  turn,
  overlayTaskId,
  overlayTaskReadonly,
}: {
  turn: CompactBoundaryFeedTurn;
  overlayTaskId?: string;
  overlayTaskReadonly?: boolean;
}) {
  const color = getAgentTextColor(turn.agent);
  const tokenDelta =
    typeof turn.postTokens === 'number' ? Math.max(0, turn.preTokens - turn.postTokens) : null;
  const tokenSummary = `${turn.preTokens.toLocaleString()} → ${turn.postTokens?.toLocaleString() ?? '—'} tokens`;
  const openSession = turn.sessionId
    ? () => {
        openTurnSessionOverlay({
          sessionId: turn.sessionId as string,
          agent: turn.agent,
          highlightMessageUuid: turn.highlightMessageUuid,
          overlayTaskId,
          overlayTaskReadonly,
          agentKind: turn.agentKind,
          agentRole: turn.agentRole,
          nodeExecutionId: turn.agentNodeExecutionId,
        });
      }
    : undefined;
  const card = (
    <div class="w-full rounded-lg border border-yellow-300/50 bg-warning/10 px-3 py-2 text-warning-soft shadow-sm shadow-yellow-950/20 dark:border-yellow-400/30">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <span class="h-2 w-2 rounded-full bg-yellow-300 shadow-[0_0_10px_rgba(253,224,71,0.65)]" />
          <span class="text-xs font-semibold uppercase tracking-[0.16em] text-warning-soft">
            Compact Boundary
          </span>
          <span class="text-[11px] text-warning-soft/80" style={{ color }}>
            {shortAgentName(turn.agent)}
          </span>
        </div>
        <span class="shrink-0 text-[11px] text-warning-soft/70">{formatClock(turn.createdAt)}</span>
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-warning-soft/90">
        <span class="rounded-full border border-yellow-300/30 bg-yellow-300/10 px-2 py-0.5 font-medium capitalize text-warning-soft">
          {turn.trigger}
        </span>
        <span>{tokenSummary}</span>
        {tokenDelta !== null ? (
          <span class="text-warning-soft/75">saved {tokenDelta.toLocaleString()}</span>
        ) : null}
        {typeof turn.durationMs === 'number' ? (
          <span class="text-warning-soft/75">
            {formatDuration(Math.max(1, Math.round(turn.durationMs / 1000)))}
          </span>
        ) : null}
      </div>
    </div>
  );

  return (
    <div
      data-testid="minimal-thread-turn"
      data-turn-state="compact_boundary"
      data-agent-label={turn.agent}
      data-agent-color={color}
    >
      {openSession ? (
        <button
          type="button"
          class="w-full rounded-lg text-left transition-colors hover:bg-warning/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-warning/60"
          onClick={openSession}
          title={overlayTaskReadonly ? 'Opens read-only — resume the task to chat' : 'Open session'}
          aria-label={`Open ${turn.agent} session at compact boundary${
            overlayTaskReadonly ? ' read-only' : ''
          }`}
          data-testid="minimal-thread-compact-boundary"
        >
          {card}
        </button>
      ) : (
        <div data-testid="minimal-thread-compact-boundary">{card}</div>
      )}
    </div>
  );
}

function SystemTurn({
  turn,
  overlayTaskId,
  overlayTaskReadonly,
}: {
  turn: SystemFeedTurn;
  overlayTaskId?: string;
  overlayTaskReadonly?: boolean;
}) {
  const color = getAgentTextColor(turn.agent);
  const openSession = turn.sessionId
    ? () => {
        openTurnSessionOverlay({
          sessionId: turn.sessionId as string,
          agent: turn.agent,
          highlightMessageUuid: turn.highlightMessageUuid,
          overlayTaskId,
          overlayTaskReadonly,
          agentKind: turn.agentKind,
          agentRole: turn.agentRole,
          nodeExecutionId: turn.agentNodeExecutionId,
        });
      }
    : undefined;
  const card = (
    <div class="w-fit max-w-full rounded-lg border border-line bg-surface/40 px-3 py-2 text-fg-soft">
      <ReplacementBadge status={turn.replacementStatus} />
      <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span class="text-[11px] font-semibold uppercase tracking-[0.16em] text-fg-muted">
          {turn.title}
        </span>
        <span class="text-[11px] text-fg-faint" style={{ color }}>
          {shortAgentName(turn.agent)}
        </span>
        <span class="text-[11px] text-fg-faint">{formatClock(turn.createdAt)}</span>
      </div>
      <div class="mt-1 text-xs text-fg-soft">{turn.body}</div>
    </div>
  );

  return (
    <div
      data-testid="minimal-thread-turn"
      data-turn-state="system"
      data-agent-label={turn.agent}
      data-agent-color={color}
    >
      {openSession ? (
        <button
          type="button"
          class="rounded-lg text-left transition-colors hover:bg-slate-800/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-fg-muted/60"
          onClick={openSession}
          title={overlayTaskReadonly ? 'Opens read-only — resume the task to chat' : 'Open session'}
          aria-label={`Open ${turn.agent} session at ${turn.title}${
            overlayTaskReadonly ? ' read-only' : ''
          }`}
          data-testid="minimal-thread-system"
        >
          {card}
        </button>
      ) : (
        <div data-testid="minimal-thread-system">{card}</div>
      )}
    </div>
  );
}

function SyntheticMessageTurn({
  turn,
  overlayTaskId,
  overlayTaskReadonly,
}: {
  turn: MessageFeedTurn;
  overlayTaskId?: string;
  overlayTaskReadonly?: boolean;
}) {
  const fromColor = getAgentTextColor(turn.fromLabel);
  const toColor = getAgentTextColor(turn.toLabel);
  const fromShort = shortAgentName(turn.fromLabel);
  const toShort = shortAgentName(turn.toLabel);
  const replacementFrameClass =
    turn.replacementStatus === 'retracted'
      ? 'border-rose-500/35 bg-rose-500/5'
      : 'border-warning/35 bg-warning/5';
  const syntheticBlock = (
    <SyntheticMessageBlock
      deliveryState={turn.deliveryState}
      content={turn.body ?? ''}
      timestamp={turn.createdAt}
      uuid={turn.highlightMessageUuid}
      fromAgent={turn.fromLabel}
      toAgent={turn.toLabel}
      fromColor={fromColor}
      toColor={toColor}
      fromShort={fromShort}
      toShort={toShort}
      renderAsPlainText={turn.bodyIsFallback}
      sessionInit={turn.sessionInit}
      widthClass={TASK_THREAD_MESSAGE_BUBBLE_WIDTH_CLASS}
      openSessionTitle={
        overlayTaskReadonly && turn.sessionId
          ? 'Opens read-only — resume the task to chat'
          : undefined
      }
      onOpenSession={
        turn.sessionId
          ? () => {
              openTurnSessionOverlay({
                sessionId: turn.sessionId as string,
                agent: turn.toLabel,
                highlightMessageUuid: turn.highlightMessageUuid,
                overlayTaskId,
                overlayTaskReadonly,
                agentKind: turn.toKind,
                agentRole: turn.toRole,
                nodeExecutionId: turn.toNodeExecutionId,
              });
            }
          : undefined
      }
    />
  );

  return (
    <div
      data-testid="minimal-thread-turn"
      data-turn-state="message"
      data-message-kind="synthetic"
      data-agent-label={turn.toLabel}
      data-agent-color={toColor}
      data-from-label={turn.fromLabel}
      data-to-label={turn.toLabel}
    >
      {turn.replacementStatus ? (
        <div class={`${TASK_THREAD_MESSAGE_BUBBLE_WIDTH_CLASS}`}>
          <div class={`mb-1 rounded-lg border px-2 py-1 ${replacementFrameClass}`}>
            <ReplacementBadge status={turn.replacementStatus} />
          </div>
          {syntheticBlock}
        </div>
      ) : (
        syntheticBlock
      )}
    </div>
  );
}

function MinimalTurnRow({
  turn,
  overlayTaskId,
  overlayTaskReadonly,
}: {
  turn: FeedTurn;
  overlayTaskId?: string;
  overlayTaskReadonly?: boolean;
}) {
  if (turn.state === 'task_kickoff') {
    return <TaskKickoffTurn turn={turn} />;
  }
  if (turn.state === 'compact_boundary') {
    return (
      <CompactBoundaryTurn
        turn={turn}
        overlayTaskId={overlayTaskId}
        overlayTaskReadonly={overlayTaskReadonly}
      />
    );
  }
  if (turn.state === 'system') {
    return (
      <SystemTurn
        turn={turn}
        overlayTaskId={overlayTaskId}
        overlayTaskReadonly={overlayTaskReadonly}
      />
    );
  }
  if (turn.state === 'message') {
    return turn.isSynthetic ? (
      <SyntheticMessageTurn
        turn={turn}
        overlayTaskId={overlayTaskId}
        overlayTaskReadonly={overlayTaskReadonly}
      />
    ) : (
      <HumanMessageTurn turn={turn} />
    );
  }
  return (
    <AgentTurnRow
      turn={turn}
      overlayTaskId={overlayTaskId}
      overlayTaskReadonly={overlayTaskReadonly}
    />
  );
}

const MemoizedTurnRow = memo(MinimalTurnRow, areTurnRowPropsEqual);

const EMPTY_ACTIVE_AGENT_LABELS: ReadonlySet<string> = new Set();

const EMPTY_ACTIVE_TURN_SUMMARIES: ActiveTurnSummary[] = [];

export function MinimalThreadFeed({
  parsedRows,
  activeAgentLabels = EMPTY_ACTIVE_AGENT_LABELS,
  activeTurnSummaries = EMPTY_ACTIVE_TURN_SUMMARIES,
  overlayTaskId,
  overlayTaskReadonly,
}: MinimalThreadFeedProps) {
  const turns = useMemo(
    () => buildFeedTurns(parsedRows, activeAgentLabels, activeTurnSummaries),
    [parsedRows, activeAgentLabels, activeTurnSummaries]
  );
  if (turns.length === 0) return null;

  return (
    <>
      <style>{ANIMATIONS_CSS}</style>
      <div class="px-4 py-4 space-y-6" data-testid="space-task-event-feed-minimal">
        {turns.map((turn) => (
          <MemoizedTurnRow
            key={turn.id}
            turn={turn}
            overlayTaskId={overlayTaskId}
            overlayTaskReadonly={overlayTaskReadonly}
          />
        ))}
      </div>
    </>
  );
}

const ANIMATIONS_CSS = `
@keyframes minimal-thread-roster-fade-in-kf {
	from { opacity: 0; transform: translateY(2px); }
	to   { opacity: 1; transform: translateY(0); }
}
.minimal-thread-roster-fade-in {
	animation: minimal-thread-roster-fade-in-kf 250ms ease-out;
}
@keyframes minimal-thread-live-pulse-kf {
	0%, 100% { box-shadow: 0 0 0 0 rgba(255,255,255,0.0); transform: scale(1); }
	50%      { box-shadow: 0 0 0 4px rgba(255,255,255,0.08); transform: scale(1.08); }
}
.minimal-thread-live-dot {
	animation: minimal-thread-live-pulse-kf 1.6s ease-in-out infinite;
}
`;
