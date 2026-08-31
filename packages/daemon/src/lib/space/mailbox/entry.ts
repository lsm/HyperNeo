import type { MailboxAddress } from './address.ts';

export interface MailboxEntryPolicy {
  ttlMs: number;
  maxAttempts: number;
  priority: number;
}

export const DEFAULT_MAILBOX_ENTRY_POLICY: MailboxEntryPolicy = {
  ttlMs: 24 * 60 * 60 * 1000,
  maxAttempts: 5,
  priority: 0,
};

export type MailboxMessage = {
  type: 'user';
  message: { content: string | { type: 'text'; text: string }[] };
  parent_tool_use_id: null;
  priority?: 'now' | 'next' | 'later';
};

export type MailboxEntry = {
  id: string;
  to: MailboxAddress;
  origin: string;
  message: MailboxMessage;
  status: 'enqueued';
  policy: MailboxEntryPolicy;
};

const MAILBOX_MESSAGE_PRIORITIES: readonly MailboxMessage['priority'][] = ['now', 'next', 'later'];
const MAILBOX_MESSAGE_KEYS = new Set(['type', 'message', 'parent_tool_use_id', 'priority']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyTextBlock(block: unknown): boolean {
  if (!isPlainObject(block)) return false;
  return block.type === 'text' && typeof block.text === 'string' && block.text.length > 0;
}

function hasDeliverableContent(container: unknown): boolean {
  if (!isPlainObject(container)) return false;
  const content = container.content;
  if (typeof content === 'string') return content.length > 0;
  return Array.isArray(content) && content.length > 0 && content.every(isNonEmptyTextBlock);
}

export function validateMailboxMessage(message: unknown): string | null {
  if (!isPlainObject(message)) return 'message must be a plain object';
  if (message.type !== 'user') return 'message.type must be "user"';
  if (!hasDeliverableContent(message.message)) {
    return 'message.content must be a non-empty string or a non-empty array of text blocks';
  }
  if (message.parent_tool_use_id !== null) return 'message.parent_tool_use_id must be null';
  if (
    message.priority !== undefined &&
    !MAILBOX_MESSAGE_PRIORITIES.includes(message.priority as MailboxMessage['priority'])
  ) {
    return 'message.priority must be one of "now", "next", "later"';
  }
  const excess = Object.keys(message).find((key) => !MAILBOX_MESSAGE_KEYS.has(key));
  if (excess !== undefined) return `message has unexpected key "${excess}"`;
  return null;
}
