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

const MESSAGE_KEYS = new Set(['type', 'message', 'parent_tool_use_id', 'priority']);
const PRIORITIES = new Set(['now', 'next', 'later']);
const BODY_KEYS = new Set(['content']);
const TEXT_BLOCK_KEYS = new Set(['type', 'text']);
const ENTRY_KEYS = new Set(['id', 'to', 'origin', 'message', 'status', 'policy']);
const POLICY_KEYS = new Set(['ttlMs', 'maxAttempts', 'priority']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: Set<string>): boolean {
  const entries = Object.keys(record);
  return entries.length === keys.size && entries.every((key) => keys.has(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isPriorityValue(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function validateTextBlock(block: unknown): string | null {
  if (!isPlainObject(block)) return 'content blocks must be plain objects';
  if (!hasExactKeys(block, TEXT_BLOCK_KEYS)) {
    return 'content blocks must have exactly "type" and "text"';
  }
  if (block.type !== 'text') return 'content only supports text blocks';
  if (!isNonEmptyString(block.text)) return 'content text blocks need a non-empty text';
  return null;
}

function validateContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.length > 0 ? null : 'content must be a non-empty string';
  }
  if (!Array.isArray(content)) {
    return 'content must be a non-empty string or an array of text blocks';
  }
  if (content.length === 0) return 'content array must not be empty';
  for (const block of content) {
    const violation = validateTextBlock(block);
    if (violation !== null) return violation;
  }
  return null;
}

export function validateMailboxMessage(message: unknown): string | null {
  if (!isPlainObject(message)) return 'message must be a plain object';
  const record = message;
  for (const key of Object.keys(record)) {
    if (!MESSAGE_KEYS.has(key)) return `unexpected message key: ${key}`;
  }
  if (record.type !== 'user') return 'type must be exactly "user"';
  if (!isPlainObject(record.message)) return 'message must be an object with a content field';
  if (!hasExactKeys(record.message, BODY_KEYS)) {
    return 'message must carry only a content field';
  }
  const contentViolation = validateContent(record.message.content);
  if (contentViolation !== null) return `message.content: ${contentViolation}`;
  if (record.parent_tool_use_id !== null) return 'parent_tool_use_id must be null';
  if (record.priority !== undefined && !PRIORITIES.has(record.priority as string)) {
    return 'priority must be one of "now", "next", "later"';
  }
  return null;
}

function resolvePolicy(overrides?: Partial<MailboxEntryPolicy>): MailboxEntryPolicy {
  const merged = { ...DEFAULT_MAILBOX_ENTRY_POLICY, ...overrides };
  if (!hasExactKeys(merged, POLICY_KEYS)) {
    const unknownKey = Object.keys(merged).find((key) => !POLICY_KEYS.has(key));
    throw new TypeError(`invalid mailbox policy: unknown key "${unknownKey}"`);
  }
  if (!isPositiveInteger(merged.ttlMs)) {
    throw new TypeError('invalid mailbox policy: ttlMs must be a positive integer');
  }
  if (!isPositiveInteger(merged.maxAttempts)) {
    throw new TypeError('invalid mailbox policy: maxAttempts must be a positive integer');
  }
  if (!isPriorityValue(merged.priority)) {
    throw new TypeError('invalid mailbox policy: priority must be an integer >= 0');
  }
  return merged;
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
    throw new TypeError('invalid mailbox entry: "to" is not a valid mailbox address');
  }
  if (!isNonEmptyString(args.origin)) {
    throw new TypeError('invalid mailbox entry: origin must be a non-empty string');
  }
  return {
    id: createUlid(),
    to: args.to,
    origin: args.origin,
    message: args.message,
    status: 'enqueued',
    policy: resolvePolicy(args.policy),
  };
}

function isValidPolicy(policy: unknown): boolean {
  if (!isPlainObject(policy) || !hasExactKeys(policy, POLICY_KEYS)) return false;
  if (!isPositiveInteger(policy.ttlMs) || !isPositiveInteger(policy.maxAttempts)) return false;
  return isPriorityValue(policy.priority);
}

export function isValidMailboxEntry(entry: unknown): boolean {
  if (!isPlainObject(entry) || !hasExactKeys(entry, ENTRY_KEYS)) return false;
  if (!isUlid(entry.id as string)) return false;
  if (!isValidAddress(entry.to as MailboxAddress)) return false;
  if (!isNonEmptyString(entry.origin)) return false;
  if (validateMailboxMessage(entry.message) !== null) return false;
  if (entry.status !== 'enqueued') return false;
  return isValidPolicy(entry.policy);
}
