import type { SDKMessage } from '@hyperneo/shared/sdk/sdk.d.ts';
import type { MessageDeliveryStatus } from '@hyperneo/shared';
import {
  type ContentBlock,
  hasRenderableThinking,
  isSDKAssistantMessage,
  isSDKCompactBoundary,
  isSDKRateLimitEvent,
  isSDKResultMessage,
  isSDKSystemMessage,
  isSDKToolProgressMessage,
  isSDKUserMessage,
  isTextBlock,
  isThinkingBlock,
  isToolUseBlock,
} from '@hyperneo/shared/sdk/type-guards';
import type { SpaceTaskThreadMessageRow } from '../../../hooks/useSpaceTaskMessages';
import type { MessageReplacementStatus } from '../../../lib/sdk-message-replacement';

export type SpaceTaskThreadEventKind =
  | 'thinking'
  | 'tool'
  | 'subagent'
  | 'text'
  | 'user'
  | 'system'
  | 'compact_boundary'
  | 'result'
  | 'rate_limit'
  | 'progress'
  | 'unknown';

export interface ParsedThreadRow {
  id: string | number;
  sessionId: string | null;
  kind: 'task_agent' | 'node_agent';
  label: string;
  role: string;
  nodeExecutionId?: string | null;
  taskId: string;
  taskTitle: string;
  createdAt: number;
  turnIndex?: number;
  turnHiddenMessageCount?: number;
  deliveryState?: MessageDeliveryStatus | null;
  message: SDKMessage | null;
  fallbackText: string | null;
  replacementStatus?: MessageReplacementStatus;
  contentTruncated?: boolean;
  contentBytes?: number;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

export interface SpaceTaskThreadEvent {
  id: string;
  label: string;
  role: string;
  nodeExecutionId?: string | null;
  taskId: string;
  taskTitle: string;
  sessionId: string | null;
  createdAt: number;
  kind: SpaceTaskThreadEventKind;
  title: string;
  summary: string;
  message?: SDKMessage | null;
  iconToolName?: string;
  systemSubtype?: string;
  resultSubtype?: string;
  isError?: boolean;
  todos?: TodoItem[];
}

function oneLine(value: string, max = 180): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

function normalizeMultiline(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

function shouldPromotePathToTitle(filePath: string): boolean {
  const trimmed = filePath.trim();
  if (!trimmed) return false;
  const isRelative = !trimmed.startsWith('/');
  return isRelative || trimmed.length <= 72;
}

function summarizeInputValue(value: unknown): string {
  if (value == null) return 'none';
  if (typeof value === 'string') return oneLine(value, 120);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    const compact = value
      .slice(0, 2)
      .map((item) => summarizeInputValue(item))
      .join(', ');
    return value.length > 2 ? `[${compact}, +${value.length - 2}]` : `[${compact}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return '{}';
    if (typeof obj.query === 'string') return `query: ${oneLine(obj.query, 120)}`;
    const fields = keys.slice(0, 2).join(', ');
    return keys.length > 2 ? `{${fields}, +${keys.length - 2}}` : `{${fields}}`;
  }
  return oneLine(String(value), 120);
}

function summarizeToolInput(input: Record<string, unknown>): string {
  const keys = Object.keys(input);
  if (keys.length === 0) return 'No input';

  const entries = keys.slice(0, 3).map((key) => `${key}: ${summarizeInputValue(input[key])}`);
  const summary = entries.join('\n');
  return keys.length > 3 ? `${summary}\n+${keys.length - 3} fields` : summary;
}

function extractUserText(message: Extract<SDKMessage, { type: 'user' }>): string {
  const content = message.message?.content;
  if (typeof content === 'string') return oneLine(content);
  if (!Array.isArray(content)) return '';

  const textParts: string[] = [];
  for (const block of content) {
    const blockObj = block as unknown as Record<string, unknown>;
    if (blockObj.type === 'text' && typeof blockObj.text === 'string') {
      textParts.push(blockObj.text);
    }
  }
  return oneLine(textParts.join(' '));
}

function extractAssistantEvents(
  row: ParsedThreadRow,
  message: Extract<SDKMessage, { type: 'assistant' }>
) {
  const events: SpaceTaskThreadEvent[] = [];
  const content = Array.isArray(message.message?.content)
    ? (message.message.content as ContentBlock[])
    : [];

  for (let idx = 0; idx < content.length; idx += 1) {
    const block = content[idx];
    const eventId = `${String(row.id)}-assistant-${idx}`;

    if (isThinkingBlock(block)) {
      if (!hasRenderableThinking(block)) {
        continue;
      }
      events.push({
        id: eventId,
        label: row.label,
        role: row.role,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        sessionId: row.sessionId,
        createdAt: row.createdAt,
        kind: 'thinking',
        title: 'Thinking',
        summary: oneLine(block.thinking),
        iconToolName: 'Thinking',
      });
      continue;
    }

    if (isToolUseBlock(block)) {
      if (block.name === 'request_human_input') {
        const input = (block.input ?? {}) as Record<string, unknown>;
        const question = typeof input.question === 'string' ? input.question.trim() : '';
        const questionContext = typeof input.context === 'string' ? input.context.trim() : '';
        const body = questionContext ? `${question}\n\nContext: ${questionContext}` : question;
        if (body) {
          const questionMessage = {
            ...message,
            message: {
              ...message.message,
              content: [{ type: 'text', text: body, citations: null }],
            },
          } as unknown as SDKMessage;
          events.push({
            id: eventId,
            label: row.label,
            role: row.role,
            taskId: row.taskId,
            taskTitle: row.taskTitle,
            sessionId: row.sessionId,
            createdAt: row.createdAt,
            kind: 'text',
            title: 'Question',
            summary: body,
            message: questionMessage,
          });
          continue;
        }
      }

      const isSubagent = block.name === 'Task';
      const isBash = block.name === 'Bash';
      const input = (block.input ?? {}) as Record<string, unknown>;
      const subagentType = typeof input.subagent_type === 'string' ? input.subagent_type : 'agent';
      const description = typeof input.description === 'string' ? input.description : '';
      const bashCommand =
        typeof input.command === 'string' ? normalizeMultiline(input.command) : '';
      const isRead = block.name === 'Read';
      const readFilePath =
        isRead && typeof input.file_path === 'string' ? normalizeMultiline(input.file_path) : '';
      const showReadPathInTitle =
        isRead && readFilePath ? shouldPromotePathToTitle(readFilePath) : false;
      const readInputWithoutFilePath = showReadPathInTitle
        ? (Object.fromEntries(
            Object.entries(input).filter(([key]) => key !== 'file_path')
          ) as Record<string, unknown>)
        : input;
      const isGrep = block.name === 'Grep';
      const grepPattern =
        isGrep && typeof input.pattern === 'string' ? normalizeMultiline(input.pattern) : '';
      const showGrepPatternInTitle = isGrep && grepPattern.length > 0;
      const grepInputWithoutPattern = showGrepPatternInTitle
        ? (Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'pattern')) as Record<
            string,
            unknown
          >)
        : input;
      const isTodo = block.name === 'TodoWrite';
      const todosRaw =
        isTodo && Array.isArray(input.todos) ? (input.todos as TodoItem[]) : undefined;
      const isGlob = block.name === 'Glob';
      const globPattern = isGlob && typeof input.pattern === 'string' ? input.pattern : '';
      const toolSummary =
        isSubagent && description
          ? `${subagentType} · ${oneLine(description)}`
          : isBash
            ? bashCommand || 'No command'
            : isRead && showReadPathInTitle
              ? Object.keys(readInputWithoutFilePath).length > 0
                ? summarizeToolInput(readInputWithoutFilePath)
                : ''
              : isGrep && showGrepPatternInTitle
                ? Object.keys(grepInputWithoutPattern).length > 0
                  ? summarizeToolInput(grepInputWithoutPattern)
                  : ''
                : isGlob
                  ? ''
                  : summarizeToolInput(input);
      const toolTitle = isSubagent
        ? 'Sub-agent'
        : isBash && description
          ? `Bash: ${oneLine(description, 120)}`
          : isRead && showReadPathInTitle
            ? `Read: ${oneLine(readFilePath, 120)}`
            : isGrep && showGrepPatternInTitle
              ? `Grep: ${oneLine(grepPattern, 120)}`
              : isGlob && globPattern
                ? `Glob: ${oneLine(globPattern, 120)}`
                : block.name;

      events.push({
        id: eventId,
        label: row.label,
        role: row.role,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        sessionId: row.sessionId,
        createdAt: row.createdAt,
        kind: isSubagent ? 'subagent' : 'tool',
        title: toolTitle,
        summary: toolSummary ?? block.name,
        iconToolName: isSubagent ? 'Task' : block.name,
        todos: todosRaw,
      });
      continue;
    }

    if (isTextBlock(block)) {
      const text = normalizeMultiline(block.text);
      if (!text) continue;
      const textOnlyMessage = {
        ...message,
        message: {
          ...message.message,
          content: [{ type: 'text', text: block.text, citations: null }],
        },
      } as unknown as SDKMessage;
      events.push({
        id: eventId,
        label: row.label,
        role: row.role,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        sessionId: row.sessionId,
        createdAt: row.createdAt,
        kind: 'text',
        title: row.label,
        summary: text,
        message: textOnlyMessage,
      });
    }
  }

  if (events.length === 0) {
    events.push({
      id: `${String(row.id)}-assistant-empty`,
      label: row.label,
      role: row.role,
      nodeExecutionId: row.nodeExecutionId ?? null,
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      sessionId: row.sessionId,
      createdAt: row.createdAt,
      kind: 'text',
      title: row.label,
      summary: 'Assistant updated context',
      message,
    });
  }

  return events;
}

export function parseThreadRow(row: SpaceTaskThreadMessageRow): ParsedThreadRow {
  try {
    const parsed = JSON.parse(row.content) as SDKMessage;
    const withTimestamp = {
      ...(parsed as Record<string, unknown>),
      timestamp: row.createdAt,
      ...(row.origin ? { origin: row.origin } : {}),
    } as unknown as SDKMessage;

    return {
      id: row.id,
      sessionId: row.sessionId,
      kind: row.kind,
      label: row.label,
      role: row.role,
      nodeExecutionId: row.nodeExecutionId ?? null,
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      createdAt: row.createdAt,
      turnIndex: row.turnIndex,
      turnHiddenMessageCount: row.turnHiddenMessageCount,
      deliveryState: row.deliveryState ?? null,
      message: withTimestamp,
      fallbackText: null,
      contentTruncated: row.contentTruncated,
      contentBytes: row.contentBytes,
    };
  } catch {
    return {
      id: row.id,
      sessionId: row.sessionId,
      kind: row.kind,
      label: row.label,
      role: row.role,
      nodeExecutionId: row.nodeExecutionId ?? null,
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      createdAt: row.createdAt,
      turnIndex: row.turnIndex,
      turnHiddenMessageCount: row.turnHiddenMessageCount,
      deliveryState: row.deliveryState ?? null,
      message: null,
      fallbackText: row.content,
      contentTruncated: row.contentTruncated,
      contentBytes: row.contentBytes,
    };
  }
}

export function buildThreadEvents(parsedRows: ParsedThreadRow[]): SpaceTaskThreadEvent[] {
  const events: SpaceTaskThreadEvent[] = [];

  for (const row of parsedRows) {
    if (!row.message) {
      events.push({
        id: `${String(row.id)}-fallback`,
        label: row.label,
        role: row.role,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        sessionId: row.sessionId,
        createdAt: row.createdAt,
        kind: 'unknown',
        title: 'Raw',
        summary: oneLine(row.fallbackText ?? ''),
        message: row.message,
      });
      continue;
    }

    if (isSDKAssistantMessage(row.message)) {
      events.push(...extractAssistantEvents(row, row.message));
      continue;
    }

    if (isSDKUserMessage(row.message)) {
      events.push({
        id: `${String(row.id)}-user`,
        label: row.label,
        role: row.role,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        sessionId: row.sessionId,
        createdAt: row.createdAt,
        kind: 'user',
        title: 'User',
        summary: extractUserText(row.message) || 'User message',
        message: row.message,
      });
      continue;
    }

    if (isSDKToolProgressMessage(row.message)) {
      const progressSummary = oneLine(
        `${row.message.tool_name} · ${Math.max(0, Math.round(row.message.elapsed_time_seconds))}s`
      );
      events.push({
        id: `${String(row.id)}-progress`,
        label: row.label,
        role: row.role,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        sessionId: row.sessionId,
        createdAt: row.createdAt,
        kind: 'progress',
        title: 'Progress',
        summary: progressSummary,
        message: row.message,
        iconToolName: row.message.tool_name,
      });
      continue;
    }

    if (isSDKResultMessage(row.message)) {
      const usage = (row.message as unknown as { usage?: Record<string, number | undefined> })
        .usage;
      const tokenSummary = usage
        ? `${usage.input_tokens ?? 0}→${usage.output_tokens ?? 0} tokens`
        : '— tokens';
      events.push({
        id: `${String(row.id)}-result`,
        label: row.label,
        role: row.role,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        sessionId: row.sessionId,
        createdAt: row.createdAt,
        kind: 'result',
        title: row.message.subtype === 'success' ? 'Completed' : 'Error',
        summary: tokenSummary,
        message: row.message,
        resultSubtype: row.message.subtype,
        isError: row.message.subtype !== 'success',
      });
      continue;
    }

    if (isSDKRateLimitEvent(row.message)) {
      const rateLimitInfo = row.message.rate_limit_info;
      const isRejected = rateLimitInfo.status === 'rejected';
      const rateLimitType = rateLimitInfo.rateLimitType
        ? rateLimitInfo.rateLimitType.replace(/_/g, ' ')
        : 'rate limit';
      events.push({
        id: `${String(row.id)}-rate-limit`,
        label: row.label,
        role: row.role,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        sessionId: row.sessionId,
        createdAt: row.createdAt,
        kind: 'rate_limit',
        title: 'Rate Limit',
        summary: `${rateLimitType} · ${rateLimitInfo.status}`,
        message: row.message,
        isError: isRejected,
      });
      continue;
    }

    if (isSDKSystemMessage(row.message)) {
      if (isSDKCompactBoundary(row.message)) {
        const metadata = row.message.compact_metadata;
        const tokenSummary = `${metadata.pre_tokens} → ${metadata.post_tokens ?? '—'} tokens`;
        events.push({
          id: `${String(row.id)}-compact-boundary`,
          label: row.label,
          role: row.role,
          taskId: row.taskId,
          taskTitle: row.taskTitle,
          sessionId: row.sessionId,
          createdAt: row.createdAt,
          kind: 'compact_boundary',
          title: 'Compact Boundary',
          summary: `${metadata.trigger} · ${tokenSummary}`,
          message: row.message,
          systemSubtype: row.message.subtype,
        });
        continue;
      }

      const subtype = row.message.subtype ?? 'system';
      let summary = subtype.replace(/_/g, ' ');

      if (subtype === 'task_progress' && 'description' in row.message) {
        summary = oneLine(String(row.message.description ?? 'task progress'));
      } else if (subtype === 'task_notification' && 'summary' in row.message) {
        summary = oneLine(String(row.message.summary ?? 'task notification'));
      } else if (subtype === 'status' && 'status' in row.message) {
        summary = oneLine(String(row.message.status ?? 'status updated'));
      }

      events.push({
        id: `${String(row.id)}-system`,
        label: row.label,
        role: row.role,
        taskId: row.taskId,
        taskTitle: row.taskTitle,
        sessionId: row.sessionId,
        createdAt: row.createdAt,
        kind: 'system',
        title: 'System',
        summary,
        message: row.message,
        systemSubtype: subtype,
      });
      continue;
    }

    events.push({
      id: `${String(row.id)}-unknown`,
      label: row.label,
      role: row.role,
      nodeExecutionId: row.nodeExecutionId ?? null,
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      sessionId: row.sessionId,
      createdAt: row.createdAt,
      kind: 'unknown',
      title: String(row.message.type),
      summary: oneLine(JSON.stringify(row.message)),
      message: row.message,
    });
  }

  return events;
}

export interface FileOperation {
  path: string;
  tool: 'Write' | 'Edit' | 'MultiEdit';
  content?: string;
  oldString?: string;
  newString?: string;
}

export function extractFileOperations(parsedRows: ParsedThreadRow[]): FileOperation[] {
  const opsByFile = new Map<string, FileOperation>();

  for (const row of parsedRows) {
    const msg = row.message;
    if (!msg || !isSDKAssistantMessage(msg)) continue;
    const content = Array.isArray(msg.message?.content)
      ? (msg.message.content as ContentBlock[])
      : [];

    for (const block of content) {
      if (!isToolUseBlock(block)) continue;
      const input =
        typeof block.input === 'object' && block.input !== null
          ? (block.input as Record<string, unknown>)
          : {};

      if (block.name === 'Write') {
        const path = typeof input.file_path === 'string' ? input.file_path : null;
        const fileContent = typeof input.content === 'string' ? input.content : null;
        if (path && fileContent !== null) {
          opsByFile.set(path, { path, tool: 'Write', content: fileContent });
        }
      } else if (block.name === 'Edit') {
        const path = typeof input.file_path === 'string' ? input.file_path : null;
        const oldString = typeof input.old_string === 'string' ? input.old_string : null;
        const newString = typeof input.new_string === 'string' ? input.new_string : null;
        if (path && oldString !== null && newString !== null) {
          opsByFile.set(path, { path, tool: 'Edit', oldString, newString });
        }
      } else if (block.name === 'MultiEdit') {
        const path = typeof input.file_path === 'string' ? input.file_path : null;
        const edits = Array.isArray(input.edits) ? input.edits : [];
        const firstEdit = edits.find(
          (edit): edit is Record<string, unknown> => typeof edit === 'object' && edit !== null
        );
        const oldString = typeof firstEdit?.old_string === 'string' ? firstEdit.old_string : null;
        const newString = typeof firstEdit?.new_string === 'string' ? firstEdit.new_string : null;
        if (path && oldString !== null && newString !== null) {
          opsByFile.set(path, { path, tool: 'MultiEdit', oldString, newString });
        }
      }
    }
  }

  return Array.from(opsByFile.values());
}

export function buildSyntheticDiff(op: FileOperation): {
  diff: string;
  additions: number;
  deletions: number;
} {
  if (op.tool === 'Write') {
    const lines = (op.content ?? '').split('\n');
    const hunks = lines.map((l) => `+${l}`).join('\n');
    const diff = [
      `diff --git a/${op.path} b/${op.path}`,
      '--- /dev/null',
      `+++ b/${op.path}`,
      `@@ -0,0 +1,${lines.length} @@`,
      hunks,
    ].join('\n');
    return { diff, additions: lines.length, deletions: 0 };
  }

  const oldLines = (op.oldString ?? '').split('\n');
  const newLines = (op.newString ?? '').split('\n');
  const diff = [
    `diff --git a/${op.path} b/${op.path}`,
    `--- a/${op.path}`,
    `+++ b/${op.path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((l) => `-${l}`),
    ...newLines.map((l) => `+${l}`),
  ].join('\n');
  return { diff, additions: newLines.length, deletions: oldLines.length };
}
