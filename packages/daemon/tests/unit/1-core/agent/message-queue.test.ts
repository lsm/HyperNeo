import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { generateUUID } from '@hyperneo/shared';
import { MessageQueue } from '../../../../src/lib/agent/message-queue';

async function tick(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('MessageQueue', () => {
  let queue: MessageQueue;
  const testSessionId = generateUUID();

  beforeEach(() => {
    queue = new MessageQueue();
  });

  it('ends an empty old input stream when a replacement starts before the next input', async () => {
    queue.start();
    const old = queue.messageGenerator(testSessionId);
    let ended = false;
    const pending = old.next().then((step) => {
      ended = step.done === true;
    });
    queue.start();
    try {
      await tick(0);
      expect(ended).toBe(true);
      const replacement = queue.messageGenerator(testSessionId);
      void queue.enqueueWithId('replacement-input', 'Input for replacement').catch(() => {});
      const next = await replacement.next();
      expect(next.value?.message.uuid).toBe('replacement-input');
      next.value?.onSent();
    } finally {
      queue.stop();
      await pending;
      queue.clear();
    }
  });

  describe('enqueue', () => {
    it('should enqueue a message and return message ID', async () => {
      queue.start();

      const messageId = queue.enqueue('Test message');
      expect(messageId).toBeInstanceOf(Promise);

      const generator = queue.messageGenerator(testSessionId);
      const result = await generator.next();
      result.value.onSent();

      const id = await messageId;

      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      queue.stop();
    });

    it('should enqueue multiple messages', async () => {
      const promise1 = queue.enqueue('Message 1');
      const promise2 = queue.enqueue('Message 2');
      const promise3 = queue.enqueue('Message 3');

      expect(queue.size()).toBe(3);
      expect(promise1).toBeInstanceOf(Promise);
      expect(promise2).toBeInstanceOf(Promise);
      expect(promise3).toBeInstanceOf(Promise);

      queue.clear();
      await promise1.catch(() => {});
      await promise2.catch(() => {});
      await promise3.catch(() => {});
    });

    it('should enqueue message with internal flag', async () => {
      const promise = queue.enqueue('Internal message', true);
      expect(queue.size()).toBe(1);

      queue.clear();
      await promise.catch(() => {});
    });
  });

  it('suppresses the pre-yield callback only when requested by ACP', async () => {
    const yielded: string[] = [];
    queue.onMessageYielded = (id) => yielded.push(id);
    queue.start();

    const delivery = queue.enqueue('ACP prompt');
    const generator = queue.messageGenerator(testSessionId, { suppressPreYieldCallback: true });
    const result = await generator.next();
    expect(yielded).toEqual([]);
    result.value.onSent();
    await delivery;
    queue.stop();
  });

  it('keeps the SDK pre-yield callback behavior by default', async () => {
    const yielded: string[] = [];
    queue.onMessageYielded = (id) => yielded.push(id);
    queue.start();

    const delivery = queue.enqueue('SDK prompt');
    const generator = queue.messageGenerator(testSessionId);
    const result = await generator.next();
    expect(yielded).toHaveLength(1);
    result.value.onSent();
    await delivery;
    queue.stop();
  });

  describe('clear', () => {
    it('should clear all pending messages', async () => {
      const promise1 = queue.enqueue('Message 1');
      const promise2 = queue.enqueue('Message 2');
      const promise3 = queue.enqueue('Message 3');

      expect(queue.size()).toBe(3);

      queue.clear();

      expect(queue.size()).toBe(0);

      await promise1.catch(() => {});
      await promise2.catch(() => {});
      await promise3.catch(() => {});
    });

    it('should reject all pending message promises', async () => {
      const promise1 = queue.enqueue('Message 1');
      const promise2 = queue.enqueue('Message 2');

      const rejection1 = promise1.catch((err) => err);
      const rejection2 = promise2.catch((err) => err);

      queue.clear();

      const error1 = await rejection1;
      const error2 = await rejection2;

      expect(error1).toBeInstanceOf(Error);
      expect(error1.message).toBe('Interrupted by user');
      expect(error2).toBeInstanceOf(Error);
      expect(error2.message).toBe('Interrupted by user');
    });
  });

  describe('remove', () => {
    it('should remove one pending message by ID', async () => {
      const promise = queue.enqueueWithId('message-to-remove', 'Message 1');

      expect(queue.size()).toBe(1);
      expect(queue.remove('message-to-remove')).toBe(true);
      expect(queue.size()).toBe(0);

      await promise;
    });

    it('should return false for an unknown message ID', () => {
      expect(queue.remove('missing-message')).toBe(false);
    });

    it('removes a generator-claimed message before the actual yield', async () => {
      queue.start();
      const acknowledgment = queue.enqueueWithId('claimed-to-remove', 'Message 1');
      const generator = queue.messageGenerator(testSessionId);

      const nextPromise = generator.next();

      expect(queue.remove('claimed-to-remove')).toBe(true);
      expect(queue.size()).toBe(0);
      await acknowledgment;

      queue.stop();
      const result = await nextPromise;
      expect(result.done).toBe(true);
    });

    it('returns false once the message has actually been yielded', async () => {
      queue.start();
      const acknowledgment = queue.enqueueWithId('yielded-kept', 'Message 1');
      const generator = queue.messageGenerator(testSessionId);

      const result = await generator.next();
      expect(result.done).toBe(false);

      expect(queue.remove('yielded-kept')).toBe(false);
      expect(queue.size()).toBe(1);

      result.value.onSent();
      await acknowledgment;
      queue.stop();
    });
  });

  describe('requeueYielded', () => {
    it('moves a yielded message back to the front of the queue so the generator can re-yield it', async () => {
      queue.start();
      const acknowledgment = queue.enqueueWithId('requeued-id', 'Message 1');
      const generator = queue.messageGenerator(testSessionId);
      const result = await generator.next();
      expect(result.done).toBe(false);
      expect(queue.hasYielded('requeued-id')).toBe(true);

      expect(queue.requeueYielded('requeued-id')).toBe(true);
      expect(queue.hasYielded('requeued-id')).toBe(false);
      expect(queue.hasPendingOrClaimed('requeued-id')).toBe(true);

      const second = await generator.next();
      expect(second.done).toBe(false);
      expect((second.value?.message as { uuid?: string }).uuid).toBe('requeued-id');

      second.value.onSent();
      await acknowledgment;
      queue.stop();
    });

    it('returns false when the id is unknown or not yielded', async () => {
      expect(queue.requeueYielded('nope')).toBe(false);

      queue.start();
      const acknowledgment = queue.enqueueWithId('consumed-id', 'Message 1');
      const generator = queue.messageGenerator(testSessionId);
      const result = await generator.next();
      expect(result.done).toBe(false);
      result.value.onSent();
      await acknowledgment;
      expect(queue.requeueYielded('consumed-id')).toBe(false);
      queue.stop();
    });

    it('re-arms the queue timeout when the requeued message is yielded again', async () => {
      queue.overrideTimeoutMsForTest(20);
      queue.start();
      const acknowledgment = queue.enqueueWithId('requeued-timeout', 'Message 1');
      const generator = queue.messageGenerator(testSessionId);
      const first = await generator.next();
      expect(first.done).toBe(false);
      expect(queue.requeueYielded('requeued-timeout')).toBe(true);
      const second = await generator.next();
      expect(second.done).toBe(false);
      expect((second.value?.message as { uuid?: string }).uuid).toBe('requeued-timeout');

      await expect(acknowledgment).rejects.toThrow('Message queue timeout');
      queue.stop();
    });
  });

  describe('pruneYielded', () => {
    it('settles the acknowledgment of a pruned consumed entry instead of orphaning it', async () => {
      const admission = queue.enqueueWithId('prune-consumed', 'hello', false, { durable: true });
      const waiter = queue.waitForPendingOrInFlight('prune-consumed');
      queue.start();
      const generator = queue.messageGenerator(testSessionId);
      await generator.next();
      expect(queue.hasYielded('prune-consumed')).toBe(true);

      const removed = queue.pruneYielded((id) => id === 'prune-consumed');
      expect(removed).toEqual(['prune-consumed']);
      await admission;
      await waiter?.acknowledgment;
      expect(queue.hasYielded('prune-consumed')).toBe(false);
      expect(queue.size()).toBe(0);
      queue.stop();
    });
  });

  describe('hasPendingOrInFlight', () => {
    it('reports false for an unknown id and true while queued/claimed/yielded', async () => {
      expect(queue.hasPendingOrInFlight('nope')).toBe(false);
      expect(queue.hasPendingOrClaimed('nope')).toBe(false);
      expect(queue.hasYielded('nope')).toBe(false);

      const acknowledgment = queue.enqueueWithId('in-flight-id', 'Message 1');
      expect(queue.hasPendingOrInFlight('in-flight-id')).toBe(true);
      expect(queue.hasPendingOrClaimed('in-flight-id')).toBe(true);
      expect(queue.hasYielded('in-flight-id')).toBe(false);
      const existing = queue.waitForPendingOrInFlight('in-flight-id');
      expect(existing?.content).toBe('Message 1');

      queue.start();
      const generator = queue.messageGenerator(testSessionId);
      const result = await generator.next();
      expect(result.done).toBe(false);
      expect(queue.hasPendingOrInFlight('in-flight-id')).toBe(true);
      expect(queue.hasPendingOrClaimed('in-flight-id')).toBe(false);
      expect(queue.hasYielded('in-flight-id')).toBe(true);
      expect(queue.acknowledgeYielded('in-flight-id')).toBe(true);

      result.value.onSent();
      await acknowledgment;
      await existing?.acknowledgment;
      expect(queue.hasPendingOrInFlight('in-flight-id')).toBe(false);
      expect(queue.hasYielded('in-flight-id')).toBe(false);
      expect(queue.acknowledgeYielded('in-flight-id')).toBe(false);
      expect(queue.waitForPendingOrInFlight('in-flight-id')).toBeNull();
      queue.stop();
    });

    it('rejects a reused wait when the original queue entry fails', async () => {
      const acknowledgment = queue
        .enqueueWithId('rejected-id', 'Message 1')
        .catch((error) => error);
      const existing = queue
        .waitForPendingOrInFlight('rejected-id')
        ?.acknowledgment.catch((error) => error);

      queue.clear();

      expect(await acknowledgment).toMatchObject({ message: 'Interrupted by user' });
      expect(await existing).toMatchObject({ message: 'Interrupted by user' });
    });
  });

  describe('lifecycle', () => {
    it('should start in stopped state', () => {
      expect(queue.isRunning()).toBe(false);
    });

    it('should transition to running state when started', () => {
      queue.start();
      expect(queue.isRunning()).toBe(true);
    });

    it('should transition to stopped state when stopped', () => {
      queue.start();
      expect(queue.isRunning()).toBe(true);

      queue.stop();
      expect(queue.isRunning()).toBe(false);
    });
  });

  describe('messageGenerator', () => {
    it('should yield messages from queue', async () => {
      queue.start();

      const messagePromise = queue.enqueue('Test message');

      const generator = queue.messageGenerator(testSessionId);

      const result = await generator.next();

      expect(result.done).toBe(false);
      expect(result.value).toBeDefined();
      expect(result.value.message.type).toBe('user');
      expect(result.value.message.session_id).toBe(testSessionId);
      expect(result.value.message.message.content).toEqual([
        { type: 'text', text: 'Test message' },
      ]);

      result.value.onSent();

      const messageId = await messagePromise;
      expect(messageId).toBeDefined();
    });

    it('should yield multiple messages in order', async () => {
      queue.start();

      const promise1 = queue.enqueue('Message 1');
      const promise2 = queue.enqueue('Message 2');
      const promise3 = queue.enqueue('Message 3');

      const generator = queue.messageGenerator(testSessionId);

      const result1 = await generator.next();
      expect(result1.value.message.message.content[0].text).toBe('Message 1');
      result1.value.onSent();
      await promise1;

      const result2 = await generator.next();
      expect(result2.value.message.message.content[0].text).toBe('Message 2');
      result2.value.onSent();
      await promise2;

      const result3 = await generator.next();
      expect(result3.value.message.message.content[0].text).toBe('Message 3');
      result3.value.onSent();
      await promise3;
    });

    it('should stop yielding when queue is stopped', async () => {
      queue.start();

      const generator = queue.messageGenerator(testSessionId);

      queue.stop();

      const result = await generator.next();
      expect(result.done).toBe(true);
    });

    it('clear() resolves a yielded-but-unacknowledged message', async () => {
      queue.start();
      const messagePromise = queue.enqueueWithId('msg-inflight', 'Hello');
      const generator = queue.messageGenerator(testSessionId);

      const result = await generator.next();
      expect(result.done).toBe(false);

      queue.clear();
      await expect(messagePromise).resolves.toBeUndefined();
    });

    it('rejects when onMessageYielded throws and does not count the message as yielded', async () => {
      queue.start();
      const callbackError = new Error('yield persistence failed');
      queue.onMessageYielded = () => {
        throw callbackError;
      };
      const acknowledgment = queue.enqueueWithId('msg-callback-failure', 'Hello');
      const rejection = acknowledgment.catch((error) => error);
      const generator = queue.messageGenerator(testSessionId);

      await expect(generator.next()).rejects.toBe(callbackError);
      expect(await rejection).toBe(callbackError);
      expect(queue.size()).toBe(0);
    });

    it('waits for an async onMessageYielded before yielding, and rejects on its failure', async () => {
      queue.start();
      let persisted = false;
      queue.onMessageYielded = async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        persisted = true;
      };
      queue.enqueueWithId('msg-async-yield', 'Hello');
      const generator = queue.messageGenerator(testSessionId);
      const result = await generator.next();
      expect(persisted).toBe(true);
      result.value.onSent();

      const callbackError = new Error('async persistence failed');
      queue.onMessageYielded = async () => {
        throw callbackError;
      };
      const rejection = queue.enqueueWithId('msg-async-fail', 'Hello').catch((error) => error);
      await expect(generator.next()).rejects.toBe(callbackError);
      expect(await rejection).toBe(callbackError);
    });

    it('size() counts messages shifted out and yielded but not yet acknowledged', async () => {
      queue.start();
      queue.enqueueWithId('msg-inflight-size', 'Hello');
      const generator = queue.messageGenerator(testSessionId);
      const result = await generator.next();
      expect(queue.size()).toBe(1);
      result.value.onSent();
    });

    it('should handle complex message content', async () => {
      queue.start();

      const content = [
        { type: 'text' as const, text: 'Hello' },
        {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: 'image/png' as const,
            data: 'base64data',
          },
        },
      ];

      const messagePromise = queue.enqueue(content);

      const generator = queue.messageGenerator(testSessionId);
      const result = await generator.next();

      expect(result.value.message.message.content).toEqual(content);

      result.value.onSent();
      await messagePromise;
    });
  });

  describe('size', () => {
    it('should return correct queue size', async () => {
      expect(queue.size()).toBe(0);

      const promise1 = queue.enqueue('Message 1');
      expect(queue.size()).toBe(1);

      const promise2 = queue.enqueue('Message 2');
      expect(queue.size()).toBe(2);

      queue.clear();
      expect(queue.size()).toBe(0);

      await promise1.catch(() => {});
      await promise2.catch(() => {});
    });
  });

  describe('timeout detection', () => {
    it('should reject message after timeout if not consumed', async () => {
      const messageId = 'test-timeout-message';

      const promise = queue.enqueueWithId(messageId, 'Test message');

      queue.clear();

      await expect(promise).rejects.toThrow('Interrupted by user');
    });

    it('should clear timeout when message is consumed', async () => {
      queue.start();

      const messageId = 'test-consumed-message';
      const promise = queue.enqueueWithId(messageId, 'Test message');

      const generator = queue.messageGenerator('test-session');
      const result = await generator.next();

      expect(result.done).toBe(false);
      expect(result.value).toBeDefined();

      result.value.onSent();

      await expect(promise).resolves.toBeUndefined();

      queue.stop();
    });

    it('should include error name MessageQueueTimeoutError on timeout', async () => {
      const error = new Error('Message queue timeout: SDK did not consume message test within 30s');
      error.name = 'MessageQueueTimeoutError';

      expect(error.name).toBe('MessageQueueTimeoutError');
      expect(error.message).toContain('Message queue timeout');
    });

    it('should clear all pending timeouts when queue is cleared', async () => {
      const promise1 = queue.enqueue('Message 1');
      const promise2 = queue.enqueue('Message 2');
      const promise3 = queue.enqueue('Message 3');

      expect(queue.size()).toBe(3);

      const rejection1 = promise1.catch((err) => err);
      const rejection2 = promise2.catch((err) => err);
      const rejection3 = promise3.catch((err) => err);

      queue.clear();

      expect(queue.size()).toBe(0);

      const error1 = await rejection1;
      const error2 = await rejection2;
      const error3 = await rejection3;

      expect(error1.message).toBe('Interrupted by user');
      expect(error2.message).toBe('Interrupted by user');
      expect(error3.message).toBe('Interrupted by user');
    });

    it('should handle rapid enqueue/clear cycles without memory leaks', async () => {
      for (let i = 0; i < 10; i++) {
        const promises: Promise<string>[] = [];
        for (let j = 0; j < 5; j++) {
          promises.push(queue.enqueue(`Message ${i}-${j}`));
        }

        queue.clear();

        await Promise.allSettled(promises);

        expect(queue.size()).toBe(0);
      }
    });

    it('should reject with timeout error containing message ID', async () => {
      const error = new Error(
        'Message queue timeout: SDK did not consume message abc-123 within 30s. ' +
          'This usually indicates an SDK internal error. Please try again or create a new session.'
      );
      error.name = 'MessageQueueTimeoutError';

      expect(error.message).toContain('abc-123');
      expect(error.message).toContain('SDK did not consume');
      expect(error.message).toContain('30s');
    });
  });

  describe('generation tracking', () => {
    it('should return generation counter', () => {
      const gen1 = queue.getGeneration();
      expect(gen1).toBe(0);

      queue.start();
      const gen2 = queue.getGeneration();
      expect(gen2).toBe(1);

      queue.start();
      const gen3 = queue.getGeneration();
      expect(gen3).toBe(2);
    });

    it('should increment generation on each start', () => {
      expect(queue.getGeneration()).toBe(0);

      queue.start();
      expect(queue.getGeneration()).toBe(1);

      queue.stop();
      queue.start();
      expect(queue.getGeneration()).toBe(2);

      queue.stop();
    });
  });

  describe('parent_tool_use_id extraction', () => {
    it('should extract parent_tool_use_id from tool_result content', async () => {
      queue.start();

      const content = [
        { type: 'tool_result' as const, tool_use_id: 'tool-abc-123', content: 'Result text' },
      ];

      const messagePromise = queue.enqueue(content);

      const generator = queue.messageGenerator(testSessionId);
      const result = await generator.next();

      expect(result.value.message.parent_tool_use_id).toBe('tool-abc-123');

      result.value.onSent();
      await messagePromise;

      queue.stop();
    });

    it('should return null parent_tool_use_id for string content', async () => {
      queue.start();

      const messagePromise = queue.enqueue('Plain text message');

      const generator = queue.messageGenerator(testSessionId);
      const result = await generator.next();

      expect(result.value.message.parent_tool_use_id).toBeNull();

      result.value.onSent();
      await messagePromise;

      queue.stop();
    });

    it('should return null parent_tool_use_id for content array without tool_result', async () => {
      queue.start();

      const content = [
        { type: 'text' as const, text: 'Hello' },
        { type: 'text' as const, text: 'World' },
      ];

      const messagePromise = queue.enqueue(content);

      const generator = queue.messageGenerator(testSessionId);
      const result = await generator.next();

      expect(result.value.message.parent_tool_use_id).toBeNull();

      result.value.onSent();
      await messagePromise;

      queue.stop();
    });

    it('should handle mixed content with tool_result', async () => {
      queue.start();

      const content = [
        { type: 'text' as const, text: 'Here is the result:' },
        { type: 'tool_result' as const, tool_use_id: 'mixed-tool-id', content: 'Result' },
      ];

      const messagePromise = queue.enqueue(content);

      const generator = queue.messageGenerator(testSessionId);
      const result = await generator.next();

      expect(result.value.message.parent_tool_use_id).toBe('mixed-tool-id');

      result.value.onSent();
      await messagePromise;

      queue.stop();
    });
  });

  describe('stale generator handling', () => {
    it(
      'should exit when generation changes while waiting for message',
      async () => {
        queue.start();

        const generator = queue.messageGenerator(testSessionId);

        setTimeout(() => {
          queue.stop();
        }, 100);

        const result = await generator.next();
        expect(result.done).toBe(true);
      },
      { timeout: 2000 }
    );

    it('should check generation before yielding message', async () => {
      queue.start();

      const promise1 = queue.enqueue('Message 1');

      const generator = queue.messageGenerator(testSessionId);

      const result = await generator.next();
      expect(result.done).toBe(false);
      expect(result.value.message.message.content[0].text).toBe('Message 1');
      result.value.onSent();
      await promise1;

      queue.stop();
    });

    it('should allow new generator after restart to consume messages', async () => {
      queue.start();

      const generator1 = queue.messageGenerator(testSessionId);

      queue.stop();

      queue.start();

      const promise1 = queue.enqueue('Message for new gen');

      const generator2 = queue.messageGenerator(testSessionId);

      const result = await generator2.next();
      expect(result.done).toBe(false);
      expect(result.value.message.message.content[0].text).toBe('Message for new gen');
      result.value.onSent();
      await promise1;

      queue.stop();
    });
  });

  describe('enqueueWithId', () => {
    it('admits synchronously and returns an acknowledgment promise', async () => {
      const acknowledgment = queue.admitWithId('sync-admission', 'Test message');

      expect(acknowledgment).toBeInstanceOf(Promise);
      expect(queue.size()).toBe(1);
      expect(queue.remove('sync-admission')).toBe(true);
      await acknowledgment;
    });

    it('should enqueue message with pre-generated ID', async () => {
      queue.start();

      const customId = 'custom-message-id-123';
      const promise = queue.enqueueWithId(customId, 'Test message');

      const generator = queue.messageGenerator(testSessionId);
      const result = await generator.next();

      expect(result.value.message.uuid).toBe(customId);

      result.value.onSent();
      await promise;

      queue.stop();
    });

    it('should work with internal flag', async () => {
      queue.start();

      const promise = queue.enqueueWithId('msg-id', 'Internal', true);

      const generator = queue.messageGenerator(testSessionId);
      const result = await generator.next();

      expect(result.value.message.internal).toBe(true);

      result.value.onSent();
      await promise;

      queue.stop();
    });
  });

  describe('waiters cleanup', () => {
    it(
      'should clear waiters when message is enqueued',
      async () => {
        queue.start();

        const generator = queue.messageGenerator(testSessionId);

        setTimeout(() => {
          queue.enqueue('Delayed message');
        }, 50);

        const result = await generator.next();
        expect(result.done).toBe(false);

        result.value.onSent();
        queue.stop();
      },
      { timeout: 1000 }
    );

    it(
      'should clear waiters when queue is stopped',
      async () => {
        queue.start();

        const generator = queue.messageGenerator(testSessionId);

        setTimeout(() => {
          queue.stop();
        }, 50);

        const result = await generator.next();
        expect(result.done).toBe(true);
      },
      { timeout: 1000 }
    );
  });

  describe('concurrent operations', () => {
    it(
      'should handle concurrent enqueue operations',
      async () => {
        queue.start();

        const promise1 = queue.enqueue('Message 1');
        const promise2 = queue.enqueue('Message 2');
        const promise3 = queue.enqueue('Message 3');

        expect(queue.size()).toBe(3);

        const generator = queue.messageGenerator(testSessionId);

        const result1 = await generator.next();
        expect(result1.done).toBe(false);
        expect(result1.value.message.message.content[0].text).toBe('Message 1');
        result1.value.onSent();

        const result2 = await generator.next();
        expect(result2.done).toBe(false);
        expect(result2.value.message.message.content[0].text).toBe('Message 2');
        result2.value.onSent();

        const result3 = await generator.next();
        expect(result3.done).toBe(false);
        expect(result3.value.message.message.content[0].text).toBe('Message 3');
        result3.value.onSent();

        await Promise.all([promise1, promise2, promise3]);

        queue.stop();
      },
      { timeout: 2000 }
    );

    it('should handle enqueue while generator is processing', async () => {
      queue.start();

      const promise1 = queue.enqueue('First message');

      const generator = queue.messageGenerator(testSessionId);

      const result1 = await generator.next();
      expect(result1.value.message.message.content[0].text).toBe('First message');

      const promise2 = queue.enqueue('Second message');

      result1.value.onSent();
      await promise1;

      const result2 = await generator.next();
      expect(result2.value.message.message.content[0].text).toBe('Second message');
      result2.value.onSent();
      await promise2;

      queue.stop();
    });
  });

  describe('edge cases', () => {
    it('should handle empty string message', async () => {
      queue.start();

      const promise = queue.enqueue('');

      const generator = queue.messageGenerator(testSessionId);
      const result = await generator.next();

      expect(result.value.message.message.content).toEqual([{ type: 'text', text: '' }]);

      result.value.onSent();
      await promise;

      queue.stop();
    });

    it('should handle clear on empty queue', () => {
      expect(queue.size()).toBe(0);
      queue.clear();
      expect(queue.size()).toBe(0);
    });

    it('should handle multiple stops', () => {
      queue.start();
      queue.stop();
      queue.stop();
      expect(queue.isRunning()).toBe(false);
    });

    it('should handle multiple starts', () => {
      queue.start();
      queue.start();
      expect(queue.getGeneration()).toBe(2);
    });
  });

  describe('internal flag propagation', () => {
    it('should propagate internal flag from queued message to SDK message', async () => {
      queue.start();

      const messagePromise = queue.enqueue('Internal test message', true);

      const generator = queue.messageGenerator(testSessionId);

      const result = await generator.next();

      expect(result.done).toBe(false);
      expect(result.value).toBeDefined();
      expect(result.value.message.internal).toBe(true);

      result.value.onSent();
      await messagePromise;

      queue.stop();
    });

    it('should have false internal flag when not set', async () => {
      queue.start();

      const messagePromise = queue.enqueue('Regular message');

      const generator = queue.messageGenerator(testSessionId);

      const result = await generator.next();

      expect(result.done).toBe(false);
      expect(result.value).toBeDefined();
      expect(result.value.message.internal).toBe(false);

      result.value.onSent();
      await messagePromise;

      queue.stop();
    });

    it('should handle internal flag for multiple messages', async () => {
      queue.start();

      const promise1 = queue.enqueue('Regular 1', false);
      const promise2 = queue.enqueue('Internal 1', true);
      const promise3 = queue.enqueue('Regular 2');
      const promise4 = queue.enqueue('Internal 2', true);

      const generator = queue.messageGenerator(testSessionId);

      const result1 = await generator.next();
      expect(result1.value.message.internal).toBe(false);
      result1.value.onSent();
      await promise1;

      const result2 = await generator.next();
      expect(result2.value.message.internal).toBe(true);
      result2.value.onSent();
      await promise2;

      const result3 = await generator.next();
      expect(result3.value.message.internal).toBe(false);
      result3.value.onSent();
      await promise3;

      const result4 = await generator.next();
      expect(result4.value.message.internal).toBe(true);
      result4.value.onSent();
      await promise4;

      queue.stop();
    });
  });

  describe('durable delivery feeds — TTL bypass (#3742616720)', () => {
    it('a yielded-but-unacknowledged DURABLE feed RESOLVES on timeout (no duplicate re-feed)', async () => {
      const q = new MessageQueue();
      q.overrideTimeoutMsForTest(40);
      q.start();
      const promise = q.enqueueWithId('msg-durable', 'hello', false, { durable: true });
      const generator = q.messageGenerator('test-session');
      const result = await generator.next();
      expect(result.done).toBe(false);
      await expect(promise).resolves.toBeUndefined();
      q.stop();
    });

    it('a yielded-but-unacknowledged NON-durable feed still rejects (legacy behavior)', async () => {
      const q = new MessageQueue();
      q.overrideTimeoutMsForTest(40);
      q.start();
      const promise = q.enqueueWithId('msg-legacy', 'hello');
      const generator = q.messageGenerator('test-session');
      await generator.next();
      await expect(promise).rejects.toThrow('Message queue timeout');
      q.stop();
    });

    it('a NON-durable feed that was never yielded still rejects (pre-yield bound retained)', async () => {
      const q = new MessageQueue();
      q.overrideTimeoutMsForTest(40);
      const promise = q.enqueueWithId('msg-legacy-stalled', 'hello');
      await expect(promise).rejects.toThrow('Message queue timeout');
    });

    it('a timed-out feed rejects with the policy error name lifecycle handlers match on', async () => {
      const q = new MessageQueue();
      q.overrideTimeoutMsForTest(40);
      const error = await q.enqueueWithId('msg-named-timeout', 'hello').catch((err) => err);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('MessageQueueTimeoutError');
      expect(error.message).toContain('msg-named-timeout');
    });

    it('a DURABLE feed that was never yielded stays pending (timeout arms only once a consumer yields it)', async () => {
      const q = new MessageQueue();
      q.overrideTimeoutMsForTest(40);
      const promise = q.enqueueWithId('msg-stalled', 'hello', false, { durable: true });
      await new Promise((resolve) => setTimeout(resolve, 90));
      expect(q.hasPendingOrInFlight('msg-stalled')).toBe(true);
      const settled = promise.then(
        () => 'resolved',
        (error) => error
      );
      q.clear();
      expect(await settled).toMatchObject({ message: 'Interrupted by user' });
    });

    it('TODO(message-delivery redesign): the durable yield-timeout resolve currently records the feed as sent in the queue bookkeeping — tripwire: rewrite when the timeout stops counting as acceptance', async () => {
      const q = new MessageQueue();
      q.overrideTimeoutMsForTest(40);
      q.start();
      const promise = q.enqueueWithId('msg-timeout-sent-mark', 'hello', false, { durable: true });
      const generator = q.messageGenerator('test-session');
      await generator.next();
      await promise;
      q.stop();
    });
  });

  describe('SDK transport ack ownership — onSent resolves only the current yield attempt', () => {
    it('resolves the delivery promise only from the onSent of the current yield, exactly once', async () => {
      const q = new MessageQueue();
      q.start();
      const delivered = q.enqueueWithId('msg-ack-current', 'hello', false, { durable: true });
      let settled = 0;
      void delivered.then(() => {
        settled += 1;
      });
      const generator = q.messageGenerator(testSessionId);
      const step = await generator.next();
      expect(step.value.message.uuid).toBe('msg-ack-current');
      await tick(5);
      expect(settled).toBe(0);
      expect(q.hasYielded('msg-ack-current')).toBe(true);

      step.value.onSent();
      await delivered;
      expect(settled).toBe(1);

      step.value.onSent();
      await tick(5);
      expect(settled).toBe(1);
      expect(q.hasPendingOrInFlight('msg-ack-current')).toBe(false);
      q.stop();
    });

    it('a stale onSent from an evicted yield attempt neither resolves nor marks the entry', async () => {
      const q = new MessageQueue();
      q.start();
      const delivered = q.enqueueWithId('msg-stale-attempt', 'hello', false, { durable: true });
      let settled = 0;
      void delivered.then(() => {
        settled += 1;
      });
      const generator = q.messageGenerator(testSessionId);
      const firstStep = await generator.next();
      expect(firstStep.value.message.uuid).toBe('msg-stale-attempt');

      expect(q.requeueYielded('msg-stale-attempt')).toBe(true);
      const secondStep = await generator.next();
      expect(secondStep.value.message.uuid).toBe('msg-stale-attempt');

      firstStep.value.onSent();
      await tick(5);
      expect(settled).toBe(0);
      expect(q.hasYielded('msg-stale-attempt')).toBe(true);

      secondStep.value.onSent();
      await delivered;
      expect(settled).toBe(1);
      q.stop();
    });

    it('a late onSent arriving after the durable yield timeout settled the entry changes nothing', async () => {
      const q = new MessageQueue();
      q.overrideTimeoutMsForTest(30);
      q.start();
      const delivered = q.enqueueWithId('msg-late-onsent', 'hello', false, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      const step = await generator.next();

      await delivered;
      expect(q.hasPendingOrInFlight('msg-late-onsent')).toBe(false);

      step.value.onSent();
      await tick(5);
      expect(q.hasPendingOrInFlight('msg-late-onsent')).toBe(false);
      expect(q.size()).toBe(0);
      q.stop();
    });
  });

  describe('admission boundary: interrupts reject durable in-flight admissions', () => {
    it('clear rejects a yielded durable admission instead of resolving it as sent', async () => {
      const q = new MessageQueue();
      q.start();
      const delivered = q.enqueueWithId('msg-durable-clear', 'hello', false, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      await generator.next();
      expect(q.hasYielded('msg-durable-clear')).toBe(true);

      q.clear();
      await expect(delivered).rejects.toThrow('Interrupted by user');
      expect(q.hasPendingOrInFlight('msg-durable-clear')).toBe(false);
      q.stop();
    });

    it('clear still resolves a yielded non-durable admission', async () => {
      const q = new MessageQueue();
      q.start();
      const delivered = q.enqueueWithId('msg-legacy-clear', 'hello');
      const generator = q.messageGenerator(testSessionId);
      await generator.next();

      q.clear();
      await expect(delivered).resolves.toBeUndefined();
      q.stop();
    });

    it('stop rejects a yielded durable admission and drops it from the yielded set', async () => {
      const q = new MessageQueue();
      q.start();
      const delivered = q.enqueueWithId('msg-durable-stop', 'hello', false, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      await generator.next();
      expect(q.hasYielded('msg-durable-stop')).toBe(true);

      q.stop();
      await expect(delivered).rejects.toThrow('Interrupted by user');
      expect(q.hasYielded('msg-durable-stop')).toBe(false);
    });
  });

  describe('delivered-compaction lifecycle', () => {
    it('counts a sent internal /compact as awaiting its compact boundary', async () => {
      const q = new MessageQueue();
      q.start();

      const sent = q.enqueue('/compact', true, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      const result = await generator.next();
      expect(q.hasInFlightInternalCompaction()).toBe(true);
      expect(q.hasCompactionsAwaitingBoundary()).toBe(false);

      result.value.onSent();
      await sent;
      expect(q.hasInFlightInternalCompaction()).toBe(false);
      expect(q.hasCompactionsAwaitingBoundary()).toBe(true);
      expect(q.hasOutstandingInternalCompaction()).toBe(true);

      q.acknowledgeCompactionsAwaitingBoundary();
      expect(q.hasCompactionsAwaitingBoundary()).toBe(false);
      expect(q.hasOutstandingInternalCompaction()).toBe(false);
      q.stop();
    });

    it('acknowledging a delivered internal compaction does not by itself arm result attribution', async () => {
      const q = new MessageQueue();
      q.start();

      const sent = q.enqueue('/compact', true, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      const entry = await generator.next();
      entry.value.onSent();
      await sent;
      expect(q.hasCompactionsAwaitingBoundary()).toBe(true);

      q.acknowledgeCompactionsAwaitingBoundary();
      expect(q.consumeInternalCompactionResultAttribution()).toBe(false);
      q.stop();
    });

    it('explicitly armed result attribution is consumed exactly once', () => {
      const q = new MessageQueue();
      q.start();

      q.armInternalCompactionResultAttribution();
      expect(q.consumeInternalCompactionResultAttribution()).toBe(true);
      expect(q.consumeInternalCompactionResultAttribution()).toBe(false);
      q.stop();
    });

    it('does not arm result attribution for a boundary with no internal compaction awaiting', () => {
      const q = new MessageQueue();
      q.start();

      q.acknowledgeCompactionsAwaitingBoundary();
      expect(q.consumeInternalCompactionResultAttribution()).toBe(false);
      q.stop();
    });

    it('clears stale result attribution when a new internal compaction is sent', async () => {
      const q = new MessageQueue();
      q.start();
      q.armInternalCompactionResultAttribution();

      const sent = q.enqueueWithId('compact-next', '/compact', true, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      const entry = await generator.next();
      entry.value.onSent();
      await sent;
      expect(q.consumeInternalCompactionResultAttribution()).toBe(false);
      q.stop();
    });

    it('clears result attribution when the queue stops between boundary and result', () => {
      const q = new MessageQueue();
      q.start();
      q.armInternalCompactionResultAttribution();

      q.stop();
      expect(q.consumeInternalCompactionResultAttribution()).toBe(false);
    });

    it('tracks compaction boundaries in delivery order so a completed user compact cannot mask a daemon boundary', () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'user-compact',
        content: '/compact',
        internal: false,
      } as never);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);
      q.consumeCompactionBoundary();
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);

      q.noteInternalCompactionSent({
        id: 'daemon-compact',
        content: '/compact',
        internal: true,
      } as never);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(true);
      expect(q.hasBufferedInternalCompaction()).toBe(false);
      expect(q.consumeInternalCompactionResultAttribution()).toBe(false);
      q.acknowledgeCompactionsAwaitingBoundary();
      q.armInternalCompactionResultAttribution();
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);
      expect(q.consumeInternalCompactionResultAttribution()).toBe(true);
      q.stop();
    });

    it('keeps daemon-first ordering so the daemon boundary is not masked by a later user compact', () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'daemon-compact',
        content: '/compact',
        internal: true,
      } as never);
      q.noteInternalCompactionSent({
        id: 'user-compact',
        content: '/compact',
        internal: false,
      } as never);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(true);
      q.acknowledgeCompactionsAwaitingBoundary();
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);
      q.consumeCompactionBoundary();
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);
      q.stop();
    });

    it('keeps a daemon compaction buffered behind a user compact until its boundary ack clears it', () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'user-compact',
        content: '/compact',
        internal: false,
      } as never);
      q.noteInternalCompactionSent({
        id: 'daemon-compact',
        content: '/compact',
        internal: true,
      } as never);
      expect(q.hasBufferedInternalCompaction()).toBe(true);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);
      q.consumeCompactionBoundary();
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(true);
      expect(q.hasBufferedInternalCompaction()).toBe(true);

      q.acknowledgeCompactionsAwaitingBoundary();
      expect(q.hasBufferedInternalCompaction()).toBe(false);
      q.stop();
    });

    it('clears boundary-ordering state when the queue stops', () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'user-compact',
        content: '/compact',
        internal: false,
      } as never);
      q.noteInternalCompactionSent({
        id: 'daemon-compact',
        content: '/compact',
        internal: true,
      } as never);
      expect(q.hasBufferedInternalCompaction()).toBe(true);

      q.stop();
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);
      expect(q.hasBufferedInternalCompaction()).toBe(false);
    });

    it('does not inherit a compact outcome across a stop/restart for the next user compact', () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'user-compact-interrupted',
        content: '/compact',
        internal: false,
      } as never);
      q.noteCompactOutcome();
      q.stop();

      q.start();
      q.noteInternalCompactionSent({
        id: 'user-compact-next',
        content: '/compact',
        internal: false,
      } as never);
      q.noteInternalCompactionSent({
        id: 'daemon-compact-next',
        content: '/compact',
        internal: true,
      } as never);

      q.expireUserCompactionMarkerAtResult(0);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);

      q.noteCompactOutcome();
      q.expireUserCompactionMarkerAtResult(0);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(true);
      q.stop();
    });

    it('removes the boundary marker when a delivered compaction is revoked', () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'daemon-revoked',
        content: '/compact',
        internal: true,
      } as never);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(true);

      expect(q.revokeDeliveredCompaction('daemon-revoked')).toBe(true);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);
      expect(q.hasCompactionsAwaitingBoundary()).toBe(false);
      q.stop();
    });

    it('removes the boundary marker when the turn-end janitor acks a boundary-less daemon compaction', () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'daemon-dead',
        content: '/compact',
        internal: true,
      } as never);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(true);

      q.acknowledgeCompactionsAwaitingBoundary();
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);
      expect(q.hasCompactionsAwaitingBoundary()).toBe(false);
      q.stop();
    });

    it('expires a front user marker only on a zero-turn result after an unbounded compact outcome, never a daemon marker', () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'user-compact',
        content: '/compact',
        internal: false,
      } as never);
      q.noteInternalCompactionSent({
        id: 'daemon-compact',
        content: '/compact',
        internal: true,
      } as never);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);

      q.expireUserCompactionMarkerAtResult(0);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);

      q.noteCompactOutcome();
      q.expireUserCompactionMarkerAtResult(3);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);

      q.expireUserCompactionMarkerAtResult(0);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(true);

      q.noteCompactOutcome();
      q.expireUserCompactionMarkerAtResult(0);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(true);
      q.stop();
    });

    it('an auto boundary resets the compact outcome so a later work result cannot expire the user marker', () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'user-compact',
        content: '/compact',
        internal: false,
      } as never);
      q.noteCompactOutcome();
      q.resetCompactOutcome();
      q.expireUserCompactionMarkerAtResult(0);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);
      q.stop();
    });

    it('a daemon boundary ack binds its compact outcome so the daemon result cannot expire the next user marker', () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'daemon-compact',
        content: '/compact',
        internal: true,
      } as never);
      q.noteInternalCompactionSent({
        id: 'user-compact-behind',
        content: '/compact',
        internal: false,
      } as never);
      q.noteCompactOutcome();

      q.acknowledgeCompactionsAwaitingBoundary();
      q.expireUserCompactionMarkerAtResult(0);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);

      q.noteCompactOutcome();
      q.expireUserCompactionMarkerAtResult(0);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);
      q.stop();
    });

    it('keeps the buffered guard through a failed auto-compact and recovers only on the daemon compact own zero-turn result', () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'user-compact',
        content: '/compact',
        internal: false,
      } as never);
      q.consumeCompactionBoundary();
      q.noteInternalCompactionSent({
        id: 'daemon-compact',
        content: '/compact',
        internal: true,
      } as never);
      expect(q.hasBufferedInternalCompaction()).toBe(false);

      q.noteResultForCompactionRecovery(3);
      expect(q.canRecoverBufferedCompaction()).toBe(false);

      q.noteCompactOutcome();
      q.noteResultForCompactionRecovery(0);
      expect(q.canRecoverBufferedCompaction()).toBe(true);

      q.acknowledgeCompactionsAwaitingBoundary();
      expect(q.canRecoverBufferedCompaction()).toBe(false);
      expect(q.hasBufferedInternalCompaction()).toBe(false);
      q.stop();
    });

    it('does not let the user compact trailing zero-turn result authorize recovery of the buffered daemon compact', () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'user-compact',
        content: '/compact',
        internal: false,
      } as never);
      q.noteInternalCompactionSent({
        id: 'daemon-compact',
        content: '/compact',
        internal: true,
      } as never);
      q.noteCompactOutcome();
      q.consumeCompactionBoundary();
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(true);

      q.noteResultForCompactionRecovery(0);
      expect(q.canRecoverBufferedCompaction()).toBe(false);

      q.noteCompactOutcome();
      q.noteResultForCompactionRecovery(0);
      expect(q.canRecoverBufferedCompaction()).toBe(true);
      q.stop();
    });

    it('marks a buffered daemon compaction when delivered behind another compaction', () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'user-compact',
        content: '/compact',
        internal: false,
      } as never);
      q.noteInternalCompactionSent({
        id: 'daemon-compact',
        content: '/compact',
        internal: true,
      } as never);
      expect(q.hasBufferedInternalCompaction()).toBe(true);
      q.stop();
    });

    it('consumes an orphaned compact outcome at the next top-level result', () => {
      const q = new MessageQueue();
      q.start();
      q.noteCompactOutcome();
      q.noteResultForCompactionRecovery(3);
      expect(q.canRecoverBufferedCompaction()).toBe(false);

      q.noteInternalCompactionSent({
        id: 'user-compact-later',
        content: '/compact',
        internal: false,
      } as never);
      q.noteInternalCompactionSent({
        id: 'daemon-compact-later',
        content: '/compact',
        internal: true,
      } as never);

      q.expireUserCompactionMarkerAtResult(0);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);

      q.noteCompactOutcome();
      q.expireUserCompactionMarkerAtResult(0);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(true);
      q.stop();
    });

    it('marks a user boundary for an argument-bearing compact command', () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'user-compact-args',
        content: '/compact preserve the latest errors',
        internal: false,
      } as never);
      q.noteInternalCompactionSent({
        id: 'daemon-compact',
        content: '/compact',
        internal: true,
      } as never);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);
      q.consumeCompactionBoundary();
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(true);
      q.stop();
    });

    it('marks a user boundary for a replayed compact stored as content blocks', () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'user-compact-replayed',
        content: [{ type: 'text', text: '/compact preserve the latest errors' }],
        internal: false,
      } as never);
      q.noteInternalCompactionSent({
        id: 'daemon-compact',
        content: '/compact',
        internal: true,
      } as never);
      expect(q.nextCompactionBoundaryIsDaemon()).toBe(false);
      q.stop();
    });

    it('latches buffered recovery evidence until the daemon marker is acknowledged', () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'daemon-compact',
        content: '/compact',
        internal: true,
      } as never);
      q.noteCompactOutcome();
      q.noteResultForCompactionRecovery(0);
      expect(q.canRecoverBufferedCompaction()).toBe(true);

      q.noteResultForCompactionRecovery(3);
      expect(q.canRecoverBufferedCompaction()).toBe(true);

      q.acknowledgeCompactionsAwaitingBoundary();
      expect(q.canRecoverBufferedCompaction()).toBe(false);
      q.stop();
    });

    it('keeps a yielded internal compaction outstanding across a compact boundary', async () => {
      const q = new MessageQueue();
      q.start();
      const compaction = q.enqueueWithId('compact-yielded', '/compact', true, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      const entry = await generator.next();
      expect(q.hasInFlightInternalCompaction()).toBe(true);

      q.acknowledgeCompactionsAwaitingBoundary();
      expect(q.hasInFlightInternalCompaction()).toBe(true);
      expect(q.hasOutstandingInternalCompaction()).toBe(true);

      entry.value.onSent();
      await compaction;
      expect(q.hasCompactionsAwaitingBoundary()).toBe(true);
      q.stop();
    });

    it('a compact boundary cancels a queued internal compaction instead of double-compacting', async () => {
      const q = new MessageQueue();
      q.start();
      const compaction = q.enqueue('/compact', true, { durable: true, prepend: true });
      expect(q.hasQueuedInternalCompaction()).toBe(true);

      q.acknowledgeCompactionsAwaitingBoundary();
      expect(q.hasQueuedInternalCompaction()).toBe(false);
      expect(q.hasOutstandingInternalCompaction()).toBe(false);
      await compaction;
      q.stop();
    });

    it('stop interrupts queued and in-flight internal compactions', async () => {
      const q = new MessageQueue();
      q.start();

      const first = q.enqueueWithId('compact-1', '/compact', true, { durable: true });
      const second = q.enqueueWithId('compact-2', '/compact', true, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      await generator.next();

      const settled: Array<string | undefined> = [];
      const firstHandled = first.catch((error: Error) => {
        settled.push(error.message);
      });
      const secondHandled = second.catch((error: Error) => {
        settled.push(error.message);
      });
      q.stop();
      await firstHandled;
      await secondHandled;
      expect(settled).toEqual(['Interrupted by user', 'Interrupted by user']);
      expect(q.hasQueuedInternalCompaction()).toBe(false);
      expect(q.hasInFlightInternalCompaction()).toBe(false);
      expect(q.hasOutstandingInternalCompaction()).toBe(false);
    });

    it('stop notifies when a delivered compaction is abandoned without its boundary', async () => {
      const q = new MessageQueue();
      q.start();
      const aborted = mock(() => {});
      q.onInternalCompactionsAborted = aborted;

      const sent = q.enqueue('/compact', true, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      const result = await generator.next();
      result.value.onSent();
      await sent;
      expect(q.hasCompactionsAwaitingBoundary()).toBe(true);

      q.stop();
      expect(aborted).toHaveBeenCalledTimes(1);
    });

    it('clear notifies when a delivered compaction is abandoned before its boundary', async () => {
      const q = new MessageQueue();
      q.start();
      const aborted = mock(() => {});
      q.onInternalCompactionsAborted = aborted;

      const sent = q.enqueue('/compact', true, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      const result = await generator.next();
      result.value.onSent();
      await sent;
      expect(q.hasCompactionsAwaitingBoundary()).toBe(true);

      q.clear();
      expect(aborted).toHaveBeenCalledTimes(1);
    });

    it('clear notifies when a yielded compaction is abandoned before its boundary', async () => {
      const q = new MessageQueue();
      q.start();
      const aborted = mock(() => {});
      q.onInternalCompactionsAborted = aborted;

      const sent = q.enqueue('/compact', true, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      const result = await generator.next();
      expect(q.hasInFlightInternalCompaction()).toBe(true);

      q.clear();
      await sent;
      expect(aborted).toHaveBeenCalledTimes(1);
      q.stop();
    });

    it('removePendingInternalCompactions keeps a delivered compaction outstanding', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueue('/compact', true, { durable: true });
      void q.enqueueWithId('compact-queued', '/compact', true, { durable: true });
      const userMessage = q.enqueueWithId('user-msg', 'finish the deploy', false);
      const generator = q.messageGenerator(testSessionId);
      const result = await generator.next();
      result.value.onSent();
      await sent;
      expect(q.hasCompactionsAwaitingBoundary()).toBe(true);
      expect(q.hasQueuedInternalCompaction()).toBe(true);

      const removed = q.removePendingInternalCompactions();

      expect(removed).toBe(1);
      expect(q.hasQueuedInternalCompaction()).toBe(false);
      expect(q.hasCompactionsAwaitingBoundary()).toBe(true);
      expect(q.hasOutstandingInternalCompaction()).toBe(true);
      expect(q.hasQueuedMessages()).toBe(true);
      q.stop();
      q.clear();
      await userMessage.catch(() => {});
    });

    it('a delivery hold keeps a queued compaction from bypassing the gate until released', async () => {
      const q = new MessageQueue();
      q.start();
      const compaction = q.enqueue('/compact', true, { durable: true });
      expect(q.hasQueuedInternalCompaction()).toBe(true);
      const generator = q.messageGenerator(testSessionId);

      q.holdInternalCompactionDelivery();
      let delivered = false;
      const nextPromise = generator.next().then((result) => {
        delivered = true;
        return result;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(delivered).toBe(false);

      q.releaseInternalCompactionDelivery();
      const result = await Promise.race([
        nextPromise,
        new Promise((resolve) => setTimeout(resolve, 500)).then(() => 'timeout'),
      ]);
      expect(result).not.toBe('timeout');
      (
        result as unknown as {
          value: { onSent: () => void };
        }
      ).value.onSent();
      await compaction;
      q.stop();
    });

    it('an empty-queue interrupt advances the user-interrupt epoch without a clear', () => {
      const q = new MessageQueue();
      q.start();
      const clearEpochBefore = q.getClearEpoch();
      const interruptEpochBefore = q.getUserInterruptEpoch();

      q.noteUserInterrupt();

      expect(q.getClearEpoch()).toBe(clearEpochBefore);
      expect(q.getUserInterruptEpoch()).toBe(interruptEpochBefore + 1);
      q.stop();
    });

    it('a queue restart clears outstanding compaction state so prompts are not held', async () => {
      const q = new MessageQueue();
      q.start();

      const sent = q.enqueue('/compact', true, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      const result = await generator.next();
      result.value.onSent();
      await sent;
      expect(q.hasCompactionsAwaitingBoundary()).toBe(true);

      q.stop();
      expect(q.hasOutstandingInternalCompaction()).toBe(false);

      q.start();
      const prompt = q.enqueue('after restart', false, { durable: true });
      const restarted = q.messageGenerator(testSessionId);
      const delivered = await restarted.next();
      expect(delivered.value.message.message.content[0].text).toBe('after restart');
      delivered.value.onSent();
      await prompt;
      q.stop();
    });

    it('tracks internal compactions as outstanding while queued', () => {
      const q = new MessageQueue();
      const queued = q.enqueue('/compact', true, { durable: true });
      expect(q.hasQueuedMessages()).toBe(true);
      expect(q.hasQueuedInternalCompaction()).toBe(true);
      expect(q.hasOutstandingInternalCompaction()).toBe(true);

      q.clear();
      queued.catch(() => {});
      expect(q.hasOutstandingInternalCompaction()).toBe(false);
    });

    it('acknowledging a yielded internal compaction counts it as delivered', async () => {
      const q = new MessageQueue();
      q.start();

      const sent = q.enqueueWithId('compact-yielded', '/compact', true, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      await generator.next();
      expect(q.hasYielded('compact-yielded')).toBe(true);

      expect(q.acknowledgeYielded('compact-yielded')).toBe(true);
      await sent;
      expect(q.hasCompactionsAwaitingBoundary()).toBe(true);
      q.stop();
    });

    it('does not count non-compaction internal messages as compactions', async () => {
      const q = new MessageQueue();
      q.start();

      const sent = q.enqueue('/context', true, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      const result = await generator.next();
      result.value.onSent();
      await sent;

      expect(q.hasQueuedInternalCompaction()).toBe(false);
      expect(q.hasInFlightInternalCompaction()).toBe(false);
      expect(q.hasCompactionsAwaitingBoundary()).toBe(false);
      expect(q.hasOutstandingInternalCompaction()).toBe(false);
      q.stop();
    });

    it('clear resets boundary accounting', async () => {
      const q = new MessageQueue();
      q.start();

      const sent = q.enqueue('/compact', true, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      const result = await generator.next();
      result.value.onSent();
      await sent;
      expect(q.hasCompactionsAwaitingBoundary()).toBe(true);

      q.clear();
      expect(q.hasCompactionsAwaitingBoundary()).toBe(false);
      expect(q.hasOutstandingInternalCompaction()).toBe(false);
    });

    it('counts a durable internal compaction delivered but unacknowledged until its timeout', async () => {
      const q = new MessageQueue();
      q.overrideTimeoutMsForTest(40);
      q.start();

      const delivery = q.enqueueWithId('compact-timeout', '/compact', true, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      await generator.next();
      expect(q.hasCompactionsAwaitingBoundary()).toBe(false);

      await delivery;
      expect(q.hasCompactionsAwaitingBoundary()).toBe(true);
      expect(q.hasOutstandingInternalCompaction()).toBe(true);
      q.stop();
    });

    it('acknowledges one delivered compaction per compact boundary', async () => {
      const q = new MessageQueue();
      q.start();

      const first = q.enqueueWithId('compact-a', '/compact', true, { durable: true });
      const second = q.enqueueWithId('compact-b', '/compact', true, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      const a = await generator.next();
      a.value.onSent();
      await first;
      const b = await generator.next();
      b.value.onSent();
      await second;

      expect(q.hasCompactionsAwaitingBoundary()).toBe(true);
      q.acknowledgeCompactionsAwaitingBoundary();
      expect(q.hasCompactionsAwaitingBoundary()).toBe(true);
      q.acknowledgeCompactionsAwaitingBoundary();
      expect(q.hasCompactionsAwaitingBoundary()).toBe(false);
      q.stop();
    });
  });

  describe('delivery gate', () => {
    it('holds queued messages until the gate resolves', async () => {
      const q = new MessageQueue();
      q.start();
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      q.setDeliveryGate(gate);

      let yielded = false;
      const consumer = (async () => {
        for await (const entry of q.messageGenerator(testSessionId)) {
          yielded = true;
          entry.onSent();
          break;
        }
      })();
      const delivery = q.enqueue('first prompt', false, { durable: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(yielded).toBe(false);

      releaseGate();
      await consumer;
      await delivery;
      expect(yielded).toBe(true);
      q.stop();
    });

    it('a tool result bypasses the gate even when an ordinary prompt precedes it', async () => {
      const q = new MessageQueue();
      q.start();
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      q.setDeliveryGate(gate);

      const prompt = q.enqueue('queued prompt', false, { durable: true });
      const toolResult = q.enqueueWithId(
        'tool-result-1',
        [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'done' }],
        false,
        { durable: true }
      );

      const generator = q.messageGenerator(testSessionId);
      const first = await generator.next();
      expect(first.value.message.uuid).toBe('tool-result-1');
      first.value.onSent();
      await toolResult;

      releaseGate();
      const second = await generator.next();
      expect(second.value.message.message.content[0].text).toBe('queued prompt');
      second.value.onSent();
      await prompt;
      q.stop();
    });

    it('a queued tool result outranks an earlier internal compaction while gated', async () => {
      const q = new MessageQueue();
      q.start();
      const compaction = q.enqueue('/compact', true, { durable: true });
      const toolResult = q.enqueueWithId(
        'tool-result-1',
        [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'done' }],
        false,
        { durable: true }
      );

      const generator = q.messageGenerator(testSessionId);
      const first = await generator.next();
      expect(first.value.message.uuid).toBe('tool-result-1');
      first.value.onSent();
      await toolResult;

      const second = await generator.next();
      expect(second.value.message.internal).toBe(true);
      second.value.onSent();
      await compaction;
      q.stop();
    });

    it('ordinary prompts hold behind a sent internal compaction until its boundary is acknowledged', async () => {
      const q = new MessageQueue();
      q.start();
      const compaction = q.enqueue('/compact', true, { durable: true, prepend: true });
      const prompt = q.enqueue('after compaction', false, { durable: true });

      const generator = q.messageGenerator(testSessionId);
      const first = await generator.next();
      expect(first.value.message.internal).toBe(true);
      first.value.onSent();
      await compaction;
      expect(q.hasCompactionsAwaitingBoundary()).toBe(true);

      let promptDelivered = false;
      const secondPending = generator.next().then((entry) => {
        promptDelivered = true;
        return entry;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(promptDelivered).toBe(false);

      q.acknowledgeCompactionsAwaitingBoundary();
      const second = await secondPending;
      expect(second.value.message.message.content[0].text).toBe('after compaction');
      second.value.onSent();
      await prompt;
      q.stop();
    });

    it('keeps waiting for new messages while a gate spans an empty queue', async () => {
      const q = new MessageQueue();
      q.start();
      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      q.setDeliveryGate(gate);

      let delivered: string | undefined;
      const consumer = (async () => {
        for await (const entry of q.messageGenerator(testSessionId)) {
          delivered = entry.message.message.content[0].text;
          entry.onSent();
          break;
        }
      })();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const delivery = q.enqueue('after empty', false, { durable: true });
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(delivered).toBeUndefined();

      releaseGate();
      await consumer;
      await delivery;
      expect(delivered).toBe('after empty');
      q.stop();
    });

    it('a rejected gate does not wedge the queue', async () => {
      const q = new MessageQueue();
      q.start();
      q.setDeliveryGate(Promise.reject(new Error('gate failed')));

      const delivery = q.enqueue('survivor', false, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      const result = await generator.next();
      expect(result.value.message.message.content[0].text).toBe('survivor');
      result.value.onSent();
      await delivery;
      q.stop();
    });

    it('stop ends the generator even while a delivery gate never settles', async () => {
      const q = new MessageQueue();
      q.start();
      q.setDeliveryGate(new Promise<void>(() => {}));
      const delivery = q.enqueue('gated', false, { durable: true });

      const generator = q.messageGenerator(testSessionId);
      const pending = generator.next();
      await new Promise((resolve) => setTimeout(resolve, 10));
      q.stop();

      const outcome = await pending;
      expect(outcome.done).toBe(true);
      q.clear();
      delivery.catch(() => {});
    });

    it('a restarted generation consumes normally after stop dropped a never-settling gate', async () => {
      const q = new MessageQueue();
      q.start();
      q.setDeliveryGate(new Promise<void>(() => {}));
      const stranded = q.enqueue('stranded', false, { durable: true });

      const firstGenerator = q.messageGenerator(testSessionId);
      const firstPending = firstGenerator.next();
      await new Promise((resolve) => setTimeout(resolve, 10));
      q.stop();
      await firstPending;
      q.clear();
      stranded.catch(() => {});

      q.start();
      const delivery = q.enqueue('after restart', false, { durable: true });
      const secondGenerator = q.messageGenerator(testSessionId);
      const result = await secondGenerator.next();
      expect(result.value.message.message.content[0].text).toBe('after restart');
      result.value.onSent();
      await delivery;
      q.stop();
    });
  });

  describe('enqueue options passthrough', () => {
    it('admits a prepend message ahead of earlier admissions', async () => {
      const q = new MessageQueue();
      q.start();

      const first = q.enqueue('first', false, { durable: true });
      const urgent = q.enqueue('urgent', false, { durable: true, prepend: true });
      expect(q.hasQueuedMessages()).toBe(true);

      const generator = q.messageGenerator(testSessionId);
      const firstResult = await generator.next();
      expect(firstResult.value.message.message.content[0].text).toBe('urgent');
      firstResult.value.onSent();
      const secondResult = await generator.next();
      expect(secondResult.value.message.message.content[0].text).toBe('first');
      secondResult.value.onSent();
      await Promise.all([first, urgent]);
      q.stop();
    });
  });

  describe('delivered-compaction revocation', () => {
    it('revokes a delivered internal compaction by its id and clears the outstanding flag', async () => {
      const q = new MessageQueue();
      q.start();

      const sent = q.enqueueWithId('compact-1', '/compact', true, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      const result = await generator.next();
      result.value.onSent();
      await sent;
      expect(q.hasCompactionsAwaitingBoundary()).toBe(true);

      expect(q.revokeDeliveredCompaction('compact-1')).toBe(true);
      expect(q.hasCompactionsAwaitingBoundary()).toBe(false);
      expect(q.hasOutstandingInternalCompaction()).toBe(false);
      q.stop();
    });

    it('returns false for a non-compaction or unknown id', async () => {
      const q = new MessageQueue();
      q.start();

      const sent = q.enqueueWithId('prompt-1', 'hello', false, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      const result = await generator.next();
      result.value.onSent();
      await sent;

      expect(q.revokeDeliveredCompaction('prompt-1')).toBe(false);
      expect(q.revokeDeliveredCompaction('nope')).toBe(false);
      expect(q.hasCompactionsAwaitingBoundary()).toBe(false);
      q.stop();
    });

    it('tracks delivered compaction ids so a boundary acknowledges the oldest first', async () => {
      const q = new MessageQueue();
      q.start();

      const first = q.enqueueWithId('compact-a', '/compact', true, { durable: true });
      const second = q.enqueueWithId('compact-b', '/compact', true, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      const a = await generator.next();
      a.value.onSent();
      await first;
      const b = await generator.next();
      b.value.onSent();
      await second;

      expect(q.revokeDeliveredCompaction('compact-b')).toBe(true);
      expect(q.hasCompactionsAwaitingBoundary()).toBe(true);
      q.acknowledgeCompactionsAwaitingBoundary();
      expect(q.hasCompactionsAwaitingBoundary()).toBe(false);
      expect(q.revokeDeliveredCompaction('compact-a')).toBe(false);
      q.stop();
    });

    it('removePendingInternalCompactions cancels queued internal compactions and reports the count', async () => {
      const q = new MessageQueue();
      q.start();
      const first = q.enqueueWithId('compact-p1', '/compact', true, {
        durable: true,
        prepend: true,
      });
      const second = q.enqueueWithId('compact-p2', '/compact', true, {
        durable: true,
        prepend: true,
      });
      q.enqueueWithId('prompt-p', 'hello', false, { durable: true });
      expect(q.hasQueuedInternalCompaction()).toBe(true);

      expect(q.removePendingInternalCompactions()).toBe(2);
      expect(q.hasQueuedInternalCompaction()).toBe(false);
      expect(q.hasOutstandingInternalCompaction()).toBe(false);
      await first;
      await second;
      expect(q.removePendingInternalCompactions()).toBe(0);
      q.remove('prompt-p');
      q.stop();
    });
  });
});
