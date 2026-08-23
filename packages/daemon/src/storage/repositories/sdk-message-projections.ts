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
