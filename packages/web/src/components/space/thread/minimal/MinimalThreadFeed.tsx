import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { ActiveTurnSummary, ActivityEntry, MessageDeliveryStatus } from '@hyperneo/shared';
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
import { getAgentColor, getAgentTextColor } from '../space-task-thread-agent-colors';
import type { ParsedThreadRow } from '../space-task-thread-events';
import { pushOverlayHistory } from '../../../../lib/router';
import { useVisibleTick } from '../../../../hooks/useVisibleTick';
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
  activeAgentLabels?: ReadonlySet<string>;
  activeTurnSummaries?: ActiveTurnSummary[];
  overlayTaskId?: string;
  overlayTaskReadonly?: boolean;
}

interface RosterToolEntry {
  kind: 'tool';
  tool: string;
  preview: string;
  ts: number;
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
  hasError: boolean;
  sessionId: string | null;
  highlightMessageUuid?: string;
  replacementStatus?: MessageReplacementStatus;
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
  fromLabel: string;
  toLabel: string;
  toKind: 'task_agent' | 'node_agent';
  toRole: string;
  toNodeExecutionId?: string | null;
  body: string;
  bodyIsFallback: boolean;
  createdAt: number;
  isSynthetic: boolean;
  sessionId: string | null;
  deliveryState?: MessageDeliveryStatus | null;
  highlightMessageUuid?: string;
  replacementStatus?: MessageReplacementStatus;
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
        isRetracted ? 'text-cat-rose' : 'text-warning'
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

function isHiddenStandaloneStatusRow(row: ParsedThreadRow): boolean {
  const parsed = parseSystemStatusRow(row);
  return !!parsed && !parsed.isClear && parsed.status !== 'compacting';
}

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

function rowsContainResultError(rows: ParsedThreadRow[]): boolean {
  return rows.some((row) => row.message && isSDKResultError(row.message));
}

function latestSessionId(rows: ParsedThreadRow[]): string | null {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].sessionId) return rows[i].sessionId;
  }
  return null;
}

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

function extractLastAssistantText(rows: ParsedThreadRow[]): {
  text: string;
  fallback: boolean;
  sourceRow: ParsedThreadRow | null;
  hasError: boolean;
} {
  let resultFallback: { text: string; sourceRow: ParsedThreadRow } | null = null;
  let assistantHasError = false;

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!row.message) continue;

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
      const rostered = new Set([
        ...globalRosteredToolUseIds,
        ...rosteredToolUseIdsFromRoster(base),
      ]);
      return mergeRosterWithNotifications(
        base,
        standaloneTaskNotificationEntries(rows, rostered),
        Infinity
      );
    })(),
  };
}

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

function mergeRosterWithNotifications(
  base: ActiveRosterEntry[],
  notifications: RosterTaskNotificationEntry[],
  maxEntries: number = ROSTER_MAX_ENTRIES
): ActiveRosterEntry[] {
  const merged = [...base, ...notifications].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    const aNotif = a.kind === 'task_notification';
    const bNotif = b.kind === 'task_notification';
    if (aNotif !== bNotif) return aNotif ? -1 : 1;
    return 0;
  });
  return maxEntries === Infinity ? merged : merged.slice(-maxEntries);
}

function rosteredToolUseIdsFromRoster(roster: ActiveRosterEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of roster) {
    if (entry.kind === 'tool' && entry.toolUseId) ids.add(entry.toolUseId);
  }
  return ids;
}

function collectActiveRosteredToolUseIds(
  summaries: ActiveTurnSummary[],
  renderedTurnKeys: Set<string>
): Set<string> {
  const ids = new Set<string>();
  for (const summary of summaries) {
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
  const rostered = new Set([
    ...globalRosteredToolUseIds,
    ...rosteredToolUseIdsFromRoster(baseRoster),
  ]);
  const labelKey = normalizeAgentKey(block.agentLabel);
  const sessionEntry = sessionId ? latestStatusBySession?.get(sessionId) : undefined;
  const labelEntry = latestStatusBySession?.get(labelKey);
  const activeStatus = sessionEntry ?? labelEntry;
  const cappedBase = mergeRosterWithNotifications(
    baseRoster,
    standaloneTaskNotificationEntries(rows, rostered)
  );
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
  if (isSynthetic) return { label: '', isSynthetic: true };
  return { label: 'User', isSynthetic: false };
}

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
  if (subtype === 'status') {
    const statusValue = (message as { status?: unknown }).status;
    if (statusValue === null) return null;
    if (consumedStatusRowIds && consumedStatusRowIds.has(String(row.id))) return null;
    if (statusValue !== 'compacting') return null;
  }
  if (subtype === 'hook_started' || subtype === 'hook_progress' || subtype === 'hook_response') {
    return null;
  }
  if (isFoldedTaskNotification(row, rosteredToolUseIds)) return null;
  if (subtype === 'api_retry' || subtype === 'thinking_tokens' || subtype === 'task_notification')
    return null;
  if (isHiddenSystemSubtype(subtype)) return null;
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

function buildFeedTurns(
  parsedRows: ParsedThreadRow[],
  activeAgentLabels: ReadonlySet<string>,
  activeTurnSummaries: ActiveTurnSummary[]
): FeedTurn[] {
  const rowsWithReplacementStatus = applyReplacementStatuses(parsedRows);
  const blocks = buildAgentTurns(rowsWithReplacementStatus);
  if (blocks.length === 0) return [];

  const taskNotificationsByToolUseId = indexTaskNotifications(rowsWithReplacementStatus);

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
      latestStatusBySession.delete(targetKey);
      continue;
    }

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
    const sliceContributesToRoster = (sliceRows: ParsedThreadRow[]) =>
      extractLastAssistantText(sliceRows).text.length > 0 ||
      sliceRows.some((r) => getToolUseContentBlocks(r).length > 0);
    const flush = (isFinal = false) => {
      if (
        (pendingAgentRows.length > 0 &&
          !(isFinal && trailingBlockCanUpgradeToActive) &&
          sliceContributesToRoster(pendingAgentRows)) ||
        rowsContainResultError(pendingAgentRows)
      ) {
        out.push(pendingAgentRows);
      }
      pendingAgentRows = [];
    };
    for (const row of block.rows) {
      if (isFoldedSystemStatusRow(row, consumedStatusRowIds)) continue;
      if (parseSystemStatusRow(row)?.isClear || isHiddenStandaloneStatusRow(row)) continue;
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

  const rosteredToolUseIds = collectRosteredToolUseIds(
    activeTurnSummaries,
    renderedTurnKeys,
    completedRows
  );

  const latestRowIdBySession = new Map<string, string>();
  for (const row of rowsWithReplacementStatus) {
    if (row.sessionId) latestRowIdBySession.set(row.sessionId, String(row.id));
  }

  const summariesBySession = new Map<string, ActiveTurnSummary>();
  for (const summary of activeTurnSummaries) {
    summariesBySession.set(summary.sessionId, summary);
  }

  const turns: FeedTurn[] = [];
  type AgentTrailing = {
    turnIdx: number;
    rows: ParsedThreadRow[];
    block: AgentTurnBlock;
  };
  const perAgentTrailing = new Map<string, AgentTrailing>();
  let previousAgentLabel: string | null = null;

  for (const block of blocks) {
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
      if (parseSystemStatusRow(row)?.isClear || isHiddenStandaloneStatusRow(row)) continue;
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

  return turns.filter((t) => {
    if (t.state !== 'completed') return true;
    if (t.resultInfo && isSDKResultError(t.resultInfo)) return true;
    return t.lastMessage.length > 0 || t.roster.length > 0;
  });
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

const EMPTY_ACTIVE_AGENT_LABELS: ReadonlySet<string> = new Set();

export function MinimalThreadFeed({
  parsedRows,
  activeAgentLabels = EMPTY_ACTIVE_AGENT_LABELS,
  activeTurnSummaries = [],
  overlayTaskId,
  overlayTaskReadonly,
}: MinimalThreadFeedProps) {
  const turns = buildFeedTurns(parsedRows, activeAgentLabels, activeTurnSummaries);
  if (turns.length === 0) return null;

  return (
    <>
      <style>{ANIMATIONS_CSS}</style>
      <div class="px-4 py-4 space-y-6" data-testid="space-task-event-feed-minimal">
        {turns.map((turn) => (
          <MinimalTurnRow
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
