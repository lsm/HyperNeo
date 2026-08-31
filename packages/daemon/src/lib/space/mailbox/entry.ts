import { isValidAddress, type MailboxAddress } from './address';
import { createUlid, isUlid } from './ulid';

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

const ENTRY_KEYS = ['id', 'to', 'origin', 'message', 'status', 'policy'];
const POLICY_KEYS = ['ttlMs', 'maxAttempts', 'priority'];
const MESSAGE_KEYS = ['type', 'message', 'parent_tool_use_id', 'priority'];
const TEXT_BLOCK_KEYS = ['type', 'text'];
const EXCESS_MESSAGE_KEYS = [
  'uuid',
  'session_id',
  'subagent_type',
  'task_description',
  'isSynthetic',
  'tool_use_result',
  'shouldQuery',
  'timestamp',
];
const PRIORITIES = ['now', 'next', 'later'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isWholeNumber(value: unknown, allowZero: boolean): boolean {
  return (
    typeof value === 'number' && Number.isInteger(value) && (allowZero ? value >= 0 : value > 0)
  );
}

function checkPolicyValue(field: string, value: number, allowZero: boolean): void {
  if (!isWholeNumber(value, allowZero)) {
    throw new TypeError(
      `policy ${field} must be ${allowZero ? 'a non-negative integer' : 'a positive integer'}`
    );
  }
}

function validateContent(content: unknown): string | null {
  if (typeof content === 'string') {
    return content.length === 0 ? 'message.content must be a non-empty string' : null;
  }
  if (!Array.isArray(content) || content.length === 0) {
    return 'message.content must be a non-empty string or array of text blocks';
  }
  for (const block of content) {
    if (!isPlainObject(block)) {
      return 'every message.content block must be a plain object';
    }
    const record = block as Record<string, unknown>;
    const keys = Object.keys(record);
    for (const key of keys) {
      if (!TEXT_BLOCK_KEYS.includes(key)) {
        return `message.content blocks may not carry "${key}"`;
      }
    }
    if (record.type !== 'text') return 'every message.content block must be a text block';
    if (typeof record.text !== 'string' || record.text.length === 0) {
      return 'every message.content block must carry a non-empty text string';
    }
  }
  return null;
}

export function validateMailboxMessage(message: unknown): string | null {
  if (!isPlainObject(message)) return 'message must be an object';
  const keys = Object.keys(message);
  for (const key of keys) {
    if (!MESSAGE_KEYS.includes(key)) {
      return `message carries unexpected key "${key}"`;
    }
    if (EXCESS_MESSAGE_KEYS.includes(key) && message[key] === undefined) {
      return `message must not carry "${key}"`;
    }
  }
  for (const key of ['type', 'message', 'parent_tool_use_id']) {
    if (!(key in message)) return `message is missing required key "${key}"`;
  }
  if (message.type !== 'user') return 'message type must be exactly "user"';
  const inner = message.message;
  if (!isPlainObject(inner)) {
    return 'message.message must be a plain object';
  }
  const innerRecord = inner as Record<string, unknown>;
  const innerKeys = Object.keys(innerRecord);
  for (const key of innerKeys) {
    if (key !== 'content') return `message.message may only carry "content"`;
  }
  const contentViolation = validateContent(innerRecord.content);
  if (contentViolation !== null) return contentViolation;
  if (message.parent_tool_use_id !== null) {
    return 'parent_tool_use_id must be null at ingestion';
  }
  if ('priority' in message && message.priority !== undefined) {
    if (!PRIORITIES.includes(message.priority as string)) {
      return 'priority must be one of "now", "next", "later"';
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
  if (messageViolation !== null) throw new TypeError(messageViolation);
  if (!isValidAddress(args.to)) throw new TypeError('to must be a valid mailbox address');
  if (typeof args.origin !== 'string' || args.origin.length === 0) {
    throw new TypeError('origin must be a non-empty string');
  }
  if (args.policy !== undefined) {
    for (const key of Object.keys(args.policy)) {
      if (!POLICY_KEYS.includes(key)) {
        throw new TypeError(`policy may not carry "${key}"`);
      }
    }
  }
  const policy: MailboxEntryPolicy = { ...DEFAULT_MAILBOX_ENTRY_POLICY, ...args.policy };
  checkPolicyValue('ttlMs', policy.ttlMs, false);
  checkPolicyValue('maxAttempts', policy.maxAttempts, false);
  checkPolicyValue('priority', policy.priority, true);
  return {
    id: createUlid(),
    to: args.to,
    origin: args.origin,
    message: args.message,
    status: 'enqueued',
    policy,
  };
}

function isValidEntryPolicy(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!POLICY_KEYS.includes(key)) return false;
  }
  return (
    isWholeNumber(record.ttlMs, false) &&
    isWholeNumber(record.maxAttempts, false) &&
    isWholeNumber(record.priority, true)
  );
}

export function isValidMailboxEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const keys = Object.keys(entry);
  if (keys.length !== ENTRY_KEYS.length) return false;
  for (const key of keys) {
    if (!ENTRY_KEYS.includes(key)) return false;
  }
  if (typeof entry.id !== 'string' || !isUlid(entry.id)) return false;
  if (!isValidAddress(entry.to as MailboxAddress)) return false;
  if (typeof entry.origin !== 'string' || entry.origin.length === 0) return false;
  if (validateMailboxMessage(entry.message) !== null) return false;
  if (entry.status !== 'enqueued') return false;
  return isValidEntryPolicy(entry.policy);
}
