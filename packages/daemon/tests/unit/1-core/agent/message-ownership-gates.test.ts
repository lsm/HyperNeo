import { describe, expect, test } from 'bun:test';
import {
  BATCH_DELIVERY_MAX_CHARS,
  buildBatchedDeliveryContent,
} from '../../../../src/lib/agent/message-delivery';
import {
  decideDeferAdmission,
  type FlushMessage,
  isTaskFlushInput,
  planFlushDelivery,
  resolveDeliveryRole,
  resolveMessageOwnership,
} from '../../../../src/lib/agent/message-ownership-gates';

function makeFlushMessage(overrides: Partial<FlushMessage> = {}): FlushMessage {
  return {
    uuid: 'uuid-1',
    isUserMessage: true,
    isTaskInput: true,
    flattenedText: 'hello',
    ...overrides,
  };
}

describe('isTaskFlushInput', () => {
  test('a persisted task input kind classifies as a task', () => {
    expect(isTaskFlushInput({ isSynthetic: true, inputKind: 'task' })).toBe(true);
  });

  test('a persisted system input kind never classifies as a task, even when synthetic', () => {
    expect(isTaskFlushInput({ isSynthetic: true, inputKind: 'system' })).toBe(false);
  });

  test('a persisted human input kind never classifies as a task', () => {
    expect(isTaskFlushInput({ isSynthetic: false, inputKind: 'human' })).toBe(false);
  });

  test('a legacy row without an input kind falls back to the synthetic flag', () => {
    expect(isTaskFlushInput({ isSynthetic: true })).toBe(true);
    expect(isTaskFlushInput({ isSynthetic: false })).toBe(false);
    expect(isTaskFlushInput({})).toBe(false);
  });
});

describe('resolveMessageOwnership', () => {
  test('job_queue alone owns the message', () => {
    expect(resolveMessageOwnership({ activeInJobQueue: true })).toBe('job_queue');
  });

  test('no durable job leaves the message unowned for the flush', () => {
    expect(resolveMessageOwnership({ activeInJobQueue: false })).toBe('unowned');
  });
});

describe('planFlushDelivery', () => {
  test('empty flush is a noop', () => {
    expect(
      planFlushDelivery({
        messages: [],
        activeInJobQueue: new Set(),
        activeTurnInJobQueue: false,
      })
    ).toEqual({
      action: 'noop',
    });
  });

  test('flush where every message is owned is a noop', () => {
    const result = planFlushDelivery({
      messages: [makeFlushMessage({ uuid: 'job-owned' })],
      activeInJobQueue: new Set(['job-owned']),
      activeTurnInJobQueue: false,
    });
    expect(result).toEqual({ action: 'noop' });
  });

  test('messages owned by the job queue are skipped with their ownership reason', () => {
    const result = planFlushDelivery({
      messages: [makeFlushMessage({ uuid: 'job-owned' }), makeFlushMessage({ uuid: 'free' })],
      activeInJobQueue: new Set(['job-owned']),
      activeTurnInJobQueue: false,
    });
    expect(result).toEqual({
      action: 'each',
      deliver: ['free'],
      skip: [{ uuid: 'job-owned', ownership: 'job_queue' }],
    });
  });

  test('non-user messages are skipped and do not break batchability of the rest', () => {
    const result = planFlushDelivery({
      messages: [
        makeFlushMessage({ uuid: 'assistant', isUserMessage: false, flattenedText: null }),
        makeFlushMessage({ uuid: 'a' }),
        makeFlushMessage({ uuid: 'b', flattenedText: 'world' }),
      ],
      activeInJobQueue: new Set(),
      activeTurnInJobQueue: false,
    });
    expect(result).toEqual({
      action: 'batch',
      uuids: ['a', 'b'],
    });
  });

  test('flattenable user messages beyond a single candidate batch in order', () => {
    const result = planFlushDelivery({
      messages: [
        makeFlushMessage({ uuid: 'first', flattenedText: 'one' }),
        makeFlushMessage({ uuid: 'second', flattenedText: 'two' }),
        makeFlushMessage({ uuid: 'third', flattenedText: 'three' }),
      ],
      activeInJobQueue: new Set(),
      activeTurnInJobQueue: false,
    });
    expect(result).toEqual({ action: 'batch', uuids: ['first', 'second', 'third'] });
  });

  test('a single deliverable candidate is delivered per message', () => {
    const result = planFlushDelivery({
      messages: [makeFlushMessage({ uuid: 'solo' })],
      activeInJobQueue: new Set(),
      activeTurnInJobQueue: false,
    });
    expect(result).toEqual({ action: 'each', deliver: ['solo'], skip: [] });
  });

  test('a job-queue-owned message forces per-message delivery for the rest', () => {
    const result = planFlushDelivery({
      messages: [
        makeFlushMessage({ uuid: 'job-owned', flattenedText: 'durable' }),
        makeFlushMessage({ uuid: 'a' }),
        makeFlushMessage({ uuid: 'b', flattenedText: 'world' }),
      ],
      activeInJobQueue: new Set(['job-owned']),
      activeTurnInJobQueue: false,
    });
    expect(result).toEqual({
      action: 'each',
      deliver: ['a', 'b'],
      skip: [{ uuid: 'job-owned', ownership: 'job_queue' }],
    });
  });

  test('a slash command forces per-message delivery and is delivered itself', () => {
    const result = planFlushDelivery({
      messages: [
        makeFlushMessage({ uuid: 'slash', flattenedText: '/compact' }),
        makeFlushMessage({ uuid: 'plain', flattenedText: 'hello' }),
      ],
      activeInJobQueue: new Set(),
      activeTurnInJobQueue: false,
    });
    expect(result).toEqual({
      action: 'each',
      deliver: ['slash', 'plain'],
      skip: [],
    });
  });

  test('a job-queue-owned flattenable message alone already blocks batching', () => {
    const result = planFlushDelivery({
      messages: [
        makeFlushMessage({ uuid: 'job-owned', flattenedText: 'durable' }),
        makeFlushMessage({ uuid: 'a' }),
      ],
      activeInJobQueue: new Set(['job-owned']),
      activeTurnInJobQueue: false,
    });
    expect(result).toEqual({
      action: 'each',
      deliver: ['a'],
      skip: [{ uuid: 'job-owned', ownership: 'job_queue' }],
    });
  });

  test('a job-queue-owned slash command still forces per-message delivery for the rest', () => {
    const result = planFlushDelivery({
      messages: [
        makeFlushMessage({ uuid: 'owned-slash', flattenedText: '/compact' }),
        makeFlushMessage({ uuid: 'a' }),
        makeFlushMessage({ uuid: 'b', flattenedText: 'world' }),
      ],
      activeInJobQueue: new Set(['owned-slash']),
      activeTurnInJobQueue: false,
    });
    expect(result).toEqual({
      action: 'each',
      deliver: ['a', 'b'],
      skip: [{ uuid: 'owned-slash', ownership: 'job_queue' }],
    });
  });

  test('an active turn outside the flush forces per-message delivery', () => {
    const result = planFlushDelivery({
      messages: [
        makeFlushMessage({ uuid: 'a' }),
        makeFlushMessage({ uuid: 'b', flattenedText: 'world' }),
      ],
      activeInJobQueue: new Set(['unrelated-active-turn']),
      activeTurnInJobQueue: true,
    });
    expect(result).toEqual({
      action: 'each',
      deliver: ['a', 'b'],
      skip: [],
    });
  });

  test('an active steer outside the flush does not block batching', () => {
    const result = planFlushDelivery({
      messages: [
        makeFlushMessage({ uuid: 'a' }),
        makeFlushMessage({ uuid: 'b', flattenedText: 'world' }),
      ],
      activeInJobQueue: new Set(['unrelated-active-steer']),
      activeTurnInJobQueue: false,
    });
    expect(result).toEqual({ action: 'batch', uuids: ['a', 'b'] });
  });

  test('mixed content forces per-message delivery and delivers the unflattenable message', () => {
    const result = planFlushDelivery({
      messages: [
        makeFlushMessage({ uuid: 'unflattenable', flattenedText: null }),
        makeFlushMessage({ uuid: 'a' }),
        makeFlushMessage({ uuid: 'b', flattenedText: 'world' }),
      ],
      activeInJobQueue: new Set(),
      activeTurnInJobQueue: false,
    });
    expect(result).toEqual({
      action: 'each',
      deliver: ['unflattenable', 'a', 'b'],
      skip: [],
    });
  });

  test('a lone unflattenable user message is delivered per message', () => {
    const result = planFlushDelivery({
      messages: [makeFlushMessage({ uuid: 'image-only', flattenedText: null })],
      activeInJobQueue: new Set(),
      activeTurnInJobQueue: false,
    });
    expect(result).toEqual({ action: 'each', deliver: ['image-only'], skip: [] });
  });

  test('combined batched content over the char cap forces per-message delivery', () => {
    const huge = 'x'.repeat(150_000);
    const result = planFlushDelivery({
      messages: [
        makeFlushMessage({ uuid: 'big-1', flattenedText: huge }),
        makeFlushMessage({ uuid: 'big-2', flattenedText: huge }),
      ],
      activeInJobQueue: new Set(),
      activeTurnInJobQueue: false,
    });
    expect(result).toEqual({
      action: 'each',
      deliver: ['big-1', 'big-2'],
      skip: [],
    });
  });

  test('combined content exactly at the execution-time batch budget still batches', () => {
    const budget = BATCH_DELIVERY_MAX_CHARS - 2 * 32;
    const result = planFlushDelivery({
      messages: [
        makeFlushMessage({ uuid: 'cap-1', flattenedText: 'a'.repeat(Math.ceil(budget / 2)) }),
        makeFlushMessage({ uuid: 'cap-2', flattenedText: 'b'.repeat(Math.floor(budget / 2)) }),
      ],
      activeInJobQueue: new Set(),
      activeTurnInJobQueue: false,
    });
    expect(result).toEqual({ action: 'batch', uuids: ['cap-1', 'cap-2'] });
  });

  test('content inside the exact wrapper size but over the execution budget forces each', () => {
    const wrapper = buildBatchedDeliveryContent(['', '']).length;
    const perText = Math.floor((BATCH_DELIVERY_MAX_CHARS - wrapper) / 2);
    const texts = ['a'.repeat(perText), 'b'.repeat(perText)];
    expect(buildBatchedDeliveryContent(texts).length).toBeLessThanOrEqual(BATCH_DELIVERY_MAX_CHARS);
    const result = planFlushDelivery({
      messages: texts.map((text, i) => makeFlushMessage({ uuid: `cap-${i}`, flattenedText: text })),
      activeInJobQueue: new Set(),
      activeTurnInJobQueue: false,
    });
    expect(result).toEqual({
      action: 'each',
      deliver: ['cap-0', 'cap-1'],
      skip: [],
    });
  });

  test('budget sizing holds across message counts', () => {
    for (const count of [2, 9, 10, 11, 101]) {
      const budget = BATCH_DELIVERY_MAX_CHARS - count * 32;
      const base = Math.floor(budget / count);
      const texts = Array.from({ length: count }, (_, i) =>
        'x'.repeat(i === count - 1 ? budget - base * (count - 1) : base)
      );
      const atCap = planFlushDelivery({
        messages: texts.map((text, i) => makeFlushMessage({ uuid: `m-${i}`, flattenedText: text })),
        activeInJobQueue: new Set(),
        activeTurnInJobQueue: false,
      });
      expect(atCap).toEqual({
        action: 'batch',
        uuids: texts.map((_, i) => `m-${i}`),
      });
      const overCap = planFlushDelivery({
        messages: [
          ...texts
            .slice(0, -1)
            .map((text, i) => makeFlushMessage({ uuid: `m-${i}`, flattenedText: text })),
          makeFlushMessage({ uuid: 'm-last', flattenedText: `${texts[count - 1]}y` }),
        ],
        activeInJobQueue: new Set(),
        activeTurnInJobQueue: false,
      });
      expect(overCap).toEqual({
        action: 'each',
        deliver: texts.map((_, i) => (i === count - 1 ? 'm-last' : `m-${i}`)),
        skip: [],
      });
    }
  });

  test('combined content one char over the execution-time budget forces per-message delivery', () => {
    const budget = BATCH_DELIVERY_MAX_CHARS - 2 * 32;
    const result = planFlushDelivery({
      messages: [
        makeFlushMessage({ uuid: 'cap-1', flattenedText: 'a'.repeat(Math.ceil(budget / 2)) }),
        makeFlushMessage({ uuid: 'cap-2', flattenedText: 'b'.repeat(Math.floor(budget / 2) + 1) }),
      ],
      activeInJobQueue: new Set(),
      activeTurnInJobQueue: false,
    });
    expect(result).toEqual({
      action: 'each',
      deliver: ['cap-1', 'cap-2'],
      skip: [],
    });
  });

  test('skips keep input order alongside per-message delivery', () => {
    const result = planFlushDelivery({
      messages: [
        makeFlushMessage({ uuid: 'a' }),
        makeFlushMessage({ uuid: 'assistant', isUserMessage: false }),
        makeFlushMessage({ uuid: 'unflattenable', flattenedText: null }),
        makeFlushMessage({ uuid: 'slash', flattenedText: '/model' }),
      ],
      activeInJobQueue: new Set(),
      activeTurnInJobQueue: false,
    });
    expect(result).toEqual({
      action: 'each',
      deliver: ['a', 'unflattenable', 'slash'],
      skip: [{ uuid: 'assistant', ownership: 'not_user_message' }],
    });
  });
});

describe('resolveDeliveryRole', () => {
  test('an existing active role is reused over every other input', () => {
    expect(
      resolveDeliveryRole({
        existingActiveRole: 'steer',
        requestedRole: 'turn',
        uniqueConstraintHit: true,
      })
    ).toBe('steer');
    expect(
      resolveDeliveryRole({
        existingActiveRole: 'turn',
        requestedRole: 'steer',
        uniqueConstraintHit: true,
      })
    ).toBe('turn');
  });

  test('an explicit requested role is returned when no constraint hits', () => {
    expect(
      resolveDeliveryRole({
        existingActiveRole: null,
        requestedRole: 'steer',
        uniqueConstraintHit: false,
      })
    ).toBe('steer');
    expect(
      resolveDeliveryRole({
        existingActiveRole: null,
        requestedRole: 'turn',
        uniqueConstraintHit: false,
      })
    ).toBe('turn');
  });

  test('an explicit requested turn under a unique-constraint hit is rejected, not returned', () => {
    expect(
      resolveDeliveryRole({
        existingActiveRole: null,
        requestedRole: 'turn',
        uniqueConstraintHit: true,
      })
    ).toBe('explicit_role_rejected');
  });

  test('an explicit requested steer under a unique-constraint hit is still returned', () => {
    expect(
      resolveDeliveryRole({
        existingActiveRole: null,
        requestedRole: 'steer',
        uniqueConstraintHit: true,
      })
    ).toBe('steer');
  });

  test('a unique-constraint hit with no existing or requested role falls back to steer', () => {
    expect(
      resolveDeliveryRole({
        existingActiveRole: null,
        uniqueConstraintHit: true,
      })
    ).toBe('steer');
  });

  test('a fresh delivery with no constraints takes the turn role', () => {
    expect(
      resolveDeliveryRole({
        existingActiveRole: null,
        uniqueConstraintHit: false,
      })
    ).toBe('turn');
  });
});

describe('decideDeferAdmission', () => {
  test('defer mode while busy defers on its own', () => {
    expect(
      decideDeferAdmission({
        deliveryMode: 'defer',
        isBusy: true,
        inRateLimitCooldown: false,
        parentTaskLimited: false,
      })
    ).toEqual({ action: 'defer' });
  });

  test('a rate-limit cooldown defers on its own', () => {
    expect(
      decideDeferAdmission({
        deliveryMode: 'immediate',
        isBusy: false,
        inRateLimitCooldown: true,
        parentTaskLimited: false,
      })
    ).toEqual({ action: 'defer' });
  });

  test('a limited parent task defers on its own', () => {
    expect(
      decideDeferAdmission({
        deliveryMode: 'immediate',
        isBusy: false,
        inRateLimitCooldown: false,
        parentTaskLimited: true,
      })
    ).toEqual({ action: 'defer' });
  });

  test('defer mode while idle still delivers', () => {
    expect(
      decideDeferAdmission({
        deliveryMode: 'defer',
        isBusy: false,
        inRateLimitCooldown: false,
        parentTaskLimited: false,
      })
    ).toEqual({ action: 'deliver' });
  });

  test('immediate mode while busy still delivers', () => {
    expect(
      decideDeferAdmission({
        deliveryMode: 'immediate',
        isBusy: true,
        inRateLimitCooldown: false,
        parentTaskLimited: false,
      })
    ).toEqual({ action: 'deliver' });
  });

  test('every defer signal together defers', () => {
    expect(
      decideDeferAdmission({
        deliveryMode: 'defer',
        isBusy: true,
        inRateLimitCooldown: true,
        parentTaskLimited: true,
      })
    ).toEqual({ action: 'defer' });
  });
});
