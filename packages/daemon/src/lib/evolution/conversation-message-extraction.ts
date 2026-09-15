import type { TraceMessage, TraceMessageRole, TraceRow } from './conversation-analysis-types.ts';
import { asRecord } from './conversation-analysis-parsing.ts';

export function extractConversationMessages(rows: TraceRow[]): TraceMessage[] {
  return rows.flatMap((row) => {
    const parsed = parseJsonRecord(row.sdkMessage);
    if (!parsed) return [];
    const content = readContent(parsed);
    if (!Array.isArray(content)) return [];
    const timestamp = Date.parse(row.timestamp);
    const messages: TraceMessage[] = [];
    for (const blockValue of content) {
      const block = asRecord(blockValue);
      if (!block) continue;
      const text = readTextBlock(block);
      if (!text) continue;
      const role = classifyBlock(row, parsed, block);
      if (!role) continue;
      messages.push({
        role,
        text,
        timestamp,
        metadata: { sessionId: row.sessionId, messageId: row.id },
      });
    }
    return messages;
  });
}

function classifyBlock(
  row: TraceRow,
  message: Record<string, unknown>,
  block: Record<string, unknown>
): TraceMessageRole | null {
  if (block.type === 'thinking') return 'thinking';
  if (block.type !== 'text') return null;
  if (row.messageType === 'assistant') return 'assistant';
  if (row.messageType !== 'user') return null;
  if (message.isSynthetic === true || row.origin === 'system') return 'synthetic_user';
  return 'human';
}

function readTextBlock(block: Record<string, unknown>): string | null {
  const textValue = block.type === 'thinking' ? block.thinking : block.text;
  const text = typeof textValue === 'string' ? textValue.trim() : '';
  return text.length > 0 ? text : null;
}

function readContent(message: Record<string, unknown>): unknown {
  const nested = asRecord(message.message);
  return nested?.content;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}
