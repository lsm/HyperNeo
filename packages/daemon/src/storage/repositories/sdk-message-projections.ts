import { sendStatusToDeliveryStatus } from '@hyperneo/shared';
import type { ChatMessage, MessageOrigin } from '@hyperneo/shared';
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

export function extractVisibleText(msg: Record<string, unknown>): string {
  const parts: string[] = [];
  const message = msg.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push(block.text);
      }
    }
  } else if (typeof content === 'string') {
    parts.push(content);
  }
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
  const content = (
    message as { message?: { content?: string | Array<{ type: string; text?: string }> } }
  ).message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textBlock = content.find(
      (block): block is { type: 'text'; text: string } => block.type === 'text'
    );
    return textBlock?.text || '';
  }
  return '';
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
