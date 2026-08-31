import { isValidAddress, type MailboxAddress } from './address.ts';
import { createUlid, isUlid } from './ulid.ts';

export interface MailboxEntryPolicy {
  ttlMs: number;
  maxAttempts: number;
  priority: number;
}

export const DEFAULT_MAILBOX_ENTRY_POLICY: Readonly<MailboxEntryPolicy> = Object.freeze({
  ttlMs: 24 * 60 * 60 * 1000,
  maxAttempts: 5,
  priority: 0,
});

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

const MAILBOX_ENTRY_KEYS = new Set(['id', 'to', 'origin', 'message', 'status', 'policy']);
const MAILBOX_MESSAGE_KEYS = new Set(['type', 'message', 'parent_tool_use_id', 'priority']);
const MAILBOX_CONTENT_KEYS = new Set(['content']);
const MAILBOX_TEXT_BLOCK_KEYS = new Set(['type', 'text']);
const POLICY_KEYS = new Set(['ttlMs', 'maxAttempts', 'priority']);
const PRIORITIES = new Set(['now', 'next', 'later']);

type PolicyKey = 'ttlMs' | 'maxAttempts' | 'priority';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidPositiveInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}

function isValidNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function isPolicyKey(value: string): value is PolicyKey {
  return POLICY_KEYS.has(value);
}

function isValidPolicyValue(key: PolicyKey, value: unknown): boolean {
  if (key === 'ttlMs' || key === 'maxAttempts') return isValidPositiveInteger(value);
  return isValidNonNegativeInteger(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: Set<string>): boolean {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) return false;
  }
  return true;
}

export function validateMailboxMessage(message: unknown): string | null {
  if (!isPlainObject(message)) return 'message is not an object';

  const record = message as Record<string, unknown>;
  if (!hasOnlyKeys(record, MAILBOX_MESSAGE_KEYS)) return 'message contains an unexpected key';
  if (record.type !== 'user') return 'message.type must be "user"';

  const contentContainer = record.message;
  if (!isPlainObject(contentContainer)) return 'message.message is not an object';

  const contentRecord = contentContainer as Record<string, unknown>;
  if (!hasOnlyKeys(contentRecord, MAILBOX_CONTENT_KEYS)) {
    return 'message.message contains an unexpected key';
  }

  const content = contentRecord.content;
  if (typeof content === 'string') {
    if (content.length === 0) return 'message.content must not be empty';
  } else if (Array.isArray(content)) {
    if (content.length === 0) return 'message.content must not be empty';
    for (let index = 0; index < content.length; index += 1) {
      const block = content[index];
      if (!isPlainObject(block)) return 'message.content contains an invalid block';
      const blockRecord = block as Record<string, unknown>;
      if (!hasOnlyKeys(blockRecord, MAILBOX_TEXT_BLOCK_KEYS)) {
        return 'message.content block contains an unexpected key';
      }
      if (blockRecord.type !== 'text') return 'message.content block type must be "text"';
      if (!isNonEmptyString(blockRecord.text)) {
        return 'message.content block text must be a non-empty string';
      }
    }
  } else {
    return 'message.content must be a non-empty string or an array of text blocks';
  }

  if (record.parent_tool_use_id !== null) return 'message.parent_tool_use_id must be null';

  if (record.priority !== undefined && !PRIORITIES.has(record.priority as string)) {
    return 'message.priority must be "now", "next", or "later"';
  }

  return null;
}

function isValidPolicy(policy: unknown): boolean {
  if (!isPlainObject(policy)) return false;
  const record = policy as Record<string, unknown>;
  if (!hasOnlyKeys(record, POLICY_KEYS)) return false;
  for (const key of POLICY_KEYS) {
    if (!isPolicyKey(key) || !isValidPolicyValue(key, record[key])) return false;
  }
  return true;
}

function validatePolicyOverride(policy: Partial<MailboxEntryPolicy>): void {
  for (const raw of Object.keys(policy)) {
    const key = raw as keyof MailboxEntryPolicy;
    if (!isPolicyKey(key)) throw new TypeError(`unknown policy field: ${key}`);
    if (!isValidPolicyValue(key, policy[key]))
      throw new TypeError(`invalid policy value for ${key}`);
  }
}

export function createMailboxEntry(args: {
  to: MailboxAddress;
  message: MailboxMessage;
  origin: string;
  policy?: Partial<MailboxEntryPolicy>;
}): MailboxEntry {
  const messageError = validateMailboxMessage(args.message);
  if (messageError !== null) throw new TypeError(messageError);
  if (!isValidAddress(args.to)) throw new TypeError('to is not a valid mailbox address');
  if (!isNonEmptyString(args.origin)) throw new TypeError('origin must be a non-empty string');

  if (args.policy !== undefined && !isPlainObject(args.policy)) {
    throw new TypeError('policy must be an object');
  }
  const override = args.policy ?? {};
  validatePolicyOverride(override);
  const mergedPolicy: MailboxEntryPolicy = { ...DEFAULT_MAILBOX_ENTRY_POLICY, ...override };

  return {
    id: createUlid(),
    to: args.to,
    origin: args.origin,
    message: args.message,
    status: 'enqueued',
    policy: mergedPolicy,
  };
}

export function isValidMailboxEntry(entry: unknown): boolean {
  if (!isPlainObject(entry)) return false;
  const record = entry as Record<string, unknown>;
  if (!hasOnlyKeys(record, MAILBOX_ENTRY_KEYS)) return false;
  if (!isUlid(record.id as string)) return false;
  if (!isValidAddress(record.to as MailboxAddress)) return false;
  if (!isNonEmptyString(record.origin)) return false;
  if (validateMailboxMessage(record.message) !== null) return false;
  if (record.status !== 'enqueued') return false;
  if (!isValidPolicy(record.policy)) return false;
  return true;
}
