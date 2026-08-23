import { sendStatusToDeliveryStatus } from '@hyperneo/shared';
import type { ChatMessage, MessageDeliveryStatus, MessageOrigin } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';

export type MalformedSdkRowPolicy = 'synthesize' | 'skip' | 'throw' | 'null';

export function parseSdkMessageRow(raw: string, policy: 'throw' | 'synthesize'): SDKMessage;
export function parseSdkMessageRow(raw: string, policy: 'skip' | 'null'): SDKMessage | null;
export function parseSdkMessageRow(raw: string, policy: MalformedSdkRowPolicy): SDKMessage | null;
export function parseSdkMessageRow(raw: string, policy: MalformedSdkRowPolicy): SDKMessage | null {
  if (policy === 'throw') return JSON.parse(raw) as SDKMessage;
  try {
    return JSON.parse(raw) as SDKMessage;
  } catch {
    if (policy === 'synthesize') {
      return { type: 'unknown', rawContent: raw } as unknown as SDKMessage;
    }
    return null;
  }
}

export interface PaginationMessageRow {
  id: string;
  sdk_message: string;
  timestamp: string;
  rowid: unknown;
  origin: unknown;
  send_status: unknown;
}

export function projectTopLevelMessageRow(
  row: PaginationMessageRow
): SDKMessage & { timestamp: number } {
  const sdkMessage = parseSdkMessageRow(row.sdk_message, 'synthesize');
  const timestamp = new Date(row.timestamp).getTime();
  const extra: Record<string, unknown> = {
    id: row.id,
    timestamp,
    rowid: typeof row.rowid === 'number' ? row.rowid : Number(row.rowid ?? 0),
    origin: row.origin != null ? (row.origin as MessageOrigin) : undefined,
  };
  if (sdkMessage.type === 'user') {
    const deliveryStatus = sendStatusToDeliveryStatus(row.send_status as string | null | undefined);
    if (deliveryStatus) extra.deliveryStatus = deliveryStatus;
  }
  return { ...sdkMessage, ...extra } as SDKMessage & { timestamp: number };
}

export interface SubagentMessageRow {
  id: string;
  sdk_message: string;
  timestamp: string;
}

export function projectSubagentMessageRow(
  row: SubagentMessageRow
): SDKMessage & { timestamp: number } {
  const sdkMessage = parseSdkMessageRow(row.sdk_message, 'synthesize');
  return {
    ...sdkMessage,
    id: row.id,
    timestamp: new Date(row.timestamp).getTime(),
    origin: undefined,
  } as unknown as SDKMessage & { timestamp: number };
}

export interface BackgroundTaskMessageRow {
  id: string;
  sdk_message: string;
  timestamp: string;
  origin: MessageOrigin | null;
}

export function projectBackgroundTaskMessageRow(
  row: BackgroundTaskMessageRow
): ChatMessage & { timestamp: number } {
  const sdkMessage = parseSdkMessageRow(row.sdk_message, 'synthesize');
  return {
    ...sdkMessage,
    id: row.id,
    timestamp: new Date(row.timestamp).getTime(),
    origin: row.origin ?? undefined,
  } as unknown as ChatMessage & { timestamp: number };
}

export function inflatePersistedMessage(row: {
  id: string;
  sdk_message: string;
  timestamp: string;
}): SDKMessage & { dbId: string; timestamp: number } {
  const message = parseSdkMessageRow(row.sdk_message, 'synthesize');
  return {
    ...message,
    dbId: row.id,
    timestamp: new Date(row.timestamp).getTime(),
  } as SDKMessage & { dbId: string; timestamp: number };
}

export function collectToolUseIds(messages: Array<SDKMessage & { timestamp: number }>): string[] {
  const toolUseIds = new Set<string>();
  for (const msg of messages) {
    if (msg.type === 'assistant' && msg.message && Array.isArray(msg.message.content)) {
      for (const block of msg.message.content) {
        const blockObj = block as Record<string, unknown>;
        if (blockObj.type === 'tool_use' && blockObj.id) {
          toolUseIds.add(blockObj.id as string);
        }
      }
    }
  }
  return Array.from(toolUseIds);
}

interface ComposedMessagePage {
  messages: Array<
    SDKMessage & {
      timestamp: number;
      origin?: MessageOrigin;
      deliveryStatus?: MessageDeliveryStatus;
    }
  >;
  hasMore: boolean;
}

export function composeMessagePage(
  topLevelRows: PaginationMessageRow[],
  limit: number,
  fetchSubagentRows: (toolUseIds: string[]) => SubagentMessageRow[]
): ComposedMessagePage {
  const projected: Array<SDKMessage & { timestamp: number }> = [];
  for (const row of topLevelRows) {
    projected.push(projectTopLevelMessageRow(row));
    if (projected.length >= limit) break;
  }

  const topLevelMessages = projected.reverse();
  const hasMore = topLevelMessages.length === limit;
  const toolUseIds = collectToolUseIds(topLevelMessages);
  const subagentRows = toolUseIds.length > 0 ? fetchSubagentRows(toolUseIds) : [];
  const subagentMessages = subagentRows.map((row) => projectSubagentMessageRow(row));

  return {
    messages: [...topLevelMessages, ...subagentMessages] as ComposedMessagePage['messages'],
    hasMore,
  };
}

export type TextBlockExtractionPolicy = 'first-block-only' | 'join-all';

export function extractTextBlockContents(
  msg: Record<string, unknown>,
  policy: TextBlockExtractionPolicy
): string[] {
  const message = msg.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
      if (policy === 'first-block-only') break;
    }
  }
  return texts;
}

export function extractVisibleText(msg: Record<string, unknown>): string {
  const parts = extractTextBlockContents(msg, 'join-all');
  if (msg.type === 'result' && typeof msg.result === 'string') {
    parts.push(msg.result);
  }
  return parts.join('\n\n').trim();
}

export function extractToolCallNames(msg: Record<string, unknown>): string[] {
  const names: string[] = [];
  const message = msg.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'tool_use' && typeof block.name === 'string') {
        names.push(block.name);
      }
    }
  }
  return names;
}

export function extractFirstTextBlockContent(message: SDKMessage): string {
  return (
    extractTextBlockContents(
      message as unknown as Record<string, unknown>,
      'first-block-only'
    )[0] ?? ''
  );
}

export interface RenderableTextMessageRow {
  id: string;
  message_type: string;
  sdk_message: string;
  timestamp: string;
}

export interface RenderableTextMessage {
  id: string;
  type: string;
  text: string;
  timestamp: number;
}

export function projectRenderableTextRow(
  row: RenderableTextMessageRow
): RenderableTextMessage | null {
  const message = parseSdkMessageRow(row.sdk_message, 'skip');
  if (!message) return null;
  const text = extractVisibleText(message as unknown as Record<string, unknown>);
  if (text.length === 0) return null;
  return {
    id: row.id,
    type: row.message_type,
    text,
    timestamp: new Date(row.timestamp).getTime(),
  };
}

export const RENDERABLE_TEXT_MESSAGE_BATCH_SIZE = 50;

const RENDERABLE_TEXT_MESSAGE_MAX_SCAN = 250;

export function resolveRenderableTextScanBudget(limit: number): number {
  return Math.max(limit, RENDERABLE_TEXT_MESSAGE_MAX_SCAN);
}

const STATUS_MESSAGE_HYDRATION_BATCH_SIZE = 900;

interface RowIdHydrationBatch {
  rowIds: number[];
  placeholders: string;
}

export function buildRowIdHydrationBatches(
  projected: Array<{ row_id: number }>
): RowIdHydrationBatch[] {
  const batches: RowIdHydrationBatch[] = [];
  for (let offset = 0; offset < projected.length; offset += STATUS_MESSAGE_HYDRATION_BATCH_SIZE) {
    const rowIds = projected
      .slice(offset, offset + STATUS_MESSAGE_HYDRATION_BATCH_SIZE)
      .map((row) => row.row_id);
    batches.push({ rowIds, placeholders: rowIds.map(() => '?').join(', ') });
  }
  return batches;
}

export function orderHydratedMessages<M>(
  projected: Array<{ row_id: number }>,
  hydratedByRowId: Map<number, M>
): M[] {
  return projected.flatMap((row) => {
    const message = hydratedByRowId.get(row.row_id);
    return message ? [message] : [];
  });
}
