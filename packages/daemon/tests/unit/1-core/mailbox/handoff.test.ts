import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MailboxAddress } from '../../../../src/lib/mailbox/address';
import { MAILBOX_LANE } from '../../../../src/lib/mailbox/enqueue';
import {
  createMailboxEntry,
  DEFAULT_MAILBOX_ENTRY_POLICY,
  type MailboxEntry,
  type MailboxEntryPolicy,
  type MailboxMessage,
  parseMailboxEntry,
} from '../../../../src/lib/mailbox/entry';
import {
  crashHandler,
  createEntryStage,
  enqueueStage,
  handoffPromptToMailbox,
  parseAddressStage,
  projectMessageStage,
  rejected,
} from '../../../../src/lib/mailbox/handoff';
import { createUlid, isUlid } from '../../../../src/lib/mailbox/ulid';
import type { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

const textMessage: MailboxMessage = {
  type: 'user',
  message: { content: 'hello' },
  parent_tool_use_id: null,
};

const blocksMessage: MailboxMessage = {
  type: 'user',
  message: { content: [{ type: 'text', text: 'urgent' }] },
  parent_tool_use_id: null,
  priority: 'now',
};

const sessionAddress: MailboxAddress = { kind: 'session', sessionId: 'sess-1' };

const agentAddress: MailboxAddress = {
  kind: 'agent',
  spaceId: 'space-1',
  handle: 'worker',
  taskId: 't-1',
  node: 'Coding',
};

function makeEntry(overrides?: { policy?: Partial<MailboxEntryPolicy> }): MailboxEntry {
  return {
    id: createUlid(),
    to: sessionAddress,
    origin: 'test',
    message: textMessage,
    status: 'enqueued',
    policy: { ...DEFAULT_MAILBOX_ENTRY_POLICY, ...overrides?.policy },
  };
}

describe('parseAddressStage', () => {
  test('a session address parses to the address slot with an unset outcome', () => {
    const result = parseAddressStage('session:sess-1');

    expect(result).toEqual({ address: sessionAddress, outcome: undefined });
    expect(Object.keys(result).sort()).toEqual(['address', 'outcome']);
  });

  test('an agent address with task and node query parses to the address slot', () => {
    const result = parseAddressStage('agent:space-1/worker?task=t-1&node=Coding');

    expect(result).toEqual({ address: agentAddress, outcome: undefined });
    expect(Object.keys(result).sort()).toEqual(['address', 'outcome']);
  });

  test('an unparseable address rejects with the invalid mailbox address reason', () => {
    const result = parseAddressStage('not-an-address');

    expect(result.address).toBeUndefined();
    expect(result.outcome).toEqual({
      kind: 'rejected',
      reason: 'invalid mailbox address: not-an-address',
    });
    expect(Object.keys(result).sort()).toEqual(['address', 'outcome']);
  });

  test('an empty address rejects with the invalid mailbox address reason', () => {
    expect(parseAddressStage('').outcome).toEqual({
      kind: 'rejected',
      reason: 'invalid mailbox address: ',
    });
  });
});

describe('projectMessageStage', () => {
  test('a string-content message projects into the projectedMessage slot', () => {
    const result = projectMessageStage(textMessage);

    expect(result).toEqual({
      projectedMessage: {
        type: 'user',
        message: { content: 'hello' },
        parent_tool_use_id: null,
      },
      outcome: undefined,
    });
    expect(Object.keys(result).sort()).toEqual(['outcome', 'projectedMessage']);
  });

  test('a text-block message projects with its priority preserved', () => {
    const result = projectMessageStage(blocksMessage);

    expect(result.projectedMessage).toEqual(blocksMessage);
    expect(result.outcome).toBeUndefined();
    expect(Object.keys(result).sort()).toEqual(['outcome', 'projectedMessage']);
  });

  test('a non-user type rejects with the projector reason verbatim', () => {
    const result = projectMessageStage({
      type: 'assistant',
      message: { content: 'hello' },
      parent_tool_use_id: null,
    } as unknown as MailboxMessage);

    expect(result.projectedMessage).toBeUndefined();
    expect(result.outcome).toEqual({ kind: 'rejected', reason: 'message.type must be "user"' });
  });

  test('a non-null parent_tool_use_id rejects with the projector reason verbatim', () => {
    const result = projectMessageStage({
      type: 'user',
      message: { content: 'hello' },
      parent_tool_use_id: 'toolu_1',
    } as unknown as MailboxMessage);

    expect(result.outcome).toEqual({
      kind: 'rejected',
      reason: 'message.parent_tool_use_id must be null',
    });
  });

  test('an out-of-vocabulary priority rejects with the projector reason verbatim', () => {
    const result = projectMessageStage({
      type: 'user',
      message: { content: 'hello' },
      parent_tool_use_id: null,
      priority: 'immediately',
    } as unknown as MailboxMessage);

    expect(result.outcome).toEqual({
      kind: 'rejected',
      reason: 'message.priority must be one of "now", "next", "later"',
    });
  });

  test('an empty string content rejects with the projector reason verbatim', () => {
    const result = projectMessageStage({
      type: 'user',
      message: { content: '' },
      parent_tool_use_id: null,
    });

    expect(result.outcome).toEqual({
      kind: 'rejected',
      reason: 'message.content must be a non-empty string or a non-empty array of text blocks',
    });
  });

  test('an empty block array rejects with the projector reason verbatim', () => {
    const result = projectMessageStage({
      type: 'user',
      message: { content: [] },
      parent_tool_use_id: null,
    });

    expect(result.outcome).toEqual({
      kind: 'rejected',
      reason: 'message.content must be a non-empty string or a non-empty array of text blocks',
    });
  });

  test('a non-text block rejects with the projector reason verbatim', () => {
    const result = projectMessageStage({
      type: 'user',
      message: { content: [{ type: 'image', text: 'nope' }] },
      parent_tool_use_id: null,
    } as unknown as MailboxMessage);

    expect(result.outcome).toEqual({
      kind: 'rejected',
      reason: 'message.content must be a non-empty string or a non-empty array of text blocks',
    });
  });
});

describe('createEntryStage', () => {
  test('a valid handoff builds an entry with default policy and an unset outcome', () => {
    const result = createEntryStage(sessionAddress, textMessage, 'test-origin', undefined);

    expect(result.outcome).toBeUndefined();
    expect(Object.keys(result).sort()).toEqual(['entry', 'outcome']);
    expect(result.entry?.id !== undefined && isUlid(result.entry.id)).toBe(true);
    expect(result.entry).toEqual({
      id: result.entry?.id,
      to: sessionAddress,
      origin: 'test-origin',
      message: textMessage,
      status: 'enqueued',
      policy: { ...DEFAULT_MAILBOX_ENTRY_POLICY },
    });
  });

  test('a partial policy merges over the defaults', () => {
    const result = createEntryStage(sessionAddress, textMessage, 'test-origin', { priority: 5 });

    expect(result.entry?.policy).toEqual({
      ttlMs: DEFAULT_MAILBOX_ENTRY_POLICY.ttlMs,
      maxAttempts: DEFAULT_MAILBOX_ENTRY_POLICY.maxAttempts,
      priority: 5,
    });
  });

  test('an agent address keeps its task and node fields on the entry', () => {
    const result = createEntryStage(agentAddress, blocksMessage, 'test-origin', undefined);

    expect(result.entry?.to).toEqual(agentAddress);
    expect(result.entry?.message).toEqual(blocksMessage);
  });

  test('an empty origin rejects with the factory reason verbatim', () => {
    const result = createEntryStage(sessionAddress, textMessage, '', undefined);

    expect(result.entry).toBeUndefined();
    expect(result.outcome).toEqual({
      kind: 'rejected',
      reason: 'origin must be a non-empty string',
    });
  });

  test('a zero ttlMs rejects with the factory reason verbatim', () => {
    const result = createEntryStage(sessionAddress, textMessage, 'test-origin', { ttlMs: 0 });

    expect(result.outcome).toEqual({
      kind: 'rejected',
      reason: 'policy.ttlMs must be a positive integer',
    });
  });

  test('a zero maxAttempts rejects with the factory reason verbatim', () => {
    const result = createEntryStage(sessionAddress, textMessage, 'test-origin', {
      maxAttempts: 0,
    });

    expect(result.outcome).toEqual({
      kind: 'rejected',
      reason: 'policy.maxAttempts must be a positive integer',
    });
  });

  test('a negative priority rejects with the factory reason verbatim', () => {
    const result = createEntryStage(sessionAddress, textMessage, 'test-origin', { priority: -1 });

    expect(result.outcome).toEqual({
      kind: 'rejected',
      reason: 'policy.priority must be a non-negative integer',
    });
  });

  test('a message the factory rejects surfaces its reason as the rejection', () => {
    const result = createEntryStage(
      sessionAddress,
      { type: 'user', message: { content: '' }, parent_tool_use_id: null },
      'test-origin',
      undefined
    );

    expect(result.outcome).toEqual({
      kind: 'rejected',
      reason: 'message.content must be a non-empty string or a non-empty array of text blocks',
    });
  });

  test('an address the factory rejects surfaces its reason as the rejection', () => {
    const result = createEntryStage(
      { kind: 'session', sessionId: '' },
      textMessage,
      'test-origin',
      undefined
    );

    expect(result.outcome).toEqual({
      kind: 'rejected',
      reason: 'to.sessionId must be a non-empty string',
    });
  });
});

describe('enqueueStage', () => {
  let mailbox: MailboxTestDb;

  beforeEach(() => {
    mailbox = createMailboxTestDb();
  });

  afterEach(() => {
    mailbox.close();
  });

  test('a well-formed entry enqueues and passes the outcome through', () => {
    const entry = makeEntry();

    const outcome = enqueueStage(mailbox.jobQueue, entry);

    expect(outcome).toEqual({ kind: 'enqueued', id: entry.id });
    expect(mailbox.rowCount()).toBe(1);
    expect(JSON.parse(mailbox.rows()[0].payload)).toEqual(entry);
  });

  test('an unserializable entry passes the serialization rejection through with zero rows', () => {
    const entry = {
      ...makeEntry(),
      policy: { ...DEFAULT_MAILBOX_ENTRY_POLICY, priority: 1n },
    } as unknown as MailboxEntry;

    const outcome = enqueueStage(mailbox.jobQueue, entry);

    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.reason).toContain('entry failed serialization:');
    }
    expect(mailbox.rowCount()).toBe(0);
  });
});

describe('crashHandler', () => {
  test('an Error crash maps to an internal rejection carrying its message', () => {
    expect(crashHandler(new Error('disk exploded'))).toEqual({
      kind: 'rejected',
      reason: 'internal: disk exploded',
    });
  });

  test('a non-Error crash maps to an internal rejection carrying its string form', () => {
    expect(crashHandler('wrecked')).toEqual({
      kind: 'rejected',
      reason: 'internal: wrecked',
    });
  });
});

describe('rejected', () => {
  test('an unset outcome is not a rejection', () => {
    expect(rejected(undefined)).toBe(false);
  });

  test('an enqueued outcome is not a rejection', () => {
    expect(rejected({ kind: 'enqueued', id: '1' })).toBe(false);
  });

  test('a rejected outcome is a rejection', () => {
    expect(rejected({ kind: 'rejected', reason: 'x' })).toBe(true);
  });
});

describe('handoffPromptToMailbox', () => {
  let mailbox: MailboxTestDb;

  beforeEach(() => {
    mailbox = createMailboxTestDb();
  });

  afterEach(() => {
    mailbox.close();
  });

  describe('happy path', () => {
    test('a session handoff enqueues one pending row on the mailbox lane', async () => {
      const outcome = await handoffPromptToMailbox({
        to: 'session:sess-1',
        message: textMessage,
        origin: 'test',
        jobQueue: mailbox.jobQueue,
      });

      expect(outcome.kind).toBe('enqueued');
      if (outcome.kind !== 'enqueued') return;
      expect(isUlid(outcome.id)).toBe(true);
      expect(mailbox.rowCount()).toBe(1);

      const row = mailbox.rows()[0];
      expect(row.queue).toBe(MAILBOX_LANE);
      expect(row.status).toBe('pending');
      expect(JSON.parse(row.payload)).toEqual({
        id: outcome.id,
        to: sessionAddress,
        origin: 'test',
        message: textMessage,
        status: 'enqueued',
        policy: { ...DEFAULT_MAILBOX_ENTRY_POLICY },
      });
    });

    test('an agent handoff round-trips the address and message priority through the payload', async () => {
      const outcome = await handoffPromptToMailbox({
        to: 'agent:space-1/worker?task=t-1&node=Coding',
        message: blocksMessage,
        origin: 'test',
        jobQueue: mailbox.jobQueue,
      });

      expect(outcome.kind).toBe('enqueued');
      if (outcome.kind !== 'enqueued') return;

      const row = mailbox.rows()[0];
      expect(JSON.parse(row.payload)).toEqual({
        id: outcome.id,
        to: agentAddress,
        origin: 'test',
        message: blocksMessage,
        status: 'enqueued',
        policy: { ...DEFAULT_MAILBOX_ENTRY_POLICY },
      });
    });

    test('a policy override lands in both the row priority column and the payload policy', async () => {
      const outcome = await handoffPromptToMailbox({
        to: 'session:sess-1',
        message: textMessage,
        origin: 'test',
        policy: { priority: 9 },
        jobQueue: mailbox.jobQueue,
      });

      expect(outcome.kind).toBe('enqueued');
      const row = mailbox.rows()[0];
      expect(row.priority).toBe(9);
      expect(JSON.parse(row.payload).policy).toEqual({
        ...DEFAULT_MAILBOX_ENTRY_POLICY,
        priority: 9,
      });
    });
  });

  describe('rejections', () => {
    test('an unparseable address rejects with the invalid mailbox address reason and writes nothing', async () => {
      const outcome = await handoffPromptToMailbox({
        to: 'not-an-address',
        message: textMessage,
        origin: 'test',
        jobQueue: mailbox.jobQueue,
      });

      expect(outcome).toEqual({
        kind: 'rejected',
        reason: 'invalid mailbox address: not-an-address',
      });
      expect(mailbox.rowCount()).toBe(0);
    });

    test('an empty address rejects and writes nothing', async () => {
      const outcome = await handoffPromptToMailbox({
        to: '',
        message: textMessage,
        origin: 'test',
        jobQueue: mailbox.jobQueue,
      });

      expect(outcome).toEqual({ kind: 'rejected', reason: 'invalid mailbox address: ' });
      expect(mailbox.rowCount()).toBe(0);
    });

    test('a projector rejection propagates its reason verbatim and writes nothing', async () => {
      const outcome = await handoffPromptToMailbox({
        to: 'session:sess-1',
        message: {
          type: 'user',
          message: { content: 'hello' },
          parent_tool_use_id: 'toolu_1',
        } as unknown as MailboxMessage,
        origin: 'test',
        jobQueue: mailbox.jobQueue,
      });

      expect(outcome).toEqual({
        kind: 'rejected',
        reason: 'message.parent_tool_use_id must be null',
      });
      expect(mailbox.rowCount()).toBe(0);
    });

    test('a projector content rejection propagates its reason verbatim and writes nothing', async () => {
      const outcome = await handoffPromptToMailbox({
        to: 'session:sess-1',
        message: { type: 'user', message: { content: '' }, parent_tool_use_id: null },
        origin: 'test',
        jobQueue: mailbox.jobQueue,
      });

      expect(outcome).toEqual({
        kind: 'rejected',
        reason: 'message.content must be a non-empty string or a non-empty array of text blocks',
      });
      expect(mailbox.rowCount()).toBe(0);
    });

    test('an empty origin rejects with the factory reason verbatim and writes nothing', async () => {
      const outcome = await handoffPromptToMailbox({
        to: 'session:sess-1',
        message: textMessage,
        origin: '',
        jobQueue: mailbox.jobQueue,
      });

      expect(outcome).toEqual({
        kind: 'rejected',
        reason: 'origin must be a non-empty string',
      });
      expect(mailbox.rowCount()).toBe(0);
    });

    test('an invalid policy rejects with the factory reason verbatim and writes nothing', async () => {
      const outcome = await handoffPromptToMailbox({
        to: 'session:sess-1',
        message: textMessage,
        origin: 'test',
        policy: { ttlMs: 0 },
        jobQueue: mailbox.jobQueue,
      });

      expect(outcome).toEqual({
        kind: 'rejected',
        reason: 'policy.ttlMs must be a positive integer',
      });
      expect(mailbox.rowCount()).toBe(0);
    });
  });

  describe('crash path', () => {
    test('a non-TypeError throw from a stage maps to an internal rejection and writes nothing', async () => {
      const crashingQueue = {
        enqueueUniquePending: () => {
          throw new Error('disk exploded');
        },
      } as unknown as JobQueueRepository;

      const outcome = await handoffPromptToMailbox({
        to: 'session:sess-1',
        message: textMessage,
        origin: 'test',
        jobQueue: crashingQueue,
      });

      expect(outcome).toEqual({
        kind: 'rejected',
        reason: 'internal: disk exploded',
      });
      expect(mailbox.rowCount()).toBe(0);
    });
  });
});

describe('mailbox entry round-trip law', () => {
  test('a session entry survives JSON serialization into parseMailboxEntry unchanged', () => {
    const entry = createMailboxEntry({
      to: sessionAddress,
      message: textMessage,
      origin: 'test',
    });

    expect(parseMailboxEntry(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
  });

  test('an agent entry with priority survives JSON serialization into parseMailboxEntry unchanged', () => {
    const entry = createMailboxEntry({
      to: agentAddress,
      message: blocksMessage,
      origin: 'test',
      policy: { priority: 3 },
    });

    expect(parseMailboxEntry(JSON.parse(JSON.stringify(entry)))).toEqual(entry);
  });
});
