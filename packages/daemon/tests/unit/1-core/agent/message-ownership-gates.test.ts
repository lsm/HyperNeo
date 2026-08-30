import { describe, expect, test } from 'bun:test';
import {
  decideDeferAdmission,
  type FlushMessage,
  isTaskFlushInput,
  planFlushDelivery,
  resolveMessageOwnership,
} from '../../../../src/lib/agent/message-ownership-gates';

function makeFlushMessage(overrides: Partial<FlushMessage> = {}): FlushMessage {
  return {
    uuid: 'uuid-1',
    dbId: 'db-1',
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
    expect(planFlushDelivery({ messages: [], activeInJobQueue: new Set() })).toEqual({
      action: 'noop',
    });
  });

  test('flush where every message is owned is a noop', () => {
    const result = planFlushDelivery({
      messages: [makeFlushMessage({ uuid: 'job-owned' })],
      activeInJobQueue: new Set(['job-owned']),
    });
    expect(result).toEqual({ action: 'noop' });
  });

  test('messages owned by the job queue are skipped with their ownership reason', () => {
    const result = planFlushDelivery({
      messages: [makeFlushMessage({ uuid: 'job-owned' }), makeFlushMessage({ uuid: 'free' })],
      activeInJobQueue: new Set(['job-owned']),
    });
    expect(result).toEqual({
      action: 'each',
      deliver: ['free'],
      skip: [{ uuid: 'job-owned', ownership: 'job_queue' }],
    });
  });

  test('every unowned user message is delivered per message under session FIFO', () => {
    const result = planFlushDelivery({
      messages: [
        makeFlushMessage({ uuid: 'assistant', isUserMessage: false, flattenedText: null }),
        makeFlushMessage({ uuid: 'a' }),
        makeFlushMessage({ uuid: 'b', flattenedText: 'world' }),
      ],
      activeInJobQueue: new Set(),
    });
    expect(result).toEqual({
      action: 'each',
      deliver: ['a', 'b'],
      skip: [{ uuid: 'assistant', ownership: 'not_user_message' }],
    });
  });

  test('a single deliverable candidate is delivered per message', () => {
    const result = planFlushDelivery({
      messages: [makeFlushMessage({ uuid: 'solo' })],
      activeInJobQueue: new Set(),
    });
    expect(result).toEqual({ action: 'each', deliver: ['solo'], skip: [] });
  });

  test('a slash command is delivered itself alongside the rest', () => {
    const result = planFlushDelivery({
      messages: [
        makeFlushMessage({ uuid: 'slash', flattenedText: '/compact' }),
        makeFlushMessage({ uuid: 'plain', flattenedText: 'hello' }),
      ],
      activeInJobQueue: new Set(),
    });
    expect(result).toEqual({
      action: 'each',
      deliver: ['slash', 'plain'],
      skip: [],
    });
  });

  test('unflattenable user messages are still delivered per message', () => {
    const result = planFlushDelivery({
      messages: [
        makeFlushMessage({ uuid: 'unflattenable', flattenedText: null }),
        makeFlushMessage({ uuid: 'a' }),
        makeFlushMessage({ uuid: 'b', flattenedText: 'world' }),
      ],
      activeInJobQueue: new Set(),
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
    });
    expect(result).toEqual({ action: 'each', deliver: ['image-only'], skip: [] });
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
    });
    expect(result).toEqual({
      action: 'each',
      deliver: ['a', 'unflattenable', 'slash'],
      skip: [{ uuid: 'assistant', ownership: 'not_user_message' }],
    });
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
