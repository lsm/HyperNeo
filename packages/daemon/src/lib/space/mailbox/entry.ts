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
const MAILBOX_CONTENT_REASON =
  'message.content must be a non-empty string or a non-empty array of text blocks';

function projectTextBlock(
  block: { type: 'text'; text: string } | null | undefined
): { type: 'text'; text: string } | null {
  if (block === null || block === undefined) return null;
  if (block.type !== 'text' || typeof block.text !== 'string' || block.text.length === 0) {
    return null;
  }
  return { type: 'text', text: block.text };
}

export type MailboxMessageProjection = { message: MailboxMessage } | { reason: string };

export function toMailboxMessage(message: MailboxMessage): MailboxMessageProjection {
  if (message?.type !== 'user') return { reason: 'message.type must be "user"' };
  if (message.parent_tool_use_id !== null) {
    return { reason: 'message.parent_tool_use_id must be null' };
  }
  if (message.priority !== undefined && !MAILBOX_MESSAGE_PRIORITIES.includes(message.priority)) {
    return { reason: 'message.priority must be one of "now", "next", "later"' };
  }
  const content = message.message?.content;
  let projected: { content: MailboxMessageContent } | null = null;
  if (typeof content === 'string') {
    projected = content.length > 0 ? { content } : null;
  } else if (Array.isArray(content)) {
    const blocks: { type: 'text'; text: string }[] = [];
    for (let index = 0; index < content.length; index += 1) {
      const block = projectTextBlock(content[index]);
      if (block === null) return { reason: MAILBOX_CONTENT_REASON };
      blocks.push(block);
    }
    projected = blocks.length > 0 ? { content: blocks } : null;
  }
  if (projected === null) return { reason: MAILBOX_CONTENT_REASON };
  return {
    message: {
      type: 'user',
      message: projected,
      parent_tool_use_id: null,
      ...(message.priority !== undefined ? { priority: message.priority } : {}),
    },
  };
}
