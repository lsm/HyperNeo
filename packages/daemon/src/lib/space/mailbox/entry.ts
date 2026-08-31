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

export type MailboxMessageContent = string | { type: 'text'; text: string }[];

export type MailboxMessage = {
  type: 'user';
  message: { content: MailboxMessageContent };
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

function isNonEmptyTextBlock(block: { type: 'text'; text: string }): boolean {
  return block.type === 'text' && typeof block.text === 'string' && block.text.length > 0;
}

function hasDeliverableContent(container: MailboxMessageContent): boolean {
  if (typeof container === 'string') return container.length > 0;
  if (!Array.isArray(container)) return false;
  for (let index = 0; index < container.length; index += 1) {
    const block: { type: 'text'; text: string } | null | undefined = container[index];
    if (block === null || block === undefined || !isNonEmptyTextBlock(block)) return false;
  }
  return container.length > 0;
}

export function validateMailboxMessage(message: MailboxMessage): string | null {
  if (typeof message !== 'object' || message === null) return 'message must be an object';
  if (message.type !== 'user') return 'message.type must be "user"';
  const content: MailboxMessageContent | null | undefined = message.message?.content;
  if (content === null || content === undefined || !hasDeliverableContent(content)) {
    return 'message.content must be a non-empty string or a non-empty array of text blocks';
  }
  if (message.parent_tool_use_id !== null) return 'message.parent_tool_use_id must be null';
  if (message.priority !== undefined && !MAILBOX_MESSAGE_PRIORITIES.includes(message.priority)) {
    return 'message.priority must be one of "now", "next", "later"';
  }
  const excess = Object.keys(message).find((key) => !MAILBOX_MESSAGE_KEYS.has(key));
  if (excess !== undefined) return `message has unexpected key "${excess}"`;
  return null;
}
