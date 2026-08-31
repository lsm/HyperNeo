import type { MailboxAddress } from './address.ts';
import { createUlid } from './ulid.ts';

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

export type MailboxProjection<T> = { value: T } | { reason: string };

export function toMailboxPolicy(
  partial: Partial<MailboxEntryPolicy> | undefined
): MailboxProjection<MailboxEntryPolicy> {
  const source = partial ?? {};
  const ttlMs = source.ttlMs === undefined ? DEFAULT_MAILBOX_ENTRY_POLICY.ttlMs : source.ttlMs;
  const maxAttempts =
    source.maxAttempts === undefined
      ? DEFAULT_MAILBOX_ENTRY_POLICY.maxAttempts
      : source.maxAttempts;
  const priority =
    source.priority === undefined ? DEFAULT_MAILBOX_ENTRY_POLICY.priority : source.priority;

  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    return { reason: 'policy.ttlMs must be a positive integer' };
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    return { reason: 'policy.maxAttempts must be a positive integer' };
  }
  if (!Number.isSafeInteger(priority) || priority < 0) {
    return { reason: 'policy.priority must be a non-negative integer' };
  }

  return { value: { ttlMs, maxAttempts, priority } };
}

function toMailboxAddress(to: MailboxAddress): MailboxProjection<MailboxAddress> {
  if (to?.kind === 'session') {
    return typeof to.sessionId === 'string' && to.sessionId.length > 0
      ? { value: { kind: 'session', sessionId: to.sessionId } }
      : { reason: 'to.sessionId must be a non-empty string' };
  }
  if (to?.kind === 'agent') {
    if (typeof to.spaceId !== 'string' || to.spaceId.length === 0) {
      return { reason: 'to.spaceId must be a non-empty string' };
    }
    if (typeof to.handle !== 'string' || to.handle.length === 0 || to.handle.includes('/')) {
      return { reason: 'to.handle must be a non-empty string without "/"' };
    }
    if (to.taskId !== undefined && (typeof to.taskId !== 'string' || to.taskId.length === 0)) {
      return { reason: 'to.taskId must be a non-empty string' };
    }
    if (to.node !== undefined && (typeof to.node !== 'string' || to.node.length === 0)) {
      return { reason: 'to.node must be a non-empty string' };
    }
    return {
      value: {
        kind: 'agent',
        spaceId: to.spaceId,
        handle: to.handle,
        ...(to.taskId !== undefined ? { taskId: to.taskId } : {}),
        ...(to.node !== undefined ? { node: to.node } : {}),
      },
    };
  }
  return { reason: 'to.kind must be "session" or "agent"' };
}

export function createMailboxEntry(args: {
  to: MailboxAddress;
  message: MailboxMessage;
  origin: string;
  policy?: Partial<MailboxEntryPolicy>;
}): MailboxEntry {
  const projectedTo = toMailboxAddress(args.to);
  if ('reason' in projectedTo) throw new TypeError(projectedTo.reason);
  const projectedMessage = toMailboxMessage(args.message);
  if ('reason' in projectedMessage) throw new TypeError(projectedMessage.reason);
  if (typeof args.origin !== 'string' || args.origin.length === 0) {
    throw new TypeError('origin must be a non-empty string');
  }
  const projectedPolicy = toMailboxPolicy(args.policy);
  if ('reason' in projectedPolicy) throw new TypeError(projectedPolicy.reason);
  return {
    id: createUlid(),
    to: projectedTo.value,
    origin: args.origin,
    message: projectedMessage.message,
    status: 'enqueued',
    policy: projectedPolicy.value,
  };
}

export function parseMailboxEntry(
  _raw: Record<string, unknown> | null | undefined
): MailboxEntry | null {
  throw new Error('mailbox: parseMailboxEntry not implemented');
}
