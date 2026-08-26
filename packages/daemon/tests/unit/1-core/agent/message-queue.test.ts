import { beforeEach, describe, expect, it } from 'bun:test';
import { generateUUID } from '@hyperneo/shared';
import { MessageQueue } from '../../../../src/lib/agent/message-queue';

describe('MessageQueue', () => {
  let queue: MessageQueue;
  const testSessionId = generateUUID();

  beforeEach(() => {
    queue = new MessageQueue();
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

    it('hasOutstandingInternalCompaction tracks internal /compact entries across queue, claim, and yield', async () => {
      queue.start();
      expect(queue.hasOutstandingInternalCompaction()).toBe(false);

      const firstFailure = queue.enqueue('/compact', true).catch((error: Error) => error);
      const secondFailure = queue.enqueue('/compact', true).catch((error: Error) => error);
      expect(queue.hasOutstandingInternalCompaction()).toBe(true);
      expect(queue.removePendingInternalCompactions()).toBe(2);
      expect(queue.hasOutstandingInternalCompaction()).toBe(false);

      const yielded = queue.enqueue('/compact', true);
      const generator = queue.messageGenerator(testSessionId);
      await generator.next();
      expect(queue.hasOutstandingInternalCompaction()).toBe(true);
      queue.clear();
      expect(queue.hasOutstandingInternalCompaction()).toBe(false);
      await expect(yielded).resolves.toBeDefined();
      expect((await firstFailure).message).toBe('compaction superseded by model switch');
      expect((await secondFailure).message).toBe('compaction superseded by model switch');
    });

    it('keeps consuming after the queue empties while a delivery gate is pending', async () => {
      queue.start();

      let releaseGate: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        releaseGate = resolve;
      });
      queue.setDeliveryGate(gate);

      let release: ((error: Error) => void) | undefined;
      const compacted = queue.enqueue('/compact', true).catch((error: Error) => {
        release?.(error);
        throw error;
      });
      const superseded = new Promise<Error>((resolve) => {
        release = resolve;
      });
      const generator = queue.messageGenerator(testSessionId);
      const pending = generator.next();

      await new Promise((resolve) => setTimeout(resolve, 5));
      queue.removePendingInternalCompactions();
      releaseGate();

      const followUp = queue.enqueue('Follow-up');
      const result = await pending;
      expect(result.done).toBe(false);
      expect(result.value.message.message.content[0].text).toBe('Follow-up');
      result.value.onSent();
      await followUp;
      expect((await superseded).message).toBe('compaction superseded by model switch');
      await expect(compacted).rejects.toThrow('compaction superseded by model switch');
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

    it('size() counts messages shifted out and yielded but not yet acknowledged', async () => {
      queue.start();
      queue.enqueueWithId('msg-inflight-size', 'Hello');
      const generator = queue.messageGenerator(testSessionId);
      await generator.next();
      expect(queue.size()).toBe(1);
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
  });
});
