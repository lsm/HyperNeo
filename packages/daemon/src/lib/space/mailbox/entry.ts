import { isValidAddress, type MailboxAddress } from './address.ts';
import { createUlid, isUlid } from './ulid.ts';

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

const MESSAGE_KEYS = ['type', 'message', 'parent_tool_use_id', 'priority'];
const BLOCK_KEYS = ['type', 'text'];
const POLICY_KEYS = ['ttlMs', 'maxAttempts', 'priority'];
const ENTRY_KEYS = ['id', 'to', 'origin', 'message', 'status', 'policy'];
const PRIORITY_LEVELS = new Set<string>(['now', 'next', 'later']);

function isPriorityLevel(value: unknown): boolean {
  return typeof value === 'string' && PRIORITY_LEVELS.has(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  return Object.getOwnPropertyNames(value).length === Object.keys(value).length;
}

function firstUnexpectedKey(record: Record<string, unknown>, allowed: string[]): string | null {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) return key;
  }
  return null;
}

function hasUndefinedOwnValue(record: Record<string, unknown>): boolean {
  for (const key of Object.keys(record)) {
    if (record[key] === undefined) return true;
  }
  return false;
}

function validateTextBlock(block: unknown): string | null {
  if (!isPlainObject(block)) return 'content block must be an object';
  const blockKey = firstUnexpectedKey(block, BLOCK_KEYS);
  if (blockKey !== null) return `content block must not carry key "${blockKey}"`;
  if (Object.keys(block).length !== BLOCK_KEYS.length) {
    return 'content block must carry type and text as enumerable own fields';
  }
  if (block.type !== 'text') return 'content block type must be "text"';
  if (typeof block.text !== 'string' || block.text.length === 0) {
    return 'content block text must be a non-empty string';
  }
  return null;
}

export function validateMailboxMessage(message: unknown): string | null {
  if (!isPlainObject(message)) return 'mailbox message must be an object';
  const keys = Object.keys(message);
  const messageKey = firstUnexpectedKey(message, MESSAGE_KEYS);
  if (messageKey !== null) return `mailbox message must not carry key "${messageKey}"`;
  if (message.type !== 'user') return 'mailbox message type must be "user"';
  if (!isPlainObject(message.message)) return 'mailbox message.message must be an object';
  const contentKey = firstUnexpectedKey(message.message, ['content']);
  if (contentKey !== null) return `mailbox message.message must not carry key "${contentKey}"`;
  if (Object.keys(message.message).length !== 1) {
    return 'mailbox message.message must carry content as an enumerable own field';
  }
  const content = message.message.content;
  if (typeof content === 'string') {
    if (content.length === 0) return 'mailbox message content must not be empty';
  } else if (Array.isArray(content)) {
    if (content.length === 0) return 'mailbox message content must not be empty';
    for (const block of content) {
      const blockViolation = validateTextBlock(block);
      if (blockViolation !== null) return blockViolation;
    }
  } else {
    return 'mailbox message content must be a string or an array of text blocks';
  }
  if (message.parent_tool_use_id !== null) {
    return 'mailbox message parent_tool_use_id must be null';
  }
  if (keys.includes('priority') && !isPriorityLevel(message.priority)) {
    return 'mailbox message priority must be one of "now", "next", "later"';
  }
  return null;
}

function validateEntryPolicy(policy: unknown): string | null {
  if (!isPlainObject(policy)) return 'mailbox entry policy must be an object';
  const policyKey = firstUnexpectedKey(policy, POLICY_KEYS);
  if (policyKey !== null) return `mailbox entry policy must not carry key "${policyKey}"`;
  for (const key of POLICY_KEYS) {
    const value = policy[key];
    if (value === undefined) return `mailbox entry policy ${key} is required`;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return `mailbox entry policy ${key} must be a finite integer`;
    }
    if (key === 'priority') {
      if (Object.is(value, -0)) {
        return 'mailbox entry policy priority must not be negative zero';
      }
      if (value < 0) return 'mailbox entry policy priority must be non-negative';
    } else if (value < 1) {
      return `mailbox entry policy ${key} must be positive`;
    }
  }
  return null;
}

export function createMailboxEntry(args: {
  to: MailboxAddress;
  message: MailboxMessage;
  origin: string;
  policy?: Partial<MailboxEntryPolicy>;
}): MailboxEntry {
  const messageViolation = validateMailboxMessage(args.message);
  if (messageViolation !== null) {
    throw new TypeError(`invalid mailbox message: ${messageViolation}`);
  }
  if (!isValidAddress(args.to)) {
    throw new TypeError('invalid mailbox entry address');
  }
  if (!isPlainObject(args.to)) {
    throw new TypeError('mailbox entry address must be a plain object');
  }
  if (hasUndefinedOwnValue(args.to)) {
    throw new TypeError('mailbox entry address must not carry undefined fields');
  }
  if (typeof args.origin !== 'string' || args.origin.length === 0) {
    throw new TypeError('mailbox entry origin must be a non-empty string');
  }
  if (args.policy !== undefined && !isPlainObject(args.policy)) {
    throw new TypeError('mailbox entry policy override must be an object');
  }
  const policy: MailboxEntryPolicy = {
    ...DEFAULT_MAILBOX_ENTRY_POLICY,
    ...args.policy,
  };
  const policyViolation = validateEntryPolicy(policy);
  if (policyViolation !== null) {
    throw new TypeError(`invalid mailbox entry policy: ${policyViolation}`);
  }
  return {
    id: createUlid(),
    to: args.to,
    origin: args.origin,
    message: args.message,
    status: 'enqueued',
    policy,
  };
}

export function isValidMailboxEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  if (Object.keys(entry).length !== ENTRY_KEYS.length) return false;
  if (firstUnexpectedKey(entry, ENTRY_KEYS) !== null) return false;
  if (typeof entry.id !== 'string' || !isUlid(entry.id)) return false;
  if (!isPlainObject(entry.to) || !isValidAddress(entry.to as MailboxAddress)) return false;
  if (hasUndefinedOwnValue(entry.to)) return false;
  if (typeof entry.origin !== 'string' || entry.origin.length === 0) return false;
  if (validateMailboxMessage(entry.message) !== null) return false;
  if (entry.status !== 'enqueued') return false;
  if (validateEntryPolicy(entry.policy) !== null) return false;
  return true;
}
