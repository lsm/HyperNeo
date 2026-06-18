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

import type { SDKMessage } from '@neokai/shared/sdk/sdk.d.ts';
import type { ActiveTurnSummary, ActivityEntry, ActorMessageDeliveryState } from '@neokai/shared';
import {
  isSDKAssistantMessage,
  isSDKCompactBoundary,
  isHiddenSystemSubtype,
  isSDKResultMessage,
  isSDKSystemInit,
  isToolUseBlock,
} from '@neokai/shared/sdk/type-guards';

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
 * Server-derived: shapes mirror `ActivityEntry` from `@neokai/shared` 1:1. The
 * mapping happens in `rosterEntriesFromSummary` so the renderer stays decoupled
 * from the wire format.
 */
interface RosterToolEntry {
  kind: 'tool';
  tool: string;
  preview: string;
  ts: number;
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
type ActiveRosterEntry =
  | RosterToolEntry
  | RosterMessageEntry
  | RosterThinkingEntry
  | RosterUserEntry
  | RosterHandoffEntry;

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

function mapActivityEntry(entry: ActivityEntry): ActiveRosterEntry | null {
  switch (entry.kind) {
    case 'tool_use':
      return {
        kind: 'tool',
        tool: typeof entry.toolName === 'string' ? entry.toolName : '',
        preview: typeof entry.preview === 'string' ? entry.preview : '',
        ts: entry.ts,
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

function latestSessionId(rows: ParsedThreadRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].sessionId) return rows[i].sessionId;
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
} {
  let resultFallback: { text: string; sourceRow: ParsedThreadRow } | null = null;

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
    if (texts.length > 0) return { text: texts.join('\n\n'), fallback: false, sourceRow: row };
  }

  // No assistant text anywhere in the turn — fall back to the result envelope.
  if (resultFallback) {
    return { text: resultFallback.text, fallback: false, sourceRow: resultFallback.sourceRow };
  }

  const tail = rows[rows.length - 1] ?? null;
  const tailFallback = tail?.fallbackText ?? '';
  return { text: tailFallback, fallback: true, sourceRow: tail };
}

function buildCompletedTurn(
  block: AgentTurnBlock,
  rows: ParsedThreadRow[],
  turnId: string,
  resultInfo: ResultMessage | undefined,
  transitionSummary: ActiveTurnSummary | undefined = undefined
): CompletedFeedTurn {
  const startedAt = rows[0].createdAt;
  const lastRow = rows[rows.length - 1];
  const resultRow = resultInfo ? rows.find((row) => row.message === resultInfo) : undefined;
  const endedAt = resultRow?.createdAt ?? lastRow.createdAt;
  const durationMs = Math.max(0, endedAt - startedAt);
  const durationSec = Math.max(1, Math.round(durationMs / 1000));
  const { text, fallback, sourceRow } = extractLastAssistantText(rows);
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
    sessionId: highlightSource?.sessionId ?? lastRow.sessionId,
    highlightMessageUuid: highlightUuid,
    replacementStatus: sourceRow?.replacementStatus,
    resultInfo,
  };
}

function buildActiveTurn(
  block: AgentTurnBlock,
  rows: ParsedThreadRow[],
  turnId: string,
  summary: ActiveTurnSummary | undefined,
  sessionId: string | null
): ActiveFeedTurn {
  return {
    state: 'active',
    id: turnId,
    agent: block.agentLabel,
    agentKind: rows[0]?.kind ?? 'task_agent',
    agentRole: rows[0]?.role ?? block.agentLabel,
    agentNodeExecutionId: rows[0]?.nodeExecutionId ?? null,
    startedAt: rows[0].createdAt,
    status: 'Running…',
    toolCalls: countToolCallsForActive(rows, summary),
    messages: countMessagesForActive(rows),
    thinkingEntries: countSummaryEntries(summary, 'thinking'),
    messageEntries: countSummaryEntries(summary, 'text'),
    toolEntries: countSummaryEntries(summary, 'tool_use'),
    lastEventAt: latestActivityTimestamp(summary, rows),
    roster: rosterEntriesFromSummary(summary, ROSTER_MAX_ENTRIES),
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

function buildOperationalSystemTurn(
  row: ParsedThreadRow,
  isSessionTail: boolean
): SystemFeedTurn | null {
  const message = row.message;
  if (!message || message.type !== 'system') return null;
  const subtype = (message as { subtype?: string }).subtype;
  if (!subtype || subtype === 'init') return null;
  // Honor the centralized hidden-subtype contract so Space task threads
  // don't surface noisy rows the main transcript already hides.
  if (isHiddenSystemSubtype(subtype)) return null;
  if (subtype === 'informational' && (message as { level?: string }).level === 'info') {
    return null;
  }
  if (subtype === 'worker_shutting_down' && !isSessionTail) return null;
  const highlightUuid =
    typeof (message as { uuid?: unknown }).uuid === 'string'
      ? ((message as { uuid: string }).uuid as string)
      : undefined;

  if (subtype === 'thinking_tokens') {
    const estimatedTokens = (message as { estimated_tokens?: unknown }).estimated_tokens;
    const delta = (message as { estimated_tokens_delta?: unknown }).estimated_tokens_delta;
    const tokenText =
      typeof estimatedTokens === 'number' ? estimatedTokens.toLocaleString() : 'unknown';
    const deltaText =
      typeof delta === 'number' ? ` (${delta >= 0 ? '+' : ''}${delta.toLocaleString()})` : '';
    return {
      state: 'system',
      id: `system-${String(row.id)}`,
      agent: row.label,
      agentKind: row.kind,
      agentRole: row.role,
      agentNodeExecutionId: row.nodeExecutionId ?? null,
      createdAt: row.createdAt,
      title: 'Thinking tokens',
      body: `${tokenText} estimated tokens${deltaText}`,
      sessionId: row.sessionId,
      highlightMessageUuid: highlightUuid,
      replacementStatus: row.replacementStatus,
    };
  }

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
        buildCompletedTurn(block, pendingAgentRows, turnId, resultInfo, transitionSummary)
      );
      perAgentTrailing.set(blockKey, {
        turnIdx: turns.length - 1,
        rows: pendingAgentRows,
        block,
      });
      pendingAgentRows = [];
    };

    for (const row of block.rows) {
      const compactBoundaryTurn = buildCompactBoundaryTurn(row);
      if (compactBoundaryTurn) {
        flushAgent();
        turns.push(compactBoundaryTurn);
        continue;
      }
      const operationalSystemTurn = buildOperationalSystemTurn(
        row,
        row.sessionId ? latestRowIdBySession.get(row.sessionId) === String(row.id) : false
      );
      if (operationalSystemTurn) {
        flushAgent();
        turns.push(operationalSystemTurn);
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
      const summary = sessionId ? summariesBySession.get(sessionId) : undefined;
      turns[trailing.turnIdx] = buildActiveTurn(
        trailing.block,
        trailing.rows,
        completed.id,
        summary,
        sessionId
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
  return turns.filter((t) => {
    if (t.state !== 'completed') return true;
    return t.lastMessage.length > 0;
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
    <span class="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider font-medium">
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
    return (
      <div
        class={`flex items-start gap-2 font-mono text-xs leading-5 ${fadeClass}`}
        data-testid="minimal-thread-roster-entry"
        data-roster-kind="tool"
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
  return (
    <div class={`mt-1.5 w-fit ${TASK_THREAD_AGENT_BUBBLE_WIDTH_CLASS}`}>
      <div
        class="bg-dark-800 border border-dark-700 rounded-lg px-3 py-2"
        data-testid="minimal-thread-agent-bubble"
      >
        <ReplacementBadge status={turn.replacementStatus} />
        {turn.lastMessage ? (
          <div class="text-sm text-gray-100 leading-relaxed [&_a]:text-blue-400">
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
