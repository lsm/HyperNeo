/**
 * MinimalThreadFeed
 *
 * Production renderer for Space task threads. Maps `parsedRows` into
 * Slack-style turn rows:
 *
 *   ▢ AGENT
 *   ▢   3 tool calls · 8 messages · 47m       ← meta line under name
 *   ▢   <last assistant message bubble>       ← completed turn (no rail)
 *
 *   ▢ AGENT
 *   ▢   9:43 PM
 *   ▢ │ 12 tools · 2m 22s
 *   ▢ │ Bash: bun run typecheck
 *   ▢ │ Read: packages/.../space-task-runtime.ts
 *   ▢ │ 💬 Looking into the failing test…    ← agent text mixes in with tools
 *   ▢ │ Bash: git status
 *   ▢ │ • Running…                            ← active turn (coloured rail)
 *
 * No tool cards, no thinking blocks, no bracket rails. Turn grouping comes
 * from `buildAgentTurns` in `../space-task-thread-turns.ts` (one block per
 * init→result cycle).
 */

import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { ActiveTurnSummary, ActivityEntry, ActorMessageDeliveryState } from '@hyperneo/shared';
import {
  isSDKAssistantMessage,
  isSDKCompactBoundary,
  isHiddenSystemSubtype,
  isConditionallyHiddenSystemMessage,
  isSDKResultError,
  isSDKResultMessage,
  isSDKSystemInit,
  isToolUseBlock,
} from '@hyperneo/shared/sdk/type-guards';

type SystemInitMessage = Extract<SDKMessage, { type: 'system'; subtype: 'init' }>;
type CompactBoundaryMessage = Extract<SDKMessage, { type: 'system'; subtype: 'compact_boundary' }>;
type ResultMessage = Extract<SDKMessage, { type: 'result' }>;
import { useEffect, useState } from 'preact/hooks';
import MarkdownRenderer from '../../../chat/MarkdownRenderer.tsx';
import {
  type AgentTurnBlock,
  buildAgentTurns,
  isUserRow,
  normalizeAgentKey,
} from '../space-task-thread-turns';
import { SyntheticMessageBlock } from '../../../sdk/SyntheticMessageBlock';
import { DeliveryStateBadge } from '../../../ui/DeliveryStateBadge';
import { SpaceTaskThreadMessageActions } from '../SpaceTaskThreadMessageActions';
import { getAgentColor } from '../space-task-thread-agent-colors';
import type { ParsedThreadRow } from '../space-task-thread-events';
import { pushOverlayHistory } from '../../../../lib/router';
import {
  buildMessageReplacementStatusMap,
  getMessageUuid,
  type MessageReplacementStatus,
} from '../../../../lib/sdk-message-replacement';
import { agentInitial, formatClock, formatDuration, shortAgentName } from './minimal-mock-data';
import { ToolIcon } from '../../../sdk/tools/ToolIcon';
import { getToolColors, getToolDisplayName } from '../../../sdk/tools/tool-utils';

interface MinimalThreadFeedProps {
  parsedRows: ParsedThreadRow[];
  /**
   * Labels of agents whose underlying sessions are currently executing.
   * The trailing non-terminal block **for each label in this set** renders as
   * the active turn (coloured rail, live tool roster, ticking elapsed clock).
   *
   * Per-agent rather than a single boolean: in multi-session workflows
   * (e.g. Coder + Reviewer interleaved), the Reviewer's terminal `result`
   * row can land *after* the Coder's last visible row. With a single
   * boolean + globally-trailing block check, that suppresses the Coder's
   * still-running rail because the global tail is now terminal. Keying
   * activity by agent label lets each agent's trailing block be upgraded
   * independently of what other agents emitted afterwards.
   *
   * Labels are matched case-insensitively / whitespace-insensitively against
   * each block's `agentLabel` so activity-member labels (which are run
   * through a title-casing helper on the daemon) collide with raw row
   * labels (e.g. "coder agent" → "Coder Agent").
   */
  activeAgentLabels?: ReadonlySet<string>;
  /**
   * Server-derived activity summaries — one per session with an active
   * (non-terminal) turn. The roster on each active feed turn is built from
   * the matching summary's full entry list, so the rail stays accurate even
   * when the compact feed has dropped older non-terminal rows from the
   * trailing turn. Empty array when no session is mid-turn.
   *
   * Optional for backwards-compatibility with tests / call sites that
   * haven't been updated; an absent payload silently falls back to no
   * roster (rather than the previous client-side derivation, which is now
   * gone).
   */
  activeTurnSummaries?: ActiveTurnSummary[];
  /** Task id used to preserve node-agent task messaging when opening overlays. */
  overlayTaskId?: string;
}

/**
 * Active-turn roster entry. The roster surfaces what the agent is "doing right
 * now" — tool invocations interleaved with the assistant's own outputs and the
 * user-side rows (real human input or synthetic agent→agent handoff) that are
 * sitting inside the active turn.
 *
 * Tagged on `kind` so the renderer can switch between distinct visuals:
 *   - `tool`     : `BashCmd: bun run typecheck`             (colored TOOL: + preview)
 *   - `message`  : `💬 Investigating the failing test…`     (chat glyph + italic body)
 *   - `thinking` : `✦ Considering edge cases…`              (sparkle + dim italic body)
 *   - `user`     : `👤 You: please retry`                   (user glyph + body)
 *   - `handoff`  : `↪ Reviewer Agent: please verify`        (handoff glyph + body)
 *
 * Server-derived: shapes mirror `ActivityEntry` from `@hyperneo/shared` 1:1. The
 * mapping happens in `rosterEntriesFromSummary` so the renderer stays decoupled
 * from the wire format.
 */
interface RosterToolEntry {
  kind: 'tool';
  tool: string;
  preview: string;
  ts: number;
  /** Links to a task_notification (by tool_use_id) so the roster can show the
   * task's terminal status inline. Resolved at turn-build time. */
  toolUseId?: string;
  taskStatus?: 'completed' | 'failed' | 'stopped';
  taskSummary?: string;
  taskUsage?: { total_tokens: number; tool_uses: number; duration_ms: number };
}
interface RosterMessageEntry {
  kind: 'message';
  text: string;
  ts: number;
}
interface RosterThinkingEntry {
  kind: 'thinking';
  preview: string;
  ts: number;
}
interface RosterUserEntry {
  kind: 'user';
  text: string;
  ts: number;
}
interface RosterHandoffEntry {
  kind: 'handoff';
  text: string;
  ts: number;
}
interface RosterHookEntry {
  kind: 'hook';
  hookName: string;
  hookEvent: string;
  status: 'running' | 'completed' | 'failed';
  summary?: string;
  ts: number;
}
interface RosterApiRetryEntry {
  kind: 'api_retry';
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
  ts: number;
  uuid: string;
}
/**
 * Standalone task outcome entry — rendered directly in the roster (chat-
 * container style: ✓/■/✗ + summary + usage) for task_notifications whose
 * originating tool_use is NOT in the roster (capped out / orphan / completed
 * turn). When the tool_use IS rostered, the outcome folds onto its tool card
 * instead (see foldTaskNotification) so these two never duplicate.
 */
interface RosterTaskNotificationEntry {
  kind: 'task_notification';
  status: 'completed' | 'failed' | 'stopped';
  summary?: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  ts: number;
  toolUseId?: string;
}
interface RosterStatusEntry {
  kind: 'status';
  status: string;
  ts: number;
}
type ActiveRosterEntry =
  | RosterToolEntry
  | RosterMessageEntry
  | RosterThinkingEntry
  | RosterUserEntry
  | RosterHandoffEntry
  | RosterHookEntry
  | RosterApiRetryEntry
  | RosterTaskNotificationEntry
  | RosterStatusEntry;

const TASK_THREAD_MESSAGE_BUBBLE_WIDTH_CLASS = 'max-w-[85%] md:max-w-[86%]';
const TASK_THREAD_AGENT_BUBBLE_WIDTH_CLASS = 'max-w-full md:max-w-[86%]';

interface CompletedFeedTurn {
  state: 'completed';
  id: string;
  agent: string;
  agentKind: 'task_agent' | 'node_agent';
  agentRole: string;
  agentNodeExecutionId?: string | null;
  startedAt: number;
  durationSec: number;
  toolCalls: number;
  messages: number;
  lastMessage: string;
  fallback: boolean;
  /**
   * True when the surfaced assistant reply carries an SDK `error` field
   * (e.g. `error: 'invalid_request'`). Renders the bubble with red error
   * styling + an "API Error" header, mirroring SDKAssistantMessage's
   * hasError branch, instead of the normal gray reply bubble.
   */
  hasError: boolean;
  /**
   * Session id that produced this turn's reply text. Used by the
   * "open in session" affordance so clicking the button lands the user
   * on the right session even when multiple sessions are interleaved
   * in the feed. Null when the underlying row had no resolvable session.
   */
  sessionId: string | null;
  /**
   * SDK message UUID of the row whose text was surfaced as `lastMessage`.
   * Forwarded as `highlightMessageId` to the slide-over so that message
   * is scrolled to + briefly highlighted on open. May be undefined when
   * we fell back to `fallbackText` and no SDK message was available.
   */
  highlightMessageUuid?: string;
  replacementStatus?: MessageReplacementStatus;
  /**
   * SDK `result` envelope for the exec that produced this turn. When
   * present, the actions row renders a result-info dropdown surfacing
   * usage tokens / cost / duration / errors. Undefined when the block
   * is non-terminal (e.g. the trailing fragment of a still-running
   * exec) — the result message hasn't arrived yet.
   */
  resultInfo?: ResultMessage;
  roster: ActiveRosterEntry[];
}

interface ActiveFeedTurn {
  state: 'active';
  id: string;
  agent: string;
  agentKind: 'task_agent' | 'node_agent';
  agentRole: string;
  agentNodeExecutionId?: string | null;
  startedAt: number;
  status: string;
  toolCalls: number;
  messages: number;
  thinkingEntries: number | null;
  messageEntries: number | null;
  toolEntries: number | null;
  lastEventAt: number;
  roster: ActiveRosterEntry[];
  /** Session id for the still-running turn; used by the agent header open affordance. */
  sessionId: string | null;
}

interface CompactBoundaryFeedTurn {
  state: 'compact_boundary';
  id: string;
  agent: string;
  agentKind: 'task_agent' | 'node_agent';
  agentRole: string;
  agentNodeExecutionId?: string | null;
  createdAt: number;
  trigger: 'manual' | 'auto';
  preTokens: number;
  postTokens?: number;
  durationMs?: number;
  sessionId: string | null;
  highlightMessageUuid?: string;
}

interface SystemFeedTurn {
  state: 'system';
  id: string;
  agent: string;
  agentKind: 'task_agent' | 'node_agent';
  agentRole: string;
  agentNodeExecutionId?: string | null;
  createdAt: number;
  title: string;
  body: string;
  sessionId: string | null;
  highlightMessageUuid?: string;
  replacementStatus?: MessageReplacementStatus;
}

interface MessageFeedTurn {
  state: 'message';
  id: string;
  /** Human-readable sender label (e.g. "User", "Reviewer Agent"). */
  fromLabel: string;
  /** Recipient agent label — the session this row belongs to. */
  toLabel: string;
  /** Recipient agent kind, used to avoid node-agent routing for Task Agent sessions. */
  toKind: 'task_agent' | 'node_agent';
  /** Raw workflow slot/role name for routing task messages. */
  toRole: string;
  /** Node execution id for exact routing to duplicate-named node agents. */
  toNodeExecutionId?: string | null;
  /** Rendered message text (markdown when not fallback). */
  body: string;
  bodyIsFallback: boolean;
  createdAt: number;
  /** True for synthetic agent→agent / system handoffs; false for human input. */
  isSynthetic: boolean;
  /** Recipient session id — same role as `CompletedFeedTurn.sessionId`. */
  sessionId: string | null;
  /** User-message delivery state, shown as a small send-state badge. */
  deliveryState?: ActorMessageDeliveryState | null;
  /** SDK message UUID, used to deep-link the slide-over. */
  highlightMessageUuid?: string;
  replacementStatus?: MessageReplacementStatus;
  /**
   * SDK `system:init` envelope for the recipient agent's exec — the agent
   * state this user message landed in. When present, the actions row
   * renders an info-circle dropdown surfacing model / cwd / tools / mcp
   * servers. Undefined when no init message exists in the same logical
   * block (e.g. for replays, or messages that didn't trigger a new exec).
   */
  sessionInit?: SystemInitMessage;
}

type FeedTurn =
  | CompletedFeedTurn
  | ActiveFeedTurn
  | CompactBoundaryFeedTurn
  | SystemFeedTurn
  | MessageFeedTurn;

const ROSTER_MAX_ENTRIES = 8;

function applyReplacementStatuses(rows: ParsedThreadRow[]): ParsedThreadRow[] {
  const messages = rows
    .map((row) => row.message)
    .filter((message): message is SDKMessage => message !== null);
  const statusMap = buildMessageReplacementStatusMap(messages);
  if (statusMap.size === 0) return rows;

  return rows.map((row) => {
    const uuid = getMessageUuid(row.message);
    const replacementStatus = uuid ? statusMap.get(uuid) : undefined;
    return replacementStatus ? { ...row, replacementStatus } : row;
  });
}

function ReplacementBadge({ status }: { status?: MessageReplacementStatus }) {
  if (!status) return null;
  const isRetracted = status === 'retracted';
  return (
    <div
      class={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${
        isRetracted ? 'text-rose-300' : 'text-amber-300'
      }`}
      data-message-replacement-status={status}
    >
      {isRetracted ? 'Retracted by fallback' : 'Superseded by replacement'}
    </div>
  );
}

function getToolUseContentBlocks(row: ParsedThreadRow) {
  if (!row.message || !isSDKAssistantMessage(row.message)) return [];
  const content = (row.message as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is { type: 'tool_use'; name: string; input?: unknown } =>
    isToolUseBlock(block as never)
  );
}

function parseSystemStatusRow(
  row: ParsedThreadRow
): { status: string; isClear: false } | { status: null; isClear: true } | null {
  const msg = row.message;
  if (!msg || msg.type !== 'system') return null;
  if ((msg as { subtype?: string }).subtype !== 'status') return null;
  const status = (msg as { status?: unknown }).status;
  if (status === null) return { status: null, isClear: true };
  if (typeof status === 'string' && status) return { status, isClear: false };
  return null;
}

function isFoldedSystemStatusRow(
  row: ParsedThreadRow,
  consumedStatusRowIds: ReadonlySet<string>
): boolean {
  return consumedStatusRowIds.has(String(row.id));
}

/**
 * Translate the server-derived `ActivityEntry` union into the renderer's
 * tagged `ActiveRosterEntry` shape and apply the display cap (most-recent
 * wins). Server entries are already chronologically sorted and have their
 * previews/text collapsed onto a single line; the cap is the last piece of
 * presentation policy that lives client-side.
 *
 * Empty `text` entries (e.g. a model response containing only whitespace)
 * are still defensively dropped here even though the server already filters
 * them — defence in depth lets renderer-level invariants hold even if a
 * future server change relaxes the filter.
 */
function rosterEntriesFromSummary(
  summary: ActiveTurnSummary | undefined,
  maxEntries: number
): ActiveRosterEntry[] {
  if (!summary) return [];
  const out: ActiveRosterEntry[] = [];
  for (const entry of summary.entries) {
    const mapped = mapActivityEntry(entry);
    if (mapped) out.push(mapped);
  }
  return out.slice(-maxEntries);
}

/**
 * Defensive string coercion for fields that the typed `ActivityEntry` shape
 * declares as `string`. The daemon already normalises entry-level fields when
 * it builds `ActiveTurnSummary`, but we coerce here as a belt-and-braces guard
 * against a malformed entry crashing the renderer with a `TypeError` on
 * `.trim()`.
 */
function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumber(value: unknown, fallback = 0): number {
  const n = Number(value ?? fallback);
  return Number.isFinite(n) ? n : fallback;
}

function mapActivityEntry(entry: ActivityEntry): ActiveRosterEntry | null {
  switch (entry.kind) {
    case 'tool_use':
      return {
        kind: 'tool',
        tool: typeof entry.toolName === 'string' ? entry.toolName : '',
        preview: typeof entry.preview === 'string' ? entry.preview : '',
        ts: entry.ts,
        ...(typeof entry.toolUseId === 'string' ? { toolUseId: entry.toolUseId } : {}),
      };
    case 'text': {
      const text = asTrimmedString(entry.text);
      if (!text) return null;
      return { kind: 'message', text, ts: entry.ts };
    }
    case 'thinking': {
      const preview = asTrimmedString(entry.preview);
      if (!preview) return null;
      return { kind: 'thinking', preview, ts: entry.ts };
    }
    case 'user_message': {
      const text = asTrimmedString(entry.text);
      if (!text) return null;
      return { kind: 'user', text, ts: entry.ts };
    }
    case 'agent_handoff': {
      const text = asTrimmedString(entry.text);
      if (!text) return null;
      return { kind: 'handoff', text, ts: entry.ts };
    }
    case 'hook': {
      const summary = asTrimmedString(entry.summary);
      return {
        kind: 'hook',
        hookName: typeof entry.hookName === 'string' ? entry.hookName : '',
        hookEvent: typeof entry.hookEvent === 'string' ? entry.hookEvent : '',
        status:
          entry.status === 'completed' || entry.status === 'failed' ? entry.status : 'running',
        ts: entry.ts,
        ...(summary ? { summary } : {}),
      };
    }
    case 'api_retry':
      return {
        kind: 'api_retry',
        attempt: finiteNumber(entry.attempt, 1),
        maxRetries: finiteNumber(entry.maxRetries),
        retryDelayMs: finiteNumber(entry.retryDelayMs),
        errorStatus: entry.errorStatus === null ? null : finiteNumber(entry.errorStatus),
        ts: entry.ts,
        uuid: typeof entry.uuid === 'string' ? entry.uuid : '',
      };
    default:
      return null;
  }
}

/**
 * Count tool calls within the active turn from the server-derived summary
 * (preferred — covers the *full* turn, not the truncated compact slice) or
 * fall back to the parsed rows when no summary is available.
 */
function countToolCallsForActive(
  rows: ParsedThreadRow[],
  summary: ActiveTurnSummary | undefined
): number {
  if (summary) {
    let n = 0;
    for (const e of summary.entries) {
      if (e.kind === 'tool_use') n += 1;
    }
    return n;
  }
  let n = 0;
  for (const row of rows) {
    n += getToolUseContentBlocks(row).length;
  }
  return n;
}

function countToolCalls(rows: ParsedThreadRow[]): number {
  let n = 0;
  for (const row of rows) {
    n += getToolUseContentBlocks(row).length;
  }
  return n;
}

function countSummaryEntries(
  summary: ActiveTurnSummary | undefined,
  kind: ActivityEntry['kind']
): number | null {
  if (!summary) return null;
  let n = 0;
  for (const entry of summary.entries) {
    if (entry.kind === kind) n += 1;
  }
  return n;
}

function countMessagesForActive(rows: ParsedThreadRow[]): number {
  return rows.length;
}

function latestActivityTimestamp(
  summary: ActiveTurnSummary | undefined,
  rows: ParsedThreadRow[]
): number {
  const lastEntry = summary?.entries[summary.entries.length - 1];
  return lastEntry?.ts ?? rows[rows.length - 1]?.createdAt ?? Date.now();
}

function latestTurnIndex(rows: ParsedThreadRow[]): number | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (typeof rows[i].turnIndex === 'number') return rows[i].turnIndex;
  }
  return undefined;
}

function summaryMatchesTurn(
  summary: ActiveTurnSummary | undefined,
  rows: ParsedThreadRow[]
): ActiveTurnSummary | undefined {
  if (!summary) return undefined;
  const turnIndex = latestTurnIndex(rows);
  return turnIndex !== undefined && summary.turnIndex === turnIndex ? summary : undefined;
}

function rowsContainResult(
  rows: ParsedThreadRow[],
  resultInfo: ResultMessage | undefined
): boolean {
  return resultInfo !== undefined && rows.some((row) => row.message === resultInfo);
}

/**
 * Whether a row slice contains any non-success result message. Used to keep
 * error-only turns (no assistant text) visible and to collect their
 * tool_use_ids for task_notification folding — covering ALL error subtypes
 * (including error_max_budget_usd), since visibility is separate from the
 * narrower inline red-bubble treatment.
 */
function rowsContainResultError(rows: ParsedThreadRow[]): boolean {
  return rows.some((row) => row.message && isSDKResultError(row.message));
}

function latestSessionId(rows: ParsedThreadRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].sessionId) return rows[i].sessionId;
  }
  return null;
}

/**
 * Session id of the active turn represented by a block. Status rows and
 * compact_boundary rows can carry a different session id than the agent rows
 * they annotate (or no session id at all), so the active turn's session must
 * be derived from the last *non-status, non-boundary, non-user* row. Using the
 * raw `latestSessionId` would let a later cross-session status row hijack the
 * turn's identity and either mis-attach the status or suppress its fallback.
 */
function activeTurnSessionId(rows: ParsedThreadRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row.sessionId) continue;
    if (parseSystemStatusRow(row)) continue;
    if (row.message && isSDKCompactBoundary(row.message)) continue;
    if (isUserRow(row)) continue;
    return row.sessionId;
  }
  return null;
}

/**
 * Extract the closing text for a turn, walking rows last-to-first.
 *
 * Two viable text sources:
 *   1. `assistant` rows — the model's `text` content blocks. Standard path,
 *      and the preferred deep-link target so the chat-bubble click highlights
 *      the agent's actual reply rather than the green result envelope below it.
 *   2. `result|success` rows — the SDK's end-of-exec envelope, whose top-level
 *      `result` string carries the agent's final reply. Used as a fallback for
 *      turns where the agent emitted only `tool_use` / `thinking` blocks (e.g.
 *      Reviewer runs that verify with Bash and never write a textual reply
 *      mid-stream).
 *
 * Walk order: last-to-first looking for an assistant row with text. While
 * walking, capture the most recent result-success row as a fallback candidate.
 * Return the assistant row if found; otherwise fall back to the captured
 * result row.
 *
 * Returns the surfaced row alongside the text so callers can build deep links
 * back to the original SDK message (sessionId + uuid) for the slide-over.
 */
function extractLastAssistantText(rows: ParsedThreadRow[]): {
  text: string;
  fallback: boolean;
  sourceRow: ParsedThreadRow | null;
  /**
   * True when the surfaced assistant reply (or any assistant row in the turn,
   * when text came from a fallback) carries an SDK `error` field — e.g.
   * `error: 'invalid_request'`. Drives the red error-bubble treatment in
   * CompletedBody, mirroring SDKAssistantMessage's `hasError` branch.
   */
  hasError: boolean;
} {
  let resultFallback: { text: string; sourceRow: ParsedThreadRow } | null = null;
  let assistantHasError = false;

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row.message) continue;

    // Result-success rows carry the agent's final reply on `.result`.
    // Capture the most recent one as a fallback — but keep walking in case
    // there is an assistant message above it we'd rather highlight.
    if (isSDKResultMessage(row.message) && row.message.subtype === 'success') {
      if (!resultFallback) {
        const result = (row.message as { result?: unknown }).result;
        if (typeof result === 'string' && result.trim().length > 0) {
          resultFallback = { text: result.trim(), sourceRow: row };
        }
      }
      continue;
    }

    if (!isSDKAssistantMessage(row.message)) continue;
    // An assistant message may carry an `error` field (e.g. a 400
    // invalid_request) alongside its text content. Track it so the reply
    // bubble renders red instead of the normal gray, matching the chat
    // transcript (SDKAssistantMessage detects the same field).
    const hasError =
      'error' in row.message && (row.message as { error?: unknown }).error !== undefined;
    if (hasError) assistantHasError = true;
    const content = (row.message as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) continue;
    const texts = content
      .filter(
        (block): block is { type: 'text'; text: string } =>
          typeof (block as { type?: unknown }).type === 'string' &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
      )
      .map((block) => block.text.trim())
      .filter((s) => s.length > 0);
    if (texts.length > 0)
      return { text: texts.join('\n\n'), fallback: false, sourceRow: row, hasError };
  }

  // No assistant text anywhere in the turn — fall back to the result envelope.
  if (resultFallback) {
    return {
      text: resultFallback.text,
      fallback: false,
      sourceRow: resultFallback.sourceRow,
      hasError: assistantHasError,
    };
  }

  const tail = rows[rows.length - 1] ?? null;
  const tailFallback = tail?.fallbackText ?? '';
  return { text: tailFallback, fallback: true, sourceRow: tail, hasError: assistantHasError };
}

type TaskNotificationLite = {
  status: 'completed' | 'failed' | 'stopped';
  summary?: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
};

const COMPLETED_TOOL_PREVIEW_MAX_CHARS = 100;

function capCompletedToolPreview(value: string): string {
  const oneLine = value.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= COMPLETED_TOOL_PREVIEW_MAX_CHARS) return oneLine;
  return `${oneLine.slice(0, COMPLETED_TOOL_PREVIEW_MAX_CHARS - 1)}…`;
}

function formatCompletedToolPreview(toolName: string, input: unknown): string {
  if (toolName.startsWith('mcp__')) return '';
  if (typeof input !== 'object' || input === null) return '';
  const record = input as Record<string, unknown>;
  if (toolName === 'Bash' && typeof record.command === 'string') {
    return capCompletedToolPreview(record.command);
  }
  if (typeof record.file_path === 'string') return capCompletedToolPreview(record.file_path);
  if (typeof record.path === 'string') return capCompletedToolPreview(record.path);
  if (typeof record.pattern === 'string') return capCompletedToolPreview(record.pattern);
  const firstString = Object.values(record).find(
    (value): value is string => typeof value === 'string'
  );
  return firstString ? capCompletedToolPreview(firstString) : '';
}

function foldTaskNotification(
  entry: RosterToolEntry,
  taskNotificationsByToolUseId: Map<string, TaskNotificationLite>
): RosterToolEntry {
  if (!entry.toolUseId) return entry;
  const notification = taskNotificationsByToolUseId.get(entry.toolUseId);
  if (!notification) return entry;
  return {
    ...entry,
    taskStatus: notification.status,
    ...(notification.summary ? { taskSummary: notification.summary } : {}),
    ...(notification.usage ? { taskUsage: notification.usage } : {}),
  };
}

function indexCompletedFoldableToolUseIds(rows: ParsedThreadRow[]): Set<string> {
  const visible = new Set<string>();
  for (const entry of completedRosterEntries(rows, new Map())) {
    if (entry.kind === 'tool' && entry.toolUseId) visible.add(entry.toolUseId);
  }
  return visible;
}

function completedRosterEntries(
  rows: ParsedThreadRow[],
  taskNotificationsByToolUseId: Map<string, TaskNotificationLite>,
  foldableToolUseIds?: ReadonlySet<string>
): ActiveRosterEntry[] {
  const entries: RosterToolEntry[] = [];
  for (const row of rows) {
    for (const block of getToolUseContentBlocks(row)) {
      const toolUseIdValue = (block as { id?: unknown }).id;
      const toolUseId = typeof toolUseIdValue === 'string' ? toolUseIdValue : undefined;
      const entry: RosterToolEntry = {
        kind: 'tool',
        tool: block.name,
        preview: formatCompletedToolPreview(block.name, block.input),
        ts: row.createdAt,
        ...(toolUseId ? { toolUseId } : {}),
      };
      entries.push(
        toolUseId && foldableToolUseIds && !foldableToolUseIds.has(toolUseId)
          ? entry
          : foldTaskNotification(entry, taskNotificationsByToolUseId)
      );
    }
  }
  return entries.slice(-ROSTER_MAX_ENTRIES);
}

function buildCompletedTurn(
  block: AgentTurnBlock,
  rows: ParsedThreadRow[],
  turnId: string,
  resultInfo: ResultMessage | undefined,
  taskNotificationsByToolUseId: Map<string, TaskNotificationLite>,
  globalRosteredToolUseIds: Set<string>,
  transitionSummary: ActiveTurnSummary | undefined = undefined
): CompletedFeedTurn {
  const startedAt = rows[0].createdAt;
  const lastRow = rows[rows.length - 1];
  const resultRow = resultInfo ? rows.find((row) => row.message === resultInfo) : undefined;
  const endedAt = resultRow?.createdAt ?? lastRow.createdAt;
  const durationMs = Math.max(0, endedAt - startedAt);
  const durationSec = Math.max(1, Math.round(durationMs / 1000));
  const { text, fallback, sourceRow, hasError } = extractLastAssistantText(rows);
  const highlightSource = sourceRow ?? lastRow;
  const highlightUuid =
    highlightSource?.message &&
    typeof (highlightSource.message as { uuid?: unknown }).uuid === 'string'
      ? ((highlightSource.message as { uuid: string }).uuid as string)
      : undefined;
  return {
    state: 'completed',
    id: turnId,
    agent: block.agentLabel,
    agentKind: rows[0]?.kind ?? 'task_agent',
    agentRole: rows[0]?.role ?? block.agentLabel,
    agentNodeExecutionId: rows[0]?.nodeExecutionId ?? null,
    startedAt,
    durationSec,
    toolCalls: countSummaryEntries(transitionSummary, 'tool_use') ?? countToolCalls(rows),
    messages: rows.length,
    lastMessage: text,
    fallback,
    hasError,
    sessionId: highlightSource?.sessionId ?? lastRow.sessionId,
    highlightMessageUuid: highlightUuid,
    replacementStatus: sourceRow?.replacementStatus,
    resultInfo,
    roster: (() => {
      const base = completedRosterEntries(
        rows,
        taskNotificationsByToolUseId,
        indexCompletedFoldableToolUseIds(rows)
      );
      // Suppress standalone entries for outcomes already folded onto a tool
      // card in THIS turn (the global pre-scan misses roster-only turns).
      const rostered = new Set([
        ...globalRosteredToolUseIds,
        ...rosteredToolUseIdsFromRoster(base),
      ]);
      return [...base, ...standaloneTaskNotificationEntries(rows, rostered)];
    })(),
  };
}

/**
 * Scan parsedRows for terminal task_notification system rows, keyed by
 * tool_use_id. Used to fold status onto the active-turn roster tool entry.
 */
function indexTaskNotifications(rows: ParsedThreadRow[]): Map<string, TaskNotificationLite> {
  const byToolUseId = new Map<string, TaskNotificationLite>();
  for (const row of rows) {
    const msg = row.message;
    if (!msg) continue;
    if (msg.type === 'system' && (msg as { subtype?: string }).subtype === 'task_notification') {
      const n = msg as {
        tool_use_id?: string;
        status?: 'completed' | 'failed' | 'stopped';
        summary?: string;
        usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
      };
      if (n.tool_use_id && n.status) {
        byToolUseId.set(n.tool_use_id, { status: n.status, summary: n.summary, usage: n.usage });
      }
    }
  }
  return byToolUseId;
}

/**
 * Build standalone roster entries for task_notifications whose originating
 * tool_use is NOT rendered in the roster (capped out / orphan / completed
 * turn). These have no tool card to fold onto, so they get their own
 * chat-container-style outcome line. Entries whose tool_use IS rostered are
 * skipped — their outcome folds onto that tool card (foldTaskNotification),
 * so the two paths never duplicate.
 */
function standaloneTaskNotificationEntries(
  rows: ParsedThreadRow[],
  rosteredToolUseIds: Set<string>
): RosterTaskNotificationEntry[] {
  const out: RosterTaskNotificationEntry[] = [];
  for (const row of rows) {
    const msg = row.message;
    if (!msg || msg.type !== 'system') continue;
    if ((msg as { subtype?: string }).subtype !== 'task_notification') continue;
    const n = msg as {
      tool_use_id?: string;
      status?: 'completed' | 'failed' | 'stopped';
      summary?: string;
      usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
    };
    if (!n.status) continue;
    if (n.tool_use_id && rosteredToolUseIds.has(n.tool_use_id)) continue;
    out.push({
      kind: 'task_notification',
      status: n.status,
      ts: row.createdAt,
      ...(n.summary ? { summary: n.summary } : {}),
      ...(n.usage ? { usage: n.usage } : {}),
      ...(n.tool_use_id ? { toolUseId: n.tool_use_id } : {}),
    });
  }
  return out;
}

/**
 * tool_use_ids whose tool cards are present in a given roster. Combined with
 * the global rostered set to gate standalone task_notification entries: a
 * notification must NOT emit a standalone roster entry if its outcome already
 * folds onto a tool card in THIS turn's roster — otherwise roster-only turns
 * (no assistant text, kept only for their roster) would show the outcome twice
 * (once folded, once standalone), since the global pre-scan excludes those
 * text-less turns and so omits their tool ids.
 */
function rosteredToolUseIdsFromRoster(roster: ActiveRosterEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of roster) {
    if (entry.kind === 'tool' && entry.toolUseId) ids.add(entry.toolUseId);
  }
  return ids;
}

/**
 * Collect the tool_use_ids that have a rendered active-roster target — i.e.
 * tool_use entries that survive the ROSTER_MAX_ENTRIES cap in a summary whose
 * session actually renders an active roster. A summary only renders an active
 * roster when its session's trailing block is non-terminal AND that block's
 * agent is active; a stale summary left over after the compact rows advanced
 * to a terminal result must NOT suppress a task_notification (it has nowhere
 * to fold). A task_notification is only suppressed when its tool_use_id is in
 * this set; otherwise its status must render as a fallback row.
 */
function collectActiveRosteredToolUseIds(
  summaries: ActiveTurnSummary[],
  renderedTurnKeys: Set<string>
): Set<string> {
  const ids = new Set<string>();
  for (const summary of summaries) {
    // Match on (sessionId, turnIndex): a stale summary whose turn no longer
    // matches the compact feed's active turn must not contribute tool IDs.
    if (!renderedTurnKeys.has(`${summary.sessionId}:${summary.turnIndex}`)) continue;
    for (const entry of rosterEntriesFromSummary(summary, ROSTER_MAX_ENTRIES)) {
      if (entry.kind === 'tool' && entry.toolUseId) ids.add(entry.toolUseId);
    }
  }
  return ids;
}

function collectRosteredToolUseIds(
  summaries: ActiveTurnSummary[],
  renderedTurnKeys: Set<string>,
  completedRows: ParsedThreadRow[][]
): Set<string> {
  const ids = collectActiveRosteredToolUseIds(summaries, renderedTurnKeys);
  for (const rows of completedRows) {
    for (const id of indexCompletedFoldableToolUseIds(rows)) ids.add(id);
  }
  return ids;
}

function buildActiveTurn(
  block: AgentTurnBlock,
  rows: ParsedThreadRow[],
  turnId: string,
  summary: ActiveTurnSummary | undefined,
  sessionId: string | null,
  taskNotificationsByToolUseId: Map<string, TaskNotificationLite>,
  globalRosteredToolUseIds: Set<string>,
  latestStatusBySession?: Map<string, { status: string; ts: number }>
): ActiveFeedTurn {
  const baseRoster = rosterEntriesFromSummary(summary, ROSTER_MAX_ENTRIES).map((entry) => {
    if (entry.kind !== 'tool') return entry;
    return foldTaskNotification(entry, taskNotificationsByToolUseId);
  });
  // Append standalone outcome entries for task_notifications whose tool_use
  // isn't rostered in any turn (capped out / orphan). Folded ones are already
  // on their tool card; checking the global set + this turn's roster prevents
  // both cross-turn and within-turn duplication.
  const rostered = new Set([
    ...globalRosteredToolUseIds,
    ...rosteredToolUseIdsFromRoster(baseRoster),
  ]);
  const withNotifications = [...baseRoster, ...standaloneTaskNotificationEntries(rows, rostered)];
  const labelKey = normalizeAgentKey(block.agentLabel);
  const sessionEntry = sessionId ? latestStatusBySession?.get(sessionId) : undefined;
  const labelEntry = latestStatusBySession?.get(labelKey);
  const activeStatus = sessionEntry ?? labelEntry;
  // Cap the base roster first, then pin the live status entry so the header
  // pill always has a matching roster line even when many events followed it.
  const cappedBase = withNotifications.slice(-ROSTER_MAX_ENTRIES);
  const roster = activeStatus
    ? [...cappedBase, { kind: 'status' as const, status: activeStatus.status, ts: activeStatus.ts }]
    : cappedBase;
  return {
    state: 'active',
    id: turnId,
    agent: block.agentLabel,
    agentKind: rows[0]?.kind ?? 'task_agent',
    agentRole: rows[0]?.role ?? block.agentLabel,
    agentNodeExecutionId: rows[0]?.nodeExecutionId ?? null,
    startedAt: rows[0].createdAt,
    status: activeStatus ? `${humanizeSystemSubtype(activeStatus.status)}…` : 'Running…',
    toolCalls: countToolCallsForActive(rows, summary),
    messages: countMessagesForActive(rows),
    thinkingEntries: countSummaryEntries(summary, 'thinking'),
    messageEntries: countSummaryEntries(summary, 'text'),
    toolEntries: countSummaryEntries(summary, 'tool_use'),
    lastEventAt: Math.max(latestActivityTimestamp(summary, rows), activeStatus?.ts ?? 0),
    roster,
    sessionId,
  };
}

/**
 * Resolve the sender of a user-type SDK message.
 *
 * The origin field comes in two shapes in the wild:
 * - Legacy string form ("system") — what the daemon currently writes
 *   to the DB for non-human-typed messages.
 * - Typed `SDKMessageOrigin` object form (`{ kind: 'peer'/'channel'/... }`) —
 *   what the SDK itself emits for richer provenance.
 *
 * For synthetic / replay messages without origin info, we fall back to the
 * previous agent block's label — agent→agent handoffs almost always come from
 * whichever agent ran immediately before the recipient. It's a heuristic, but
 * it produces meaningful labels in the common case where origin metadata is
 * missing.
 */
function extractSenderLabel(
  message: SDKMessage,
  previousAgentLabel: string | null
): { label: string; isSynthetic: boolean } {
  const m = message as SDKMessage & {
    origin?: unknown;
    isSynthetic?: boolean;
    isReplay?: boolean;
  };
  const isSynthetic = !!m.isSynthetic || !!m.isReplay;
  const origin = m.origin;

  if (typeof origin === 'string') {
    if (origin === 'system') return { label: 'System', isSynthetic: true };
    if (origin === 'human') return { label: 'User', isSynthetic: false };
  }

  if (typeof origin === 'object' && origin !== null) {
    const o = origin as { kind?: string; from?: string; name?: string; server?: string };
    if (o.kind === 'human') return { label: 'User', isSynthetic: false };
    if (o.kind === 'peer') {
      return { label: o.name ?? o.from ?? previousAgentLabel ?? 'Peer Agent', isSynthetic: true };
    }
    if (o.kind === 'channel') return { label: o.server ?? 'Channel', isSynthetic: true };
    if (o.kind === 'task-notification') return { label: 'Task', isSynthetic: true };
    if (o.kind === 'coordinator') return { label: 'Coordinator', isSynthetic: true };
  }

  if (isSynthetic && previousAgentLabel) {
    return { label: previousAgentLabel, isSynthetic: true };
  }
  if (isSynthetic) return { label: 'Agent', isSynthetic: true };
  return { label: 'User', isSynthetic: false };
}

/**
 * Extract a user-type message's text body. Concatenates all text blocks; falls
 * back to the row's fallbackText when the message can't be parsed.
 */
function extractUserMessageText(row: ParsedThreadRow): { body: string; fallback: boolean } {
  if (!row.message) {
    return { body: row.fallbackText ?? '', fallback: true };
  }
  const apiMessage = (row.message as { message?: { content?: unknown } }).message;
  const content = apiMessage?.content;
  if (typeof content === 'string') return { body: content.trim(), fallback: false };
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const b = block as { type?: unknown; text?: unknown };
      if (b.type === 'text' && typeof b.text === 'string') {
        parts.push(b.text);
      }
    }
    const joined = parts.join('\n\n').trim();
    return { body: joined, fallback: false };
  }
  return { body: '', fallback: false };
}

function buildCompactBoundaryTurn(row: ParsedThreadRow): CompactBoundaryFeedTurn | null {
  if (!row.message || !isSDKCompactBoundary(row.message)) return null;
  const metadata = (row.message as CompactBoundaryMessage).compact_metadata;
  const highlightUuid =
    typeof (row.message as { uuid?: unknown }).uuid === 'string'
      ? ((row.message as { uuid: string }).uuid as string)
      : undefined;
  return {
    state: 'compact_boundary',
    id: `compact-boundary-${String(row.id)}`,
    agent: row.label,
    agentKind: row.kind,
    agentRole: row.role,
    agentNodeExecutionId: row.nodeExecutionId ?? null,
    createdAt: row.createdAt,
    trigger: metadata.trigger,
    preTokens: metadata.pre_tokens,
    postTokens: metadata.post_tokens,
    durationMs: metadata.duration_ms,
    sessionId: row.sessionId,
    highlightMessageUuid: highlightUuid,
  };
}

function isFoldedTaskNotification(row: ParsedThreadRow, rosteredToolUseIds: Set<string>): boolean {
  const message = row.message;
  if (!message || message.type !== 'system') return false;
  if ((message as { subtype?: string }).subtype !== 'task_notification') return false;
  const toolUseId = (message as { tool_use_id?: string }).tool_use_id;
  return !!toolUseId && rosteredToolUseIds.has(toolUseId);
}

function buildOperationalSystemTurn(
  row: ParsedThreadRow,
  isSessionTail: boolean,
  rosteredToolUseIds: Set<string>,
  consumedStatusRowIds?: ReadonlySet<string>
): SystemFeedTurn | null {
  const message = row.message;
  if (!message || message.type !== 'system') return null;
  const subtype = (message as { subtype?: string }).subtype;
  if (!subtype || subtype === 'init') return null;
  // SDK status messages (compacting / requesting) fold into the active turn's
  // header pill and roster. Suppress the standalone system card when the status
  // has been attached to an active turn; leave non-clear statuses as a generic
  // fallback row when they arrived with no active roster (orphan / completed
  // turn). Clear messages (status: null) are only meaningful inside an active
  // turn, so never render them as a standalone card.
  if (subtype === 'status') {
    const statusValue = (message as { status?: unknown }).status;
    if (statusValue === null) return null;
    if (consumedStatusRowIds && consumedStatusRowIds.has(String(row.id))) return null;
  }
  // Hooks surface ONLY as roster entries in the minimal feed (one entry per
  // hook run via the active-turn summary). Suppress every hook_* system row so
  // the feed never shows a standalone hook card. The chat transcript still
  // renders hook_started/hook_progress/hook_response.
  if (subtype === 'hook_started' || subtype === 'hook_progress' || subtype === 'hook_response') {
    return null;
  }
  // task_notification is folded onto its originating tool_use roster entry
  // (active turn only). Suppress the standalone row ONLY when that target
  // exists — i.e. the tool_use is in an active summary's rendered roster. When
  // there is no target (completed turn, missing summary, or the tool was
  // capped out of the last ROSTER_MAX_ENTRIES entries), fall through to a
  // system turn so the terminal summary/usage/failure is not silently lost.
  // True orphans (no tool_use_id) also fall through.
  if (isFoldedTaskNotification(row, rosteredToolUseIds)) return null;
  // These subtypes surface ONLY as roster entries in the minimal feed (like
  // hooks) — never as standalone system cards in the main thread, even when
  // capped out of the roster:
  //   - api_retry: roster `api_retry` entry. (The chat transcript still
  //     renders api_retry via SDKSystemMessage.)
  //   - thinking_tokens: roster `thinking` entries carry the content; the
  //     numeric token estimate is dropped (it's excluded from the chat
  //     transcript pagination too).
  //   - task_notification: folds onto its roster tool card when the tool is
  //     rostered, otherwise a standalone roster entry. Never a main-thread card.
  if (subtype === 'api_retry' || subtype === 'thinking_tokens' || subtype === 'task_notification')
    return null;
  // Honor the centralized hidden-subtype contract so Space task threads
  // don't surface noisy rows the main transcript already hides.
  if (isHiddenSystemSubtype(subtype)) return null;
  // Apply the same conditional hides as SDKSystemMessage so Space task
  // threads don't render success-noise rows the main transcript suppresses.
  if (isConditionallyHiddenSystemMessage(message)) return null;
  if (subtype === 'informational' && (message as { level?: string }).level === 'info') {
    return null;
  }
  if (subtype === 'worker_shutting_down' && !isSessionTail) return null;
  const highlightUuid =
    typeof (message as { uuid?: unknown }).uuid === 'string'
      ? ((message as { uuid: string }).uuid as string)
      : undefined;

  if (subtype === 'session_state_changed') {
    const state = (message as { state?: unknown }).state;
    return {
      state: 'system',
      id: `system-${String(row.id)}`,
      agent: row.label,
      agentKind: row.kind,
      agentRole: row.role,
      agentNodeExecutionId: row.nodeExecutionId ?? null,
      createdAt: row.createdAt,
      title: 'Session state',
      body: typeof state === 'string' ? state : 'changed',
      sessionId: row.sessionId,
      highlightMessageUuid: highlightUuid,
      replacementStatus: row.replacementStatus,
    };
  }

  if (subtype === 'commands_changed') {
    const commands = (message as { commands?: unknown }).commands;
    const count = Array.isArray(commands) ? commands.length : 0;
    return {
      state: 'system',
      id: `system-${String(row.id)}`,
      agent: row.label,
      agentKind: row.kind,
      agentRole: row.role,
      agentNodeExecutionId: row.nodeExecutionId ?? null,
      createdAt: row.createdAt,
      title: 'Commands changed',
      body: `${count.toLocaleString()} slash commands available`,
      sessionId: row.sessionId,
      highlightMessageUuid: highlightUuid,
      replacementStatus: row.replacementStatus,
    };
  }

  if (subtype === 'model_refusal_fallback') {
    const content = (message as { content?: unknown }).content;
    const originalModel = (message as { original_model?: unknown }).original_model;
    const fallbackModel = (message as { fallback_model?: unknown }).fallback_model;
    const modelText =
      typeof originalModel === 'string' && typeof fallbackModel === 'string'
        ? ` (${originalModel} -> ${fallbackModel})`
        : '';
    return {
      state: 'system',
      id: `system-${String(row.id)}`,
      agent: row.label,
      agentKind: row.kind,
      agentRole: row.role,
      agentNodeExecutionId: row.nodeExecutionId ?? null,
      createdAt: row.createdAt,
      title: 'Model fallback',
      body: `${typeof content === 'string' && content.length > 0 ? content : 'Retried with fallback model'}${modelText}`,
      sessionId: row.sessionId,
      highlightMessageUuid: highlightUuid,
      replacementStatus: row.replacementStatus,
    };
  }

  const fallback = buildGenericSystemSummary(message);
  if (!fallback) return null;
  return {
    state: 'system',
    id: `system-${String(row.id)}`,
    agent: row.label,
    agentKind: row.kind,
    agentRole: row.role,
    agentNodeExecutionId: row.nodeExecutionId ?? null,
    createdAt: row.createdAt,
    title: fallback.title,
    body: fallback.body,
    sessionId: row.sessionId,
    highlightMessageUuid: highlightUuid,
    replacementStatus: row.replacementStatus,
  };
}

function buildGenericSystemSummary(message: Extract<SDKMessage, { type: 'system' }>): {
  title: string;
  body: string;
} | null {
  const subtype = (message as { subtype?: string }).subtype;
  if (!subtype) return null;

  if (subtype === 'status') {
    const statusValue = firstStringField(message, ['status']) ?? subtype;
    return {
      title: humanizeSystemSubtype(statusValue),
      body: statusValue,
    };
  }

  if (subtype === 'informational') {
    const level = (message as { level?: unknown }).level;
    return {
      title: typeof level === 'string' ? humanizeSystemSubtype(level) : 'Notice',
      body: firstStringField(message, ['content', 'message', 'title']) ?? 'System notice',
    };
  }

  if (subtype === 'hook_response') {
    const hookName = firstStringField(message, ['hook_name', 'hook_event']);
    const stderr = firstStringField(message, ['stderr']);
    const stdout = firstStringField(message, ['stdout']);
    return {
      title: 'Hook response',
      body: [hookName, stderr ?? stdout].filter(Boolean).join(': ') || 'Hook completed',
    };
  }

  return {
    title: humanizeSystemSubtype(subtype),
    body:
      firstStringField(message, ['content', 'message', 'reason', 'status', 'description']) ??
      subtype,
  };
}

function firstStringField(message: object, fields: string[]): string | null {
  const record = message as Record<string, unknown>;
  for (const field of fields) {
    const value = record[field];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

function humanizeSystemSubtype(value: string): string {
  return value
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function buildMessageTurn(
  row: ParsedThreadRow,
  previousAgentLabel: string | null,
  sessionInit: SystemInitMessage | undefined
): MessageFeedTurn {
  const { label: fromLabel, isSynthetic } = extractSenderLabel(
    row.message ?? ({} as SDKMessage),
    previousAgentLabel
  );
  const { body, fallback } = extractUserMessageText(row);
  const highlightUuid =
    row.message && typeof (row.message as { uuid?: unknown }).uuid === 'string'
      ? ((row.message as { uuid: string }).uuid as string)
      : undefined;
  return {
    state: 'message',
    id: `msg-${String(row.id)}`,
    fromLabel,
    toLabel: row.label,
    toKind: row.kind,
    toRole: row.role,
    toNodeExecutionId: row.nodeExecutionId ?? null,
    body,
    bodyIsFallback: fallback,
    createdAt: row.createdAt,
    isSynthetic,
    deliveryState: row.deliveryState ?? null,
    sessionId: row.sessionId,
    highlightMessageUuid: highlightUuid,
    replacementStatus: row.replacementStatus,
    sessionInit,
  };
}

/**
 * Pre-scan a block's rows for the SDK envelope messages we surface as
 * dropdown affordances:
 *   - `system:init` → attached to the user message that triggered the
 *     exec (so the user can introspect "what state did my message land
 *     in?"). First match wins; an exec only emits one init.
 *   - `result`      → attached to the completed agent turn. Last match
 *     wins so we always grab the most recent envelope when a block
 *     happens to contain multiple (rare; mostly defensive).
 */
function extractBlockEnvelopes(rows: ParsedThreadRow[]): {
  init: SystemInitMessage | undefined;
  result: ResultMessage | undefined;
} {
  let init: SystemInitMessage | undefined;
  let result: ResultMessage | undefined;
  for (const row of rows) {
    if (!row.message) continue;
    if (!init && isSDKSystemInit(row.message)) {
      init = row.message as SystemInitMessage;
    }
    if (isSDKResultMessage(row.message)) {
      result = row.message as ResultMessage;
    }
  }
  return { init, result };
}

/**
 * Build the ordered turn list for the minimal feed.
 *
 * Walks `buildAgentTurns` output but splits each block on user-type rows:
 * - Each user/synthetic row becomes its own `MessageFeedTurn`, surfaced as a
 *   distinct row showing FROM → TO and the message body.
 * - Consecutive non-user rows (assistant + result) form `CompletedFeedTurn`s.
 * - For every agent label in `activeAgentLabels`, the trailing non-terminal
 *   completed turn from that agent upgrades to an `ActiveFeedTurn`. Tracking
 *   trailing state per agent (rather than a single global "last block") is
 *   what keeps the Coder rail visible when a Reviewer's terminal `result` row
 *   lands after Coder's last row in a multi-session workflow.
 */
function buildFeedTurns(
  parsedRows: ParsedThreadRow[],
  activeAgentLabels: ReadonlySet<string>,
  activeTurnSummaries: ActiveTurnSummary[]
): FeedTurn[] {
  const rowsWithReplacementStatus = applyReplacementStatuses(parsedRows);
  const blocks = buildAgentTurns(rowsWithReplacementStatus);
  if (blocks.length === 0) return [];

  // task_notifications keyed by tool_use_id — used to fold status onto the
  // active-turn roster tool entry.
  const taskNotificationsByToolUseId = indexTaskNotifications(rowsWithReplacementStatus);

  // Turns that will actually render an active roster: the trailing block for
  // an active agent is non-terminal. Only a summary whose (sessionId, turnIndex)
  // matches one of these rendered turns can fold a task_notification onto a
  // roster entry. Matching turnIndex (not just sessionId) matters because the
  // compact-message and active-turn LiveQueries update independently: if the
  // compact rows advance a session into a new turn before the active-turn delta
  // lands, the previous turn's tool IDs must not be collected (they'd suppress
  // or mis-attach a just-finished turn's notification).
  const normalisedActive = new Set<string>();
  for (const label of activeAgentLabels) normalisedActive.add(normalizeAgentKey(label));
  const trailingBlockByAgent = new Map<string, AgentTurnBlock>();
  for (const block of blocks) trailingBlockByAgent.set(normalizeAgentKey(block.agentLabel), block);
  const renderedTurnKeys = new Set<string>();
  const activeTurnIndexBySession = new Map<string, number | undefined>();
  for (const [key, block] of trailingBlockByAgent) {
    if (!normalisedActive.has(key)) continue;
    if (block.isTerminal) continue;
    const sid = activeTurnSessionId(block.rows);
    const turnIndex = latestTurnIndex(block.rows);
    if (sid) {
      if (turnIndex !== undefined) renderedTurnKeys.add(`${sid}:${turnIndex}`);
      activeTurnIndexBySession.set(sid, turnIndex);
    }
  }

  // SDK system:status messages (compacting / requesting) fold into the active
  // turn's header pill and roster. Consume them when they belong to the active
  // turn's session, or — for rows without a session id — when the agent label
  // has a non-terminal active turn. When the turn index is known on both sides
  // it must match. Any unmatched status row falls back to a generic system card
  // so it is never silently lost.
  const consumedStatusRowIds = new Set<string>();
  const latestStatusBySession = new Map<string, { status: string; ts: number }>();
  for (const row of rowsWithReplacementStatus) {
    const parsed = parseSystemStatusRow(row);
    const isCompactBoundary = !!row.message && isSDKCompactBoundary(row.message);
    if (!parsed && !isCompactBoundary) continue;

    const sid = row.sessionId;
    const labelKey = normalizeAgentKey(row.label);
    const block = trailingBlockByAgent.get(labelKey);
    const isActiveBlock = block && !block.isTerminal && normalisedActive.has(labelKey);
    const activeSessionId = isActiveBlock ? activeTurnSessionId(block.rows) : null;
    let targetKey: string | undefined;
    let activeTurnIndex: number | undefined;
    if (sid && activeSessionId && sid === activeSessionId) {
      targetKey = sid;
      activeTurnIndex = activeTurnIndexBySession.get(sid);
    } else if (!sid && isActiveBlock) {
      targetKey = labelKey;
      activeTurnIndex = latestTurnIndex(block.rows);
    }
    if (!targetKey) continue;
    if (
      row.turnIndex !== undefined &&
      activeTurnIndex !== undefined &&
      row.turnIndex !== activeTurnIndex
    ) {
      continue;
    }

    if (isCompactBoundary) {
      // The daemon treats a compact_boundary as the clear point for an active
      // compacting state; mirror that in the folded UI.
      latestStatusBySession.delete(targetKey);
      continue;
    }

    // Only fold a status row when there is an actual turn to attach it to.
    // If the trailing block contains only status/boundary/user rows, the row
    // would be consumed and then silently dropped, so let it fall back to a
    // standalone system card instead.
    if (parsed) {
      const block = trailingBlockByAgent.get(labelKey);
      if (block) {
        const hasFoldTarget = block.rows.some((r) => {
          if (isUserRow(r)) return false;
          if (parseSystemStatusRow(r)) return false;
          if (r.message && isSDKCompactBoundary(r.message)) return false;
          return true;
        });
        if (!hasFoldTarget) continue;
      }
    }

    consumedStatusRowIds.add(String(row.id));
    if (parsed!.isClear) {
      latestStatusBySession.delete(targetKey);
    } else {
      const existing = latestStatusBySession.get(targetKey);
      // Use strict `>` so two status rows in the same millisecond keep the
      // first-seen value (insertion order) instead of being overwritten by a
      // later row whose UUID/DB order may not reflect the true stream order.
      if (!existing || row.createdAt > existing.ts) {
        latestStatusBySession.set(targetKey, { status: parsed!.status, ts: row.createdAt });
      }
    }
  }

  const rosteredActiveToolUseIds = collectActiveRosteredToolUseIds(
    activeTurnSummaries,
    renderedTurnKeys
  );

  const completedRows = blocks.flatMap((block) => {
    const out: ParsedThreadRow[][] = [];
    const blockKey = normalizeAgentKey(block.agentLabel);
    const trailingBlockCanUpgradeToActive = normalisedActive.has(blockKey) && !block.isTerminal;
    let pendingAgentRows: ParsedThreadRow[] = [];
    // A completed slice contributes to the rostered-tool pre-scan when it has
    // an assistant reply OR tool_use content. Including tool-only slices
    // (no reply text — e.g. a background task turn) means their tool ids enter
    // the global rostered set, so a task_notification that folds onto one of
    // those tools isn't duplicated as a standalone roster entry elsewhere.
    const sliceContributesToRoster = (sliceRows: ParsedThreadRow[]) =>
      extractLastAssistantText(sliceRows).text.length > 0 ||
      sliceRows.some((r) => getToolUseContentBlocks(r).length > 0);
    const flush = (isFinal = false) => {
      if (
        (pendingAgentRows.length > 0 &&
          !(isFinal && trailingBlockCanUpgradeToActive) &&
          // Keep slices with text, tool_use content, OR any result error —
          // error-only turns must be included so their tool_use_ids are collected
          // into rosteredToolUseIds and post-result task_notifications fold onto
          // the now-visible roster instead of duplicating as standalone rows.
          sliceContributesToRoster(pendingAgentRows)) ||
        rowsContainResultError(pendingAgentRows)
      ) {
        out.push(pendingAgentRows);
      }
      pendingAgentRows = [];
    };
    for (const row of block.rows) {
      if (isFoldedSystemStatusRow(row, consumedStatusRowIds)) continue;
      // Unmatched `system:status` clear rows (status: null) should never join a
      // turn — they would shift latestSessionId / message counts and could steal
      // the active rail's session away from the real active turn.
      if (parseSystemStatusRow(row)?.isClear) continue;
      if (buildCompactBoundaryTurn(row) || isUserRow(row)) {
        flush();
        continue;
      }
      const message = row.message;
      const subtype =
        message?.type === 'system' ? (message as { subtype?: string }).subtype : undefined;
      if (
        subtype === 'task_notification' &&
        trailingBlockCanUpgradeToActive &&
        !isFoldedTaskNotification(row, rosteredActiveToolUseIds)
      ) {
        pendingAgentRows = [];
        continue;
      }
      if (
        subtype !== 'task_notification' &&
        buildOperationalSystemTurn(row, false, rosteredActiveToolUseIds, consumedStatusRowIds)
      ) {
        flush();
        continue;
      }
      pendingAgentRows.push(row);
    }
    flush(true);
    return out;
  });

  // tool_use_ids whose status is actually rendered on an active or completed
  // roster entry. A task_notification is suppressed ONLY when its tool_use_id is
  // in this set — otherwise there is no inline target (missing/stale summary,
  // turn mismatch, or capped out of the roster) and the notification must fall
  // back to a standalone system row so terminal metadata is not lost.
  const rosteredToolUseIds = collectRosteredToolUseIds(
    activeTurnSummaries,
    renderedTurnKeys,
    completedRows
  );

  const latestRowIdBySession = new Map<string, string>();
  for (const row of rowsWithReplacementStatus) {
    if (row.sessionId) latestRowIdBySession.set(row.sessionId, String(row.id));
  }

  // Index summaries by sessionId so the trailing-block upgrade can pick the
  // right summary in O(1) rather than scanning the (small but not bounded)
  // list once per render. The server emits at most one summary per session.
  const summariesBySession = new Map<string, ActiveTurnSummary>();
  for (const summary of activeTurnSummaries) {
    summariesBySession.set(summary.sessionId, summary);
  }

  const turns: FeedTurn[] = [];
  // Per-agent trailing completed-turn pointer. Keyed by the normalised agent
  // label so case/whitespace variants between activity-member labels (run
  // through a title-casing helper on the daemon) and raw row labels collide
  // on the same entry. Each `flushAgent` call overwrites the entry for
  // `block.agentLabel`, so after the loop the map points at the *last*
  // completed turn each agent produced — exactly what we want to upgrade.
  type AgentTrailing = {
    turnIdx: number;
    rows: ParsedThreadRow[];
    block: AgentTurnBlock;
  };
  const perAgentTrailing = new Map<string, AgentTrailing>();
  let previousAgentLabel: string | null = null;

  for (const block of blocks) {
    // Pre-extract once per block so every turn we emit (user msg AND
    // completed turn) shares the same view of the block's init/result
    // envelopes. Cheap — single linear scan over rows we'd already be
    // walking anyway.
    const { init: blockInit, result: blockResult } = extractBlockEnvelopes(block.rows);
    const blockKey = normalizeAgentKey(block.agentLabel);

    let pendingAgentRows: ParsedThreadRow[] = [];
    const flushAgent = () => {
      if (pendingAgentRows.length === 0) return;
      const turnId = `${block.id}:${String(pendingAgentRows[0].id)}`;
      const sessionId = latestSessionId(pendingAgentRows);
      const resultInfo = rowsContainResult(pendingAgentRows, blockResult) ? blockResult : undefined;
      const transitionSummary = resultInfo
        ? summaryMatchesTurn(
            sessionId ? summariesBySession.get(sessionId) : undefined,
            pendingAgentRows
          )
        : undefined;
      turns.push(
        buildCompletedTurn(
          block,
          pendingAgentRows,
          turnId,
          resultInfo,
          taskNotificationsByToolUseId,
          rosteredToolUseIds,
          transitionSummary
        )
      );
      perAgentTrailing.set(blockKey, {
        turnIdx: turns.length - 1,
        rows: pendingAgentRows,
        block,
      });
      pendingAgentRows = [];
    };

    for (const row of block.rows) {
      if (isFoldedSystemStatusRow(row, consumedStatusRowIds)) continue;
      // Drop unmatched `system:status` clear rows before they can join a turn.
      if (parseSystemStatusRow(row)?.isClear) continue;
      const compactBoundaryTurn = buildCompactBoundaryTurn(row);
      if (compactBoundaryTurn) {
        flushAgent();
        turns.push(compactBoundaryTurn);
        continue;
      }
      const operationalSystemTurn = buildOperationalSystemTurn(
        row,
        row.sessionId ? latestRowIdBySession.get(row.sessionId) === String(row.id) : false,
        rosteredToolUseIds,
        consumedStatusRowIds
      );
      if (operationalSystemTurn) {
        flushAgent();
        turns.push(operationalSystemTurn);
        continue;
      }
      if (isFoldedTaskNotification(row, rosteredToolUseIds)) {
        continue;
      }
      if (isUserRow(row)) {
        flushAgent();
        turns.push(buildMessageTurn(row, previousAgentLabel, blockInit));
        continue;
      }
      pendingAgentRows.push(row);
    }
    flushAgent();
    previousAgentLabel = block.agentLabel;
  }

  // Per-agent active-rail upgrade. For every label in `activeAgentLabels`
  // whose trailing block is non-terminal, swap that agent's last completed
  // turn for an active turn. Independent across agents — a Reviewer terminal
  // block landing after Coder's last row can no longer suppress the Coder
  // rail because Coder has its own entry in `perAgentTrailing`. The roster
  // is built from the server-derived summary keyed on the trailing rows'
  // session id; missing summary → empty roster (e.g. server hasn't shipped
  // metadata yet, or the active turn lives on a different session than the
  // trailing fragment).
  if (activeAgentLabels.size > 0) {
    const normalisedActive = new Set<string>();
    for (const label of activeAgentLabels) {
      normalisedActive.add(normalizeAgentKey(label));
    }
    for (const [key, trailing] of perAgentTrailing) {
      if (!normalisedActive.has(key)) continue;
      if (trailing.block.isTerminal) continue;
      const completed = turns[trailing.turnIdx] as CompletedFeedTurn;
      const sessionId = latestSessionId(trailing.rows);
      // Only fold when the summary matches the trailing rows' turn (when the
      // turn is known). The compact and active-turn LiveQueries race: if the
      // compact rows advanced to a new non-terminal turn before the active-turn
      // delta landed, a session-keyed summary is stale and would attach the
      // previous turn's tool IDs/status to the new active rail. Drop the summary
      // on a known turn mismatch → buildActiveTurn renders no roster until the
      // summary catches up. When the trailing turn is unknown, fall through
      // (no gate) so summaries still apply.
      const candidateSummary = sessionId ? summariesBySession.get(sessionId) : undefined;
      const trailingTurn = latestTurnIndex(trailing.rows);
      const summary =
        trailingTurn === undefined || candidateSummary?.turnIndex === trailingTurn
          ? candidateSummary
          : undefined;
      turns[trailing.turnIdx] = buildActiveTurn(
        trailing.block,
        trailing.rows,
        completed.id,
        summary,
        sessionId,
        taskNotificationsByToolUseId,
        rosteredToolUseIds,
        latestStatusBySession
      );
    }
  }

  // Drop empty completed turns. With result-message-aware text extraction in
  // place, the only way a completed turn ends up with no body is if it's an
  // agent-phase fragment that got cut off by another agent's rows before its
  // own exec's result message arrived — its actual reply lives in a sibling
  // turn from the same agent. Showing the fragment as its own header-only row
  // (e.g. "REVIEWER 12:29 PM · 3 messages · 9s" with nothing under it) is
  // noise; the reply is rendered in the sibling that holds the result text.
  // A turn with no reply text but with roster content (tool calls / task
  // outcomes) is still meaningful — e.g. a killed task whose outcome lives in
  // the roster — so keep it. A turn that ended in a result error (any subtype)
  // is also kept even with no text and no roster: the red bubble + inline
  // error summary IS the visible content.
  return turns.filter((t) => {
    if (t.state !== 'completed') return true;
    if (t.resultInfo && isSDKResultError(t.resultInfo)) return true;
    return t.lastMessage.length > 0 || t.roster.length > 0;
  });
}

/**
 * Force a re-render every second so live-elapsed values derived from
 * `Date.now() - startedAt` stay current. Single timer per component
 * instance — cheap, and only mounted while there is an active turn.
 */
function useSecondsTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => (n + 1) | 0), 1000);
    return () => clearInterval(id);
  }, []);
}

/* ── visual building blocks ──────────────────────────────────────────────── */

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
  const bodyClass = `truncate ${isLatest ? 'text-gray-100' : 'text-gray-400'}`;

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
              <span class="text-gray-400">: </span>
              <span class={bodyClass}>{preview}</span>
            </>
          ) : null}
          {statusLabel ? (
            <>
              <span class="text-gray-400"> — </span>
              <span class="text-amber-300">{statusLabel}</span>
            </>
          ) : null}
          {entry.taskSummary ? (
            <>
              <span class="text-gray-400"> — </span>
              <span
                class={
                  isSuccess
                    ? 'text-green-400'
                    : isStopped
                      ? 'text-amber-300'
                      : isError
                        ? 'text-red-400'
                        : bodyClass
                }
              >
                {entry.taskSummary}
              </span>
            </>
          ) : null}
          {entry.taskUsage ? (
            <span class="text-gray-500">
              {' '}
              · {entry.taskUsage.total_tokens.toLocaleString()} tok · {entry.taskUsage.tool_uses}{' '}
              tool{entry.taskUsage.tool_uses === 1 ? '' : 's'} ·{' '}
              {(entry.taskUsage.duration_ms / 1000).toFixed(1)}s
            </span>
          ) : null}
        </span>
        {isSuccess && (
          <span class="mt-0.5 shrink-0 text-green-400" aria-label="task completed">
            ✓
          </span>
        )}
        {isStopped && (
          <span class="mt-0.5 shrink-0 text-amber-300" aria-label="task stopped">
            ■
          </span>
        )}
        {isError && (
          <span class="mt-0.5 shrink-0 text-red-400" aria-label="task failed">
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
        <span class="shrink-0 text-amber-400" aria-hidden="true">
          ↻
        </span>
        <span class="min-w-0 truncate">
          <span class="font-semibold text-amber-300">API retry</span>
          <span class="text-gray-400">: </span>
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
    const statusColor = isSuccess
      ? 'text-green-400'
      : isStopped
        ? 'text-amber-300'
        : 'text-red-400';
    return (
      <div
        class={`flex items-start gap-2 font-mono text-xs leading-5 ${fadeClass}`}
        data-testid="minimal-thread-roster-entry"
        data-roster-kind="task_notification"
        data-task-status={entry.status}
      >
        <span class="mt-0.5 shrink-0" aria-hidden="true">
          {isSuccess ? (
            <span class="text-green-400">✓</span>
          ) : isStopped ? (
            <span class="text-amber-300">■</span>
          ) : (
            <span class="text-red-400">✗</span>
          )}
        </span>
        <span class="min-w-0 truncate">
          <span class={`font-semibold ${statusColor}`}>{statusLabel}</span>
          {entry.summary ? (
            <>
              <span class="text-gray-400"> — </span>
              <span class={bodyClass}>{entry.summary}</span>
            </>
          ) : null}
          {entry.usage ? (
            <span class="text-gray-500">
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
            <span class="inline-block h-3 w-3 animate-spin rounded-full border border-gray-500 border-t-transparent" />
          ) : isSuccess ? (
            <span class="text-green-400">✓</span>
          ) : isError ? (
            <span class="text-red-400">✗</span>
          ) : null}
        </span>
        <span class="min-w-0 truncate">
          <span class="font-semibold text-slate-300">{entry.hookName || 'hook'}</span>
          {entry.hookEvent ? (
            <>
              <span class="text-gray-400"> · </span>
              <span class="text-gray-400">{entry.hookEvent}</span>
            </>
          ) : null}
          {entry.summary ? <span class={` ${bodyClass}`}> — {entry.summary}</span> : null}
        </span>
      </div>
    );
  }

  if (entry.kind === 'thinking') {
    const thinkBody = `line-clamp-3 whitespace-pre-wrap italic ${isLatest ? 'text-amber-100' : 'text-amber-300/70'}`;
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
    // Real human input that landed inside the active turn — surface it
    // distinctly from agent text so a user reading the rail can tell at
    // a glance which line is theirs.
    return (
      <div
        class={`flex items-baseline gap-2 text-xs leading-5 ${fadeClass}`}
        data-testid="minimal-thread-roster-entry"
        data-roster-kind="user"
      >
        <span class="shrink-0 text-blue-400" aria-hidden="true">
          👤
        </span>
        <span class={bodyClass}>{entry.text}</span>
      </div>
    );
  }

  if (entry.kind === 'handoff') {
    // Synthetic agent→agent / system handoff — arrow glyph + body.
    return (
      <div
        class={`flex items-baseline gap-2 text-xs leading-5 ${fadeClass}`}
        data-testid="minimal-thread-roster-entry"
        data-roster-kind="handoff"
      >
        <span class="shrink-0 text-gray-400" aria-hidden="true">
          ↪
        </span>
        <span class={bodyClass}>{entry.text}</span>
      </div>
    );
  }

  // Assistant message — small chat-bubble glyph (mirrors the open-session
  // affordance) plus an italic preview of the text. No mono-font / TOOL:
  // prefix so it visually reads as "the agent said this" rather than
  // "another command ran".
  return (
    <div
      class={`flex items-baseline gap-2 text-xs leading-5 ${fadeClass}`}
      data-testid="minimal-thread-roster-entry"
      data-roster-kind="message"
    >
      <svg
        class="w-3 h-3 shrink-0 text-gray-400 self-center"
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

/**
 * Terminal result subtypes surfaced inline as a red bubble in the minimal feed.
 * `error_max_budget_usd` is intentionally excluded — hitting a budget cap is a
 * deliberate cost guard, not an execution failure, so painting the whole turn
 * red would mislead. It still gets the amber result-info dropdown trigger.
 */
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

/**
 * First-line error summary for a terminal result error. Prefers the SDK's
 * `errors[]` (the model/SDK's own failure message); falls back to a humanized
 * subtype label so the red bubble always carries an explanation even when the
 * errors array is empty/missing (defensive against bridge providers that omit
 * it).
 */
function getResultErrorSummary(result: ResultMessage): string {
  const errors = (result as { errors?: unknown }).errors;
  if (Array.isArray(errors)) {
    const first = errors.find((e): e is string => typeof e === 'string' && e.trim().length > 0);
    if (first) return first.trim();
  }
  return RESULT_ERROR_SUBTYPE_LABELS[result.subtype] ?? 'Run failed';
}

/**
 * Body for a completed agent turn — wraps the meta-line + reply text in a
 * left-aligned chat bubble that sizes to content up to a max-width cap.
 *
 * Why bubble-style at all: agent replies are often long markdown blobs
 * (review summaries, hand-off briefs) that look like transcripts when
 * rendered as plain flush-left rows. A subtle bubble (`bg-dark-800`, one
 * shade lighter than the synthetic bubble's `bg-dark-900`) re-establishes
 * the conversational rhythm and differentiates "agent's own reply" from
 * "synthetic handoff" without competing with the human bubble's blue.
 *
 * Width strategy: stacked under the agent header (no avatar offset on the
 * left), so `w-fit` lets short replies hug their content, `max-w-full`
 * fills the row on mobile, and `md:max-w-[86%]` caps the width on desktop
 * to keep long markdown readable instead of stretching edge-to-edge.
 */
function CompletedBody({
  turn,
  overlayTaskId,
}: {
  turn: CompletedFeedTurn;
  overlayTaskId?: string;
}) {
  const isTerminalError = isInlineTerminalResultError(turn.resultInfo);
  const errorSummary =
    isTerminalError && turn.resultInfo ? getResultErrorSummary(turn.resultInfo) : null;
  const openSession = turn.sessionId
    ? () => {
        // `pushOverlayHistory` reads the highlight signal; passing the message
        // uuid scrolls the slide-over straight to this turn's surfaced reply.
        if (overlayTaskId && turn.agentKind === 'node_agent') {
          pushOverlayHistory(turn.sessionId as string, turn.agent, turn.highlightMessageUuid, {
            taskId: overlayTaskId,
            agentName: turn.agentRole,
            ...(turn.agentNodeExecutionId ? { nodeExecutionId: turn.agentNodeExecutionId } : {}),
          });
        } else {
          pushOverlayHistory(turn.sessionId as string, turn.agent, turn.highlightMessageUuid);
        }
      }
    : undefined;
  const isErrorBubble = isTerminalError || turn.hasError;
  return (
    <div class={`mt-1.5 w-fit ${TASK_THREAD_AGENT_BUBBLE_WIDTH_CLASS}`}>
      <div
        class={`rounded-lg px-3 py-2 ${
          isErrorBubble
            ? 'bg-red-900/20 border border-red-800'
            : 'bg-dark-800 border border-dark-700'
        }`}
        data-testid="minimal-thread-agent-bubble"
        data-result-error={isTerminalError ? 'true' : undefined}
        data-has-error={turn.hasError || undefined}
      >
        <ReplacementBadge status={turn.replacementStatus} />
        {turn.hasError ? (
          <div class="flex items-center gap-2 text-red-400 text-sm font-medium mb-1">
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
            class="mb-2 flex items-start gap-1.5 text-xs text-red-300"
            data-testid="minimal-thread-result-error-summary"
          >
            <svg
              class="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400"
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
                ? 'text-sm text-red-100 leading-relaxed [&_a]:text-red-300'
                : 'text-sm text-gray-100 leading-relaxed [&_a]:text-blue-400'
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
        resultInfo={turn.resultInfo}
      />
    </div>
  );
}

function ActiveBody({ turn, color }: { turn: ActiveFeedTurn; color: string }) {
  useSecondsTick();
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
      <div class="text-[11px] text-gray-400 mt-0.5" data-testid="minimal-thread-active-meta">
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
      <div class="mt-1.5 text-[11px] text-gray-400" data-testid="minimal-thread-last-event">
        last event {lastEventSec < 1 ? 'now' : `${formatDuration(lastEventSec)} ago`} ·{' '}
        {formatClock(turn.lastEventAt)}
      </div>
    </div>
  );
}

/**
 * Agent turn — Slack-style stacked layout. The header (avatar + name +
 * timestamp-when-active) sits on its own row; the body (bubble or active
 * rail) drops below the header at the full container width, aligned with
 * the avatar's left edge.
 *
 * Why stacked instead of avatar-on-the-left-of-body: agent replies are
 * frequently long markdown blobs. With the body indented under a flex
 * column to the right of the avatar, the bubble is forced into a narrower
 * sub-column (~48px lost to the avatar + gap) AND the legacy 85% cap left
 * dead space on the right. Stacking lets the body use the full row width
 * on mobile and feels closer to Slack/Reddit/Discord post layouts than
 * iMessage chat bubbles — a better fit for "agent post with long output".
 */
function AgentTurnRow({
  turn,
  overlayTaskId,
}: {
  turn: CompletedFeedTurn | ActiveFeedTurn;
  overlayTaskId?: string;
}) {
  const color = getAgentColor(turn.agent);
  const initial = agentInitial(turn.agent);
  const openSession = turn.sessionId
    ? () => {
        const highlightMessageUuid =
          turn.state === 'completed' ? turn.highlightMessageUuid : undefined;
        if (overlayTaskId && turn.agentKind === 'node_agent') {
          pushOverlayHistory(turn.sessionId as string, turn.agent, highlightMessageUuid, {
            taskId: overlayTaskId,
            agentName: turn.agentRole,
            ...(turn.agentNodeExecutionId ? { nodeExecutionId: turn.agentNodeExecutionId } : {}),
          });
        } else {
          pushOverlayHistory(turn.sessionId as string, turn.agent, highlightMessageUuid);
        }
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
          <span class="font-semibold leading-tight" style={{ color }}>
            {shortAgentName(turn.agent)}
          </span>
          {turn.state === 'active' ? (
            <span class="text-xs text-gray-400 leading-tight">{formatClock(turn.startedAt)}</span>
          ) : null}
        </div>
        {turn.state === 'completed' ? (
          <div
            class="text-[11px] text-gray-400 leading-tight"
            data-testid="minimal-thread-agent-meta"
          >
            {turn.toolCalls} {turn.toolCalls === 1 ? 'tool call' : 'tool calls'} · {turn.messages}{' '}
            {turn.messages === 1 ? 'message' : 'messages'} · {formatDuration(turn.durationSec)}
          </div>
        ) : (
          <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <StatusPill color={color} status={turn.status} />
            <span class="text-[11px] text-gray-400 leading-tight">
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
      {/* Header — avatar + stacked (name / meta-or-clock) column. The meta
			    line ("3 tool calls · 4 messages · 22s") lives here under the
			    agent name on completed turns instead of inside the reply
			    bubble — it's metadata about the turn, not part of the agent's
			    spoken reply, so reading it as "subtitle" rather than "first
			    line of the bubble" is more intuitive. Active turns swap the
			    meta for a live clock; the rail body still shows the running
			    tool counter + roster.

			    Active turns don't get an actions row below (no copy while
			    running), so completed turns surface time + copy under the
			    bubble via SpaceTaskThreadMessageActions to avoid duplicating
			    the header clock. */}
      {openSession ? (
        <button
          type="button"
          class="-m-1 flex min-h-11 max-w-full items-center gap-3 rounded-lg p-1 pr-2 text-left transition-colors hover:bg-dark-800/55 active:bg-dark-800/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
          onClick={openSession}
          title="Open session"
          aria-label={`Open ${turn.agent} session`}
          data-testid="minimal-thread-agent-open"
        >
          {headerContent}
        </button>
      ) : (
        <div class="flex min-h-11 items-center gap-3">{headerContent}</div>
      )}
      {/* Body — full-width on mobile, capped on desktop for readability. */}
      {turn.state === 'active' ? (
        <ActiveBody turn={turn} color={color} />
      ) : (
        <CompletedBody turn={turn} overlayTaskId={overlayTaskId} />
      )}
    </div>
  );
}

/**
 * Human user input — iMessage-style blue bubble, right-aligned. No header
 * decoration: the user IS the human, the recipient is implicit (this is the
 * recipient agent's session view).
 */
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
          class="bg-blue-500 text-white rounded-[20px] px-4 py-2 leading-relaxed break-words"
          data-testid="minimal-thread-human-bubble"
        >
          <ReplacementBadge status={turn.replacementStatus} />
          {turn.body ? (
            <p class="whitespace-pre-wrap break-words">{turn.body}</p>
          ) : (
            <p class="opacity-70 italic">(empty message)</p>
          )}
        </div>
        {/* Right-aligned actions row — timestamp + (optional)
				    session-init dropdown + copy. Replaces the bare
				    timestamp so the human bubble has parity with synthetic
				    messages and agent reply bubbles. */}
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

/**
 * Synthetic / agent→agent handoff — delegates rendering to the shared
 * `SyntheticMessageBlock` so this idiom looks identical in the chat
 * container and the task thread feed. The thread-feed wrapper adds:
 *   • Turn-level data attributes consumed by E2E tests / sticky headers.
 *   • Agent route info (FROM→TO badge) since the thread feed has agent
 *     labels that the chat container doesn't surface.
 *   • An "open in session" callback that pops the session overlay scrolled
 *     to this synthetic message.
 */
function CompactBoundaryTurn({
  turn,
  overlayTaskId,
}: {
  turn: CompactBoundaryFeedTurn;
  overlayTaskId?: string;
}) {
  const color = getAgentColor(turn.agent);
  const tokenDelta =
    typeof turn.postTokens === 'number' ? Math.max(0, turn.preTokens - turn.postTokens) : null;
  const tokenSummary = `${turn.preTokens.toLocaleString()} → ${turn.postTokens?.toLocaleString() ?? '—'} tokens`;
  const openSession = turn.sessionId
    ? () => {
        if (overlayTaskId && turn.agentKind === 'node_agent') {
          pushOverlayHistory(turn.sessionId as string, turn.agent, turn.highlightMessageUuid, {
            taskId: overlayTaskId,
            agentName: turn.agentRole,
            ...(turn.agentNodeExecutionId ? { nodeExecutionId: turn.agentNodeExecutionId } : {}),
          });
        } else {
          pushOverlayHistory(turn.sessionId as string, turn.agent, turn.highlightMessageUuid);
        }
      }
    : undefined;
  const card = (
    <div class="w-full rounded-lg border border-yellow-300/50 bg-yellow-400/10 px-3 py-2 text-yellow-100 shadow-sm shadow-yellow-950/20 dark:border-yellow-400/30 dark:bg-yellow-400/10">
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <span class="h-2 w-2 rounded-full bg-yellow-300 shadow-[0_0_10px_rgba(253,224,71,0.65)]" />
          <span class="text-xs font-semibold uppercase tracking-[0.16em] text-yellow-200">
            Compact Boundary
          </span>
          <span class="text-[11px] text-yellow-300/80" style={{ color }}>
            {shortAgentName(turn.agent)}
          </span>
        </div>
        <span class="shrink-0 text-[11px] text-yellow-200/70">{formatClock(turn.createdAt)}</span>
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-2 text-xs text-yellow-100/90">
        <span class="rounded-full border border-yellow-300/30 bg-yellow-300/10 px-2 py-0.5 font-medium capitalize text-yellow-100">
          {turn.trigger}
        </span>
        <span>{tokenSummary}</span>
        {tokenDelta !== null ? (
          <span class="text-yellow-200/75">saved {tokenDelta.toLocaleString()}</span>
        ) : null}
        {typeof turn.durationMs === 'number' ? (
          <span class="text-yellow-200/75">
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
          class="w-full rounded-lg text-left transition-colors hover:bg-yellow-400/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-yellow-300/60"
          onClick={openSession}
          title="Open session"
          aria-label={`Open ${turn.agent} session at compact boundary`}
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

function SystemTurn({ turn, overlayTaskId }: { turn: SystemFeedTurn; overlayTaskId?: string }) {
  const color = getAgentColor(turn.agent);
  const openSession = turn.sessionId
    ? () => {
        if (overlayTaskId && turn.agentKind === 'node_agent') {
          pushOverlayHistory(turn.sessionId as string, turn.agent, turn.highlightMessageUuid, {
            taskId: overlayTaskId,
            agentName: turn.agentRole,
            ...(turn.agentNodeExecutionId ? { nodeExecutionId: turn.agentNodeExecutionId } : {}),
          });
        } else {
          pushOverlayHistory(turn.sessionId as string, turn.agent, turn.highlightMessageUuid);
        }
      }
    : undefined;
  const card = (
    <div class="w-fit max-w-full rounded-lg border border-slate-700 bg-slate-900/40 px-3 py-2 text-slate-200">
      <ReplacementBadge status={turn.replacementStatus} />
      <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span class="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          {turn.title}
        </span>
        <span class="text-[11px] text-slate-500" style={{ color }}>
          {shortAgentName(turn.agent)}
        </span>
        <span class="text-[11px] text-slate-500">{formatClock(turn.createdAt)}</span>
      </div>
      <div class="mt-1 text-xs text-slate-200">{turn.body}</div>
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
          class="rounded-lg text-left transition-colors hover:bg-slate-800/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/60"
          onClick={openSession}
          title="Open session"
          aria-label={`Open ${turn.agent} session at ${turn.title}`}
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
}: {
  turn: MessageFeedTurn;
  overlayTaskId?: string;
}) {
  const fromColor = getAgentColor(turn.fromLabel);
  const toColor = getAgentColor(turn.toLabel);
  const fromShort = shortAgentName(turn.fromLabel);
  const toShort = shortAgentName(turn.toLabel);
  const replacementFrameClass =
    turn.replacementStatus === 'retracted'
      ? 'border-rose-500/35 bg-rose-500/5'
      : 'border-amber-500/35 bg-amber-500/5';
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
      onOpenSession={
        turn.sessionId
          ? () => {
              if (overlayTaskId && turn.toKind === 'node_agent') {
                pushOverlayHistory(
                  turn.sessionId as string,
                  turn.toLabel,
                  turn.highlightMessageUuid,
                  {
                    taskId: overlayTaskId,
                    agentName: turn.toRole,
                    ...(turn.toNodeExecutionId ? { nodeExecutionId: turn.toNodeExecutionId } : {}),
                  }
                );
              } else {
                pushOverlayHistory(
                  turn.sessionId as string,
                  turn.toLabel,
                  turn.highlightMessageUuid
                );
              }
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

function MinimalTurnRow({ turn, overlayTaskId }: { turn: FeedTurn; overlayTaskId?: string }) {
  if (turn.state === 'compact_boundary') {
    return <CompactBoundaryTurn turn={turn} overlayTaskId={overlayTaskId} />;
  }
  if (turn.state === 'system') {
    return <SystemTurn turn={turn} overlayTaskId={overlayTaskId} />;
  }
  if (turn.state === 'message') {
    return turn.isSynthetic ? (
      <SyntheticMessageTurn turn={turn} overlayTaskId={overlayTaskId} />
    ) : (
      <HumanMessageTurn turn={turn} />
    );
  }
  return <AgentTurnRow turn={turn} overlayTaskId={overlayTaskId} />;
}

/* ── public component ────────────────────────────────────────────────────── */

const EMPTY_ACTIVE_AGENT_LABELS: ReadonlySet<string> = new Set();

export function MinimalThreadFeed({
  parsedRows,
  activeAgentLabels = EMPTY_ACTIVE_AGENT_LABELS,
  activeTurnSummaries = [],
  overlayTaskId,
}: MinimalThreadFeedProps) {
  const turns = buildFeedTurns(parsedRows, activeAgentLabels, activeTurnSummaries);
  if (turns.length === 0) return null;

  return (
    <>
      <style>{ANIMATIONS_CSS}</style>
      <div class="px-4 py-4 space-y-6" data-testid="space-task-event-feed-minimal">
        {turns.map((turn) => (
          <MinimalTurnRow key={turn.id} turn={turn} overlayTaskId={overlayTaskId} />
        ))}
      </div>
    </>
  );
}

/* ── animations (scoped via local <style> tag) ───────────────────────────── */

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
