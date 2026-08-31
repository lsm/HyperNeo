import type { MailboxAddress } from './address.ts';
import { isUlid } from './ulid.ts';

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

export function createMailboxEntry(_args: {
  to: MailboxAddress;
  message: MailboxMessage;
  origin: string;
  policy?: Partial<MailboxEntryPolicy>;
}): MailboxEntry {
  throw new Error('mailbox: createMailboxEntry not implemented');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function projectStoredAddress(value: unknown): MailboxAddress | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === 'session') {
    const sessionId = record.sessionId;
    if (!isNonEmptyString(sessionId)) return null;
    return { kind: 'session', sessionId };
  }
  if (record.kind === 'agent') {
    const spaceId = record.spaceId;
    const handle = record.handle;
    const taskId = record.taskId;
    const node = record.node;
    if (!isNonEmptyString(spaceId)) return null;
    if (!isNonEmptyString(handle) || handle.includes('/')) return null;
    if (taskId !== undefined && !isNonEmptyString(taskId)) return null;
    if (node !== undefined && !isNonEmptyString(node)) return null;
    return {
      kind: 'agent',
      spaceId,
      handle,
      ...(taskId !== undefined ? { taskId } : {}),
      ...(node !== undefined ? { node } : {}),
    };
  }
  return null;
}

export function parseMailboxEntry(
  raw: Record<string, unknown> | null | undefined
): MailboxEntry | null {
  if (raw === null || raw === undefined) return null;
  const id = raw.id;
  if (typeof id !== 'string' || !isUlid(id)) return null;
  const to = projectStoredAddress(raw.to);
  if (to === null) return null;
  const origin = raw.origin;
  if (!isNonEmptyString(origin)) return null;
  const message = toMailboxMessage(raw.message as MailboxMessage);
  if ('reason' in message) return null;
  if (raw.status !== 'enqueued') return null;
  const policySource = raw.policy;
  if (typeof policySource !== 'object' || policySource === null || Array.isArray(policySource)) {
    return null;
  }
  const policy = toMailboxPolicy(policySource as Partial<MailboxEntryPolicy>);
  if ('reason' in policy) return null;
  return { id, to, origin, message: message.message, status: 'enqueued', policy: policy.value };
}
