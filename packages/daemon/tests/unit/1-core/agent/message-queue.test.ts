import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { generateUUID } from '@hyperneo/shared';
import {
  MessageQueue,
  type MidTurnBudgetInterruptOptions,
} from '../../../../src/lib/agent/message-queue';
import type { Logger } from '../../../../src/lib/logger';

async function tick(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

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
      expect(q.getSentPromptContent('msg-timeout-sent-mark')).toBeUndefined();
      await promise;
      expect(q.getSentPromptContent('msg-timeout-sent-mark')).toBe('hello');
      expect(q.hasOutstandingNonCompactionMessages()).toBe(true);
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
      expect(q.getSentPromptContent('msg-stale-attempt')).toBeUndefined();
      expect(q.hasYielded('msg-stale-attempt')).toBe(true);

      secondStep.value.onSent();
      await delivered;
      expect(settled).toBe(1);
      expect(q.getSentPromptContent('msg-stale-attempt')).toBe('hello');
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
      expect(q.getSentPromptContent('msg-late-onsent')).toBe('hello');

      step.value.onSent();
      await tick(5);
      expect(q.hasPendingOrInFlight('msg-late-onsent')).toBe(false);
      expect(q.getSentPromptContent('msg-late-onsent')).toBe('hello');
      expect(q.size()).toBe(0);
      q.stop();
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
      expect(q.hasOutstandingNonCompactionMessages()).toBe(false);
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

  describe('sent-prompt lifecycle', () => {
    it('remembers sent non-compaction prompts until forgotten or pruned', async () => {
      const q = new MessageQueue();
      q.start();

      const delivery = q.enqueueWithId('prompt-1', 'hello', false, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      const result = await generator.next();
      result.value.onSent();
      await delivery;

      expect(q.getSentPromptContent('prompt-1')).toBe('hello');
      q.forgetSentPrompt('prompt-1');
      expect(q.getSentPromptContent('prompt-1')).toBeUndefined();

      const second = q.enqueueWithId('prompt-2', 'again', false, { durable: true });
      const secondResult = await generator.next();
      secondResult.value.onSent();
      await second;
      expect(q.getSentPromptContent('prompt-2')).toBe('again');
      q.pruneSentPrompts();
      expect(q.getSentPromptContent('prompt-2')).toBeUndefined();
      q.stop();
    });

    it('marks the boundary as having non-compaction sends while prompts were sent', async () => {
      const q = new MessageQueue();
      q.start();

      expect(q.hasOutstandingNonCompactionMessages()).toBe(false);
      const delivery = q.enqueue('user prompt', false, { durable: true });
      expect(q.hasOutstandingNonCompactionMessages()).toBe(true);

      const generator = q.messageGenerator(testSessionId);
      const result = await generator.next();
      result.value.onSent();
      await delivery;
      expect(q.hasOutstandingNonCompactionMessages()).toBe(true);

      q.clearNonCompactionSentSinceBoundary();
      expect(q.hasOutstandingNonCompactionMessages()).toBe(false);
      q.stop();
    });

    it('caps remembered sent prompts at the most recent 32', async () => {
      const q = new MessageQueue();
      q.start();

      const deliveries: Array<Promise<string>> = [];
      for (let i = 0; i < 33; i++) {
        deliveries.push(q.enqueue(`prompt-${i}`, false, { durable: true }));
      }
      const generator = q.messageGenerator(testSessionId);
      for (let i = 0; i < 33; i++) {
        const result = await generator.next();
        result.value.onSent();
      }
      const ids = await Promise.all(deliveries);

      expect(q.getSentPromptContent(ids[0])).toBeUndefined();
      expect(q.getSentPromptContent(ids[1])).toBe('prompt-1');
      expect(q.getSentPromptContent(ids[32])).toBe('prompt-32');
      q.stop();
    });

    it('treats a resent prompt id as the most recent entry', async () => {
      const q = new MessageQueue();
      q.start();

      const deliveries: Array<Promise<void>> = [];
      for (let i = 0; i < 33; i++) {
        deliveries.push(q.enqueueWithId(`prompt-${i}`, `text-${i}`, false, { durable: true }));
      }
      const generator = q.messageGenerator(testSessionId);
      for (let i = 0; i < 33; i++) {
        const result = await generator.next();
        result.value.onSent();
      }
      await Promise.all(deliveries);
      expect(q.getSentPromptContent('prompt-0')).toBeUndefined();

      const resend = q.enqueueWithId('prompt-0', 'text-0-retry', false, { durable: true });
      const resent = await generator.next();
      resent.value.onSent();
      await resend;

      expect(q.getSentPromptContent('prompt-0')).toBe('text-0-retry');
      expect(q.getSentPromptContent('prompt-1')).toBeUndefined();
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

  describe('mid-turn budget interrupt', () => {
    function makeInterruptOpts(
      overrides: Partial<MidTurnBudgetInterruptOptions> = {}
    ): MidTurnBudgetInterruptOptions {
      const logger = {
        info: mock(() => {}),
        warn: mock(() => {}),
      } as unknown as Logger;
      return {
        sessionId: testSessionId,
        providerId: 'openrouter',
        budgetKey: 180_000,
        logger,
        interrupt: async () => ({ still_queued: [] }),
        cancelAsyncMessage: async () => true,
        restart: async () => {},
        contextTracker: {
          markCompactionTriggered: mock(() => {}),
          clearCompactionCooldown: mock(() => {}),
        },
        onResumeArm: mock(() => {}),
        onResumeClear: mock(() => {}),
        ...overrides,
      };
    }

    it('requeues a cancelled survivor durably under its original id', async () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'uuid-a',
        content: 'finish the deploy',
        internal: false,
      } as never);
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-a'] }),
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-a', 'finish the deploy', false, {
        durable: true,
        prepend: true,
      });
      q.stop();
    });

    it('cancels survivors despite an outstanding queued compaction and skips a duplicate one', async () => {
      const q = new MessageQueue();
      q.start();
      const queued = q.enqueueWithId('compact-queued', '/compact', true, { durable: true });
      expect(q.hasOutstandingInternalCompaction()).toBe(true);
      q.noteInternalCompactionSent({
        id: 'uuid-c',
        content: 'ship the release',
        internal: false,
      } as never);
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-c'] }),
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-c', 'ship the release', false, {
        durable: true,
        prepend: true,
      });
      expect(enqueueSpy.mock.calls.some((call) => call[1] === '/compact')).toBe(false);
      q.stop();
      queued.catch(() => {});
    });

    it('replaces a revoked still-queued compaction with a fresh durable prepend one', async () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'compact-sent',
        content: '/compact',
        internal: true,
      } as never);
      expect(q.hasOutstandingInternalCompaction()).toBe(true);
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['compact-sent'] }),
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(enqueueSpy.mock.calls.some((call) => call[0] === 'compact-sent')).toBe(false);
      const compactCall = enqueueSpy.mock.calls.find((call) => call[1] === '/compact');
      expect(compactCall).toBeDefined();
      expect(compactCall?.[2]).toBe(true);
      expect(compactCall?.[3]).toEqual({ durable: true, prepend: true });
      q.stop();
    });

    it('enqueues a durable prepend compaction when no survivors are reported', async () => {
      const q = new MessageQueue();
      q.start();
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const opts = makeInterruptOpts({ interrupt: async () => undefined });

      await q.runMidTurnBudgetInterrupt(opts);

      const compactCall = enqueueSpy.mock.calls.find((call) => call[1] === '/compact');
      expect(compactCall).toBeDefined();
      expect(compactCall?.[2]).toBe(true);
      expect(compactCall?.[3]).toEqual({ durable: true, prepend: true });
      q.stop();
    });

    it('clears the pending resume and cooldown when the recovery restart fails', async () => {
      const q = new MessageQueue();
      q.start();
      const onResumeClear = mock(() => {});
      const clearCompactionCooldown = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-r'] }),
        cancelAsyncMessage: async () => false,
        restart: () => Promise.reject(new Error('restart failed')),
        onResumeClear,
        contextTracker: {
          markCompactionTriggered: mock(() => {}),
          clearCompactionCooldown,
        },
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(onResumeClear).toHaveBeenCalledTimes(1);
      expect(clearCompactionCooldown).toHaveBeenCalledTimes(1);
      q.stop();
    });

    it('requeues survivors that follow an unconfirmed cancellation before restarting', async () => {
      const q = new MessageQueue();
      q.start();

      const sentA = q.enqueueWithId('uuid-a', 'prompt-a', false, { durable: true });
      const sentB = q.enqueueWithId('uuid-b', 'prompt-b', false, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      (await generator.next()).value.onSent();
      await Promise.all([sentA, sentB]);

      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const restartMock = mock(async () => {});
      const cancelCalls = mock(async (uuid: string) => uuid === 'uuid-b');
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-a', 'uuid-b'] }),
        cancelAsyncMessage: cancelCalls,
        restart: restartMock,
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-a', 'prompt-a', false, {
        durable: true,
        prepend: true,
      });
      expect(enqueueSpy).toHaveBeenCalledWith('uuid-b', 'prompt-b', false, {
        durable: true,
        prepend: true,
      });
      expect(cancelCalls).toHaveBeenCalledTimes(1);
      expect(restartMock).toHaveBeenCalledTimes(1);
      q.stop();
    });

    it('gates delivery for the whole interrupt window', async () => {
      const q = new MessageQueue();
      q.start();
      let releaseInterrupt: (receipt: { still_queued: string[] }) => void = () => {};
      const interruptGate = new Promise<{ still_queued: string[] }>((resolve) => {
        releaseInterrupt = resolve;
      });
      const opts = makeInterruptOpts({
        interrupt: () => interruptGate,
      });
      void q.enqueue('prompt-during-interrupt', false, {}).catch(() => {});

      const run = q.runMidTurnBudgetInterrupt(opts);
      const generator = q.messageGenerator(testSessionId);
      const first = generator.next();
      const yieldedEarly = await Promise.race([
        first.then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 100);
          if (typeof timer.unref === 'function') {
            timer.unref();
          }
        }),
      ]);
      expect(yieldedEarly).toBe(false);

      releaseInterrupt({ still_queued: [] });
      await run;
      expect(first).resolves.toBeDefined();
      q.stop();
    });

    it('requeues survivors before restarting when cancellation is unavailable', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueueWithId('uuid-no-cancel', 'prompt-no-cancel', false, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const restartMock = mock(async () => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-no-cancel'] }),
        cancelAsyncMessage: undefined,
        restart: restartMock,
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-no-cancel', 'prompt-no-cancel', false, {
        durable: true,
        prepend: true,
      });
      expect(restartMock).toHaveBeenCalledTimes(1);
      q.stop();
    });

    it('reinserts survivors ahead of prompts admitted during the interrupt window', async () => {
      const q = new MessageQueue();
      q.start();
      const sentA = q.enqueueWithId('uuid-a', 'prompt-a', false, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sentA;
      void q.enqueue('prompt-b-arrived-late', false, { durable: true }).catch(() => {});
      const enqueueSpy = spyOn(q, 'enqueueWithId');
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-a'] }),
        cancelAsyncMessage: async () => true,
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-a', 'prompt-a', false, {
        durable: true,
        prepend: true,
      });
      const replay = q.messageGenerator(testSessionId);
      const first = await replay.next();
      expect((first.value.message.message.content as Array<{ text?: string }>)[0].text).toBe(
        '/compact'
      );
      first.value.onSent();
      q.acknowledgeCompactionsAwaitingBoundary();
      const second = await replay.next();
      expect((second.value.message.message.content as Array<{ text?: string }>)[0].text).toBe(
        'prompt-a'
      );
      second.value.onSent();
      const third = await replay.next();
      expect((third.value.message.message.content as Array<{ text?: string }>)[0].text).toBe(
        'prompt-b-arrived-late'
      );
      third.value.onSent();
      q.stop();
    });

    it('warns when a cancelled survivor has no recoverable content', async () => {
      const q = new MessageQueue();
      q.start();
      const warnMock = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-phantom'] }),
        cancelAsyncMessage: async () => true,
        logger: { info: mock(() => {}), warn: warnMock } as never,
      });
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);

      await q.runMidTurnBudgetInterrupt(opts);

      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(String((warnMock.mock.calls[0] as unknown[])[0])).toContain('no recoverable content');
      expect(enqueueSpy.mock.calls.some((call) => call[0] === 'uuid-phantom')).toBe(false);
      q.stop();
    });

    it('does not restart the replacement query when a late receipt cannot cancel', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueueWithId('uuid-late-norestart', 'late-survivor', false, {
        durable: true,
      });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      let resolveInterrupt: (receipt: { still_queued: string[] }) => void = () => {};
      const slowInterrupt = new Promise<{ still_queued: string[] }>((resolve) => {
        resolveInterrupt = resolve;
      });
      const restartMock = mock(async () => {});
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const opts = makeInterruptOpts({
        interrupt: () => slowInterrupt,
        cancelAsyncMessage: async () => false,
        restart: restartMock,
      });

      const run = q.runMidTurnBudgetInterrupt(opts);
      await tick(5_200);
      resolveInterrupt({ still_queued: ['uuid-late-norestart'] });
      await run;
      await tick(50);

      expect(restartMock).toHaveBeenCalledTimes(1);
      expect(enqueueSpy).toHaveBeenCalledWith('uuid-late-norestart', 'late-survivor', false, {
        durable: true,
        prepend: true,
      });
      q.stop();
    }, 15_000);

    it('keeps the compaction protocol when the retryable-state update throws', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueueWithId('uuid-throw-cb', 'survivor-cb', false, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const warnMock = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-throw-cb'] }),
        cancelAsyncMessage: async () => true,
        onSurvivorRequeued: () => {
          throw new Error('sqlite busy');
        },
        logger: { info: mock(() => {}), warn: warnMock } as never,
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-throw-cb', 'survivor-cb', false, {
        durable: true,
        prepend: true,
      });
      expect(enqueueSpy.mock.calls.some((call) => call[1] === '/compact')).toBe(true);
      q.stop();
    });

    it('stands down when the user stops the turn during the interrupt', async () => {
      const q = new MessageQueue();
      q.start();
      const onResumeClear = mock(() => {});
      const restartMock = mock(async () => {});
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const opts = makeInterruptOpts({
        interrupt: async () => {
          q.stop();
          return { still_queued: ['uuid-stopped'] };
        },
        restart: restartMock,
        onResumeClear,
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(onResumeClear).toHaveBeenCalledTimes(1);
      expect(restartMock).not.toHaveBeenCalled();
      expect(enqueueSpy).not.toHaveBeenCalled();
    });

    it('stands down when the user stops the turn during survivor cancellation', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueueWithId('uuid-stop-cancel', 'survivor-stop', false, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const restartMock = mock(async () => {});
      const onResumeClear = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-stop-cancel'] }),
        cancelAsyncMessage: async () => {
          q.stop();
          return true;
        },
        restart: restartMock,
        onResumeClear,
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(enqueueSpy.mock.calls.some((call) => call[0] === 'uuid-stop-cancel')).toBe(false);
      expect(enqueueSpy.mock.calls.some((call) => call[1] === '/compact')).toBe(false);
      expect(restartMock).not.toHaveBeenCalled();
      expect(onResumeClear).toHaveBeenCalledTimes(1);
    });

    it('holds delivery behind a gate while survivors are cancelled and requeued', async () => {
      const q = new MessageQueue();
      q.start();
      let releaseCancel: () => void = () => {};
      q.noteInternalCompactionSent({
        id: 'uuid-g',
        content: 'gated work',
        internal: false,
      } as never);
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-g'] }),
        cancelAsyncMessage: async () => {
          await new Promise<void>((resolve) => {
            releaseCancel = resolve;
          });
          return true;
        },
      });

      let delivered = false;
      const run = q.runMidTurnBudgetInterrupt(opts);
      const consumer = (async () => {
        for await (const entry of q.messageGenerator(testSessionId)) {
          delivered = true;
          entry.onSent();
          break;
        }
      })();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(delivered).toBe(false);

      releaseCancel();
      await run;
      await consumer;
      expect(delivered).toBe(true);
      q.stop();
    });

    it('requeues messages the SDK already cancelled without re-cancelling them', async () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'uuid-sdk-cancelled',
        content: 'already cancelled work',
        internal: false,
      } as never);
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const cancelMock = mock(async () => true);
      const restartMock = mock(async () => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: [], cancelled: ['uuid-sdk-cancelled'] }),
        cancelAsyncMessage: cancelMock,
        restart: restartMock,
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(cancelMock).not.toHaveBeenCalled();
      expect(restartMock).not.toHaveBeenCalled();
      expect(enqueueSpy).toHaveBeenCalledWith(
        'uuid-sdk-cancelled',
        'already cancelled work',
        false,
        {
          durable: true,
          prepend: true,
        }
      );
      q.stop();
    });

    it('requeues a survivor whose content was evicted from the sent-prompt LRU', async () => {
      const q = new MessageQueue();
      q.start();
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const requeuedCallback = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-evicted'] }),
        cancelAsyncMessage: async () => true,
        getDurableMessageContent: (uuid: string) =>
          uuid === 'uuid-evicted' ? 'db-recovered-content' : undefined,
        onSurvivorRequeued: requeuedCallback,
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-evicted', 'db-recovered-content', false, {
        durable: true,
        prepend: true,
      });
      expect(requeuedCallback).toHaveBeenCalledWith('uuid-evicted');
      q.stop();
    });

    it('recovers a yielded pre-acknowledgment survivor from its live queue entry', async () => {
      const q = new MessageQueue();
      q.start();
      const delivered = q.enqueueWithId('uuid-yielded', 'pending tool result', false, {});
      delivered.catch(() => {});
      const generator = q.messageGenerator(testSessionId);
      const step = await generator.next();
      expect(step.value.message.uuid).toBe('uuid-yielded');
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const requeuedCallback = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-yielded'] }),
        onSurvivorRequeued: requeuedCallback,
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(enqueueSpy).not.toHaveBeenCalledWith(
        'uuid-yielded',
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
      expect(requeuedCallback).toHaveBeenCalledWith('uuid-yielded');
      expect(q.hasPendingOrClaimed('uuid-yielded')).toBe(true);
      q.clear();
      q.stop();
    });

    it('marks a requeued yielded survivor durable so its timeout resolves', async () => {
      const q = new MessageQueue();
      q.start();
      const delivered = q.enqueueWithId('uuid-durable-move', 'durable survivor', false, {});
      const generator = q.messageGenerator(testSessionId);
      const first = await generator.next();
      expect(first.value.message.uuid).toBe('uuid-durable-move');
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-durable-move'] }),
      });

      await q.runMidTurnBudgetInterrupt(opts);

      q.overrideTimeoutMsForTest(20);
      const second = await generator.next();
      expect(second.value.message.uuid).toBe('uuid-durable-move');

      const outcome = await Promise.race([
        delivered.then(
          () => 'resolved',
          () => 'rejected'
        ),
        tick(150).then(() => 'pending'),
      ]);
      expect(outcome).toBe('resolved');
      expect(enqueueSpy.mock.calls.some((call) => call[0] === 'uuid-durable-move')).toBe(false);
      q.stop();
    });

    it('ignores a stale send acknowledgment from the previous generator after a requeue', async () => {
      const q = new MessageQueue();
      q.start();
      const delivered = q.enqueueWithId('uuid-stale-ack', 'stale ack survivor', false, {
        durable: true,
      });
      delivered.catch(() => {});
      const firstGenerator = q.messageGenerator(testSessionId);
      const firstStep = await firstGenerator.next();
      expect(firstStep.value.message.uuid).toBe('uuid-stale-ack');
      const staleOnSent = firstStep.value.onSent;
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-stale-ack'] }),
      });

      await q.runMidTurnBudgetInterrupt(opts);

      const secondGenerator = q.messageGenerator(testSessionId);
      const secondStep = await secondGenerator.next();
      expect(secondStep.value.message.uuid).toBe('uuid-stale-ack');

      staleOnSent();

      let settled = false;
      void delivered.then(() => {
        settled = true;
      });
      await tick(10);
      expect(settled).toBe(false);

      secondStep.value.onSent();
      await delivered;
      expect(
        enqueueSpy.mock.calls.some(
          (call) => call[0] === 'uuid-stale-ack' && call[3]?.prepend === true
        )
      ).toBe(false);
      q.stop();
    });

    it('keeps the compaction protocol when the durable content lookup throws', async () => {
      const q = new MessageQueue();
      q.start();
      const warnMock = mock(() => {});
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-lookup-throw'] }),
        cancelAsyncMessage: async () => true,
        getDurableMessageContent: () => {
          throw new Error('sqlite locked');
        },
        logger: { info: mock(() => {}), warn: warnMock } as never,
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(
        warnMock.mock.calls.some((call) =>
          String((call as unknown[])[0]).includes('durable content lookup for survivor')
        )
      ).toBe(true);
      expect(enqueueSpy.mock.calls.some((call) => call[1] === '/compact')).toBe(true);
      q.stop();
    });

    it('preserves a late receipt after the recovery restart fails', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueueWithId('uuid-late-failed', 'late-survivor', false, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      let releaseInterrupt: (receipt: { still_queued: string[] }) => void = () => {};
      const slowInterrupt = new Promise<{ still_queued: string[] }>((resolve) => {
        releaseInterrupt = resolve;
      });
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const opts = makeInterruptOpts({
        interrupt: () => slowInterrupt,
        cancelAsyncMessage: async () => true,
        restart: async (options) => {
          q.stop();
          await options?.beforeStart?.();
          throw new Error('restart failed');
        },
      });

      const run = q.runMidTurnBudgetInterrupt(opts);
      await tick(5_200);
      releaseInterrupt({ still_queued: ['uuid-late-failed'] });
      await run;
      await tick(50);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-late-failed', 'late-survivor', false, {
        durable: true,
        prepend: true,
      });
      expect(enqueueSpy.mock.calls.some((call) => call[1] === '/compact')).toBe(true);
    }, 15_000);

    it('preserves a late receipt after its own recovery restart replaced the query', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueueWithId('uuid-own-restart', 'own-restart-survivor', false, {
        durable: true,
      });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      let releaseInterrupt: (receipt: { still_queued: string[] }) => void = () => {};
      const slowInterrupt = new Promise<{ still_queued: string[] }>((resolve) => {
        releaseInterrupt = resolve;
      });
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      let ownsTurn = true;
      const opts = makeInterruptOpts({
        interrupt: () => slowInterrupt,
        cancelAsyncMessage: async () => true,
        ownsTurn: () => ownsTurn,
        restart: async (options) => {
          ownsTurn = false;
          await options?.beforeStart?.();
        },
      });

      const run = q.runMidTurnBudgetInterrupt(opts);
      await tick(5_200);
      releaseInterrupt({ still_queued: ['uuid-own-restart'] });
      await run;
      await tick(50);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-own-restart', 'own-restart-survivor', false, {
        durable: true,
        prepend: true,
      });
    }, 15_000);

    it('stands down when turn ownership changed during the interrupt', async () => {
      const q = new MessageQueue();
      q.start();
      let owns = true;
      const onResumeClear = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-ownership'] }),
        cancelAsyncMessage: async () => true,
        ownsTurn: () => owns,
        onResumeClear,
      });
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      owns = false;

      await q.runMidTurnBudgetInterrupt(opts);

      expect(enqueueSpy).not.toHaveBeenCalled();
      expect(onResumeClear).toHaveBeenCalledTimes(1);
      q.stop();
    });

    it('keeps delivery gated until the recovery restart settles', async () => {
      const q = new MessageQueue();
      q.start();
      let releaseRestart: () => void = () => {};
      const restartGate = new Promise<void>((resolve) => {
        releaseRestart = resolve;
      });
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-s'] }),
        cancelAsyncMessage: async () => false,
        restart: mock(() => restartGate),
      });
      const runPromise = q.runMidTurnBudgetInterrupt(opts);
      await tick(30);
      q.releaseEarlyDeliveryGate(opts);
      const delivered = q.enqueueWithId('uuid-gated', 'content', false, {});
      delivered.catch(() => {});
      const generator = q.messageGenerator(testSessionId);
      let got: { done: boolean; value: { message: { uuid: string }; onSent: () => void } } | null =
        null;
      const nextPromise = generator.next().then((entry) => {
        got = entry;
      });
      await tick(30);
      expect(got).toBeNull();

      releaseRestart();
      await runPromise;
      await nextPromise;
      expect(got?.value.message.uuid).toBe('uuid-gated');
      got?.value.onSent();
      await delivered;
      q.stop();
    });

    it('aborts the recovery restart replacement when a user stop lands before it starts', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueueWithId('uuid-stop-abort', 'stop-abort-survivor', false, {
        durable: true,
      });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const onResumeClear = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-stop-abort'] }),
        cancelAsyncMessage: async () => false,
        restart: async (options) => {
          q.stop();
          q.clear();
          await options?.beforeStart?.();
        },
        onResumeClear,
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-stop-abort', 'stop-abort-survivor', false, {
        durable: true,
        prepend: true,
      });
      expect(enqueueSpy.mock.calls.some((call) => call[1] === '/compact')).toBe(false);
      expect(onResumeClear).toHaveBeenCalledTimes(1);
      expect(q.hasPendingOrClaimed('uuid-stop-abort')).toBe(false);
    });

    it('removes a durably requeued survivor without mocking the enqueue', async () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'uuid-real-enqueue',
        content: 'real survivor',
        internal: false,
      } as never);
      const onResumeClear = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-real-enqueue'] }),
        cancelAsyncMessage: async () => false,
        restart: async (options) => {
          q.stop();
          q.clear();
          await options?.beforeStart?.();
        },
        onResumeClear,
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(q.hasPendingOrClaimed('uuid-real-enqueue')).toBe(false);
      expect(onResumeClear).toHaveBeenCalledTimes(1);
    });

    it('does not abort the recovery restart on its own teardown stops', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueueWithId('uuid-teardown-stops', 'teardown-survivor', false, {
        durable: true,
      });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const onResumeClear = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-teardown-stops'] }),
        cancelAsyncMessage: async () => false,
        restart: async (options) => {
          q.stop();
          q.stop();
          q.stop();
          await options?.beforeStart?.();
          q.start();
        },
        onResumeClear,
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-teardown-stops', 'teardown-survivor', false, {
        durable: true,
        prepend: true,
      });
      expect(enqueueSpy.mock.calls.some((call) => call[1] === '/compact')).toBe(true);
      expect(onResumeClear).not.toHaveBeenCalled();
      q.stop();
    });

    it('aborts the recovery restart when a user interrupt lands with an empty queue', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueueWithId('uuid-empty-stop', 'empty-queue-survivor', false, {
        durable: true,
      });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const onResumeClear = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-empty-stop'] }),
        cancelAsyncMessage: async () => false,
        restart: async (options) => {
          q.stop();
          q.noteUserInterrupt();
          await options?.beforeStart?.();
        },
        onResumeClear,
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-empty-stop', 'empty-queue-survivor', false, {
        durable: true,
        prepend: true,
      });
      expect(enqueueSpy.mock.calls.some((call) => call[1] === '/compact')).toBe(false);
      expect(onResumeClear).toHaveBeenCalledTimes(1);
    });

    it('keeps the recovery fence when a later cycle arms on the same replacement', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueueWithId('uuid-fence-keep', 'fence-survivor', false, {
        durable: true,
      });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      let releaseInterrupt: (receipt: { still_queued: string[] }) => void = () => {};
      const slowInterrupt = new Promise<{ still_queued: string[] }>((resolve) => {
        releaseInterrupt = resolve;
      });
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      let ownsTurn = true;
      const onResumeClear = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: () => slowInterrupt,
        cancelAsyncMessage: async () => true,
        ownsTurn: () => ownsTurn,
        onResumeClear,
        restart: async (options) => {
          q.stop();
          ownsTurn = false;
          await options?.beforeStart?.();
          q.start();
        },
      });

      const run = q.runMidTurnBudgetInterrupt(opts);
      await tick(5_200);
      q.armInterruptCycle(makeInterruptOpts({}));
      releaseInterrupt({ still_queued: ['uuid-fence-keep'] });
      await run;
      await tick(50);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-fence-keep', 'fence-survivor', false, {
        durable: true,
        prepend: true,
      });
      expect(onResumeClear).not.toHaveBeenCalled();
      q.stop();
    }, 15_000);

    it('stands requeued work down when a user stop lands after beforeStart', async () => {
      const q = new MessageQueue();
      q.start();
      const onResumeClear = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-post-gap'] }),
        cancelAsyncMessage: async () => false,
        restart: async (options) => {
          q.stop();
          await options?.beforeStart?.();
          q.noteUserInterrupt();
          q.start();
        },
        onResumeClear,
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(onResumeClear).toHaveBeenCalled();
      expect(q.size()).toBe(0);
      q.stop();
    });

    it('stands down a late receipt after the recovery restart was aborted by a user stop', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueueWithId('uuid-aborted-latch', 'aborted-survivor', false, {
        durable: true,
      });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      let releaseInterrupt: (receipt: { still_queued: string[] }) => void = () => {};
      const slowInterrupt = new Promise<{ still_queued: string[] }>((resolve) => {
        releaseInterrupt = resolve;
      });
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      let ownsTurn = true;
      const onResumeClear = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: () => slowInterrupt,
        cancelAsyncMessage: async () => true,
        ownsTurn: () => ownsTurn,
        onResumeClear,
        restart: async (options) => {
          q.stop();
          ownsTurn = false;
          q.clear();
          await options?.beforeStart?.();
        },
      });

      const run = q.runMidTurnBudgetInterrupt(opts);
      await tick(5_200);
      q.start();
      releaseInterrupt({ still_queued: ['uuid-aborted-latch'] });
      await run;
      await tick(50);

      expect(enqueueSpy.mock.calls.some((call) => call[0] === 'uuid-aborted-latch')).toBe(false);
      expect(onResumeClear).toHaveBeenCalled();
      q.stop();
    }, 15_000);

    it('stands requeued work down when a user stop lands while the restart is still settling', async () => {
      const q = new MessageQueue();
      q.start();
      let releaseRestart: () => void = () => {};
      const restartHang = new Promise<void>((resolve) => {
        releaseRestart = resolve;
      });
      const onResumeClear = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-slow-restart'] }),
        cancelAsyncMessage: async () => false,
        restart: async (options) => {
          q.stop();
          await options?.beforeStart?.();
          await restartHang;
          q.start();
        },
        onResumeClear,
      });

      const run = q.runMidTurnBudgetInterrupt(opts);
      await tick(5_400);
      q.noteUserInterrupt();
      releaseRestart();
      await run;
      await tick(50);

      expect(onResumeClear).toHaveBeenCalled();
      expect(q.size()).toBe(0);
      q.stop();
    }, 15_000);

    it('stands down a late receipt after a failed restart when a new query has started', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueueWithId('uuid-failed-latch', 'failed-survivor', false, {
        durable: true,
      });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      let releaseInterrupt: (receipt: { still_queued: string[] }) => void = () => {};
      const slowInterrupt = new Promise<{ still_queued: string[] }>((resolve) => {
        releaseInterrupt = resolve;
      });
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      let ownsTurn = true;
      const onResumeClear = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: () => slowInterrupt,
        cancelAsyncMessage: async () => true,
        ownsTurn: () => ownsTurn,
        onResumeClear,
        restart: async (options) => {
          q.stop();
          ownsTurn = false;
          await options?.beforeStart?.();
          throw new Error('restart failed');
        },
      });

      const run = q.runMidTurnBudgetInterrupt(opts);
      await tick(5_200);
      q.start();
      releaseInterrupt({ still_queued: ['uuid-failed-latch'] });
      await run;
      await tick(50);

      expect(enqueueSpy.mock.calls.some((call) => call[0] === 'uuid-failed-latch')).toBe(false);
      expect(onResumeClear).toHaveBeenCalled();
      q.stop();
    }, 15_000);

    it('stands down a late receipt after a user stop follows a failed restart', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueueWithId('uuid-failed-stop', 'failed-stop-survivor', false, {
        durable: true,
      });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      let releaseInterrupt: (receipt: { still_queued: string[] }) => void = () => {};
      const slowInterrupt = new Promise<{ still_queued: string[] }>((resolve) => {
        releaseInterrupt = resolve;
      });
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const onResumeClear = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: () => slowInterrupt,
        cancelAsyncMessage: async () => true,
        onResumeClear,
        restart: async (options) => {
          q.stop();
          await options?.beforeStart?.();
          throw new Error('restart failed');
        },
      });

      const run = q.runMidTurnBudgetInterrupt(opts);
      await tick(5_200);
      q.noteUserInterrupt();
      q.clear();
      releaseInterrupt({ still_queued: ['uuid-failed-stop'] });
      await run;
      await tick(50);

      expect(enqueueSpy.mock.calls.some((call) => call[0] === 'uuid-failed-stop')).toBe(false);
      expect(q.size()).toBe(0);
      expect(onResumeClear).toHaveBeenCalled();
      q.stop();
    }, 15_000);

    it('wakes a waiting generator when a yielded survivor is requeued', async () => {
      const q = new MessageQueue();
      q.start();
      const delivered = q.enqueueWithId('uuid-wake', 'wake survivor', false, {
        durable: true,
      });
      delivered.catch(() => {});
      const generator = q.messageGenerator(testSessionId);
      const first = await generator.next();
      expect(first.value.message.uuid).toBe('uuid-wake');
      const secondPromise = generator.next();
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-wake'] }),
      });

      await q.runMidTurnBudgetInterrupt(opts);

      const second = await Promise.race([secondPromise, tick(200).then(() => null)]);
      expect(second?.value?.message.uuid).toBe('uuid-wake');
      second?.value.onSent();
      await delivered;
      expect(
        enqueueSpy.mock.calls.some((call) => call[0] === 'uuid-wake' && call[3]?.prepend === true)
      ).toBe(false);
      q.stop();
    });

    it('fences uuid acknowledgments by the yielding query generation', async () => {
      const q = new MessageQueue();
      q.start();
      const delivered = q.enqueueWithId('uuid-gen-ack', 'gen survivor', false, {
        durable: true,
      });
      delivered.catch(() => {});
      const oldGenerator = q.messageGenerator(testSessionId, { queryGeneration: 4 });
      const oldStep = await oldGenerator.next();
      expect(oldStep.value.message.uuid).toBe('uuid-gen-ack');
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-gen-ack'] }),
      });

      await q.runMidTurnBudgetInterrupt(opts);

      const newGenerator = q.messageGenerator(testSessionId, { queryGeneration: 5 });
      const newStep = await newGenerator.next();
      expect(newStep.value.message.uuid).toBe('uuid-gen-ack');

      expect(q.acknowledgeYielded('uuid-gen-ack', 4)).toBe(false);
      let settled = false;
      void delivered.then(() => {
        settled = true;
      });
      await tick(10);
      expect(settled).toBe(false);

      expect(q.acknowledgeYielded('uuid-gen-ack', 5)).toBe(true);
      await delivered;
      q.stop();
    });

    it('retains the yield generation for turn-end acknowledgment after a send', async () => {
      const q = new MessageQueue();
      q.start();
      const delivered = q.enqueueWithId('uuid-gen-retained', 'retained survivor', false, {
        durable: true,
      });
      delivered.catch(() => {});
      const oldGenerator = q.messageGenerator(testSessionId, { queryGeneration: 4 });
      const oldStep = await oldGenerator.next();
      expect(oldStep.value.message.uuid).toBe('uuid-gen-retained');
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      await q.runMidTurnBudgetInterrupt(
        makeInterruptOpts({
          interrupt: async () => ({ still_queued: ['uuid-gen-retained'] }),
        })
      );

      const newGenerator = q.messageGenerator(testSessionId, { queryGeneration: 5 });
      const newStep = await newGenerator.next();
      expect(newStep.value.message.uuid).toBe('uuid-gen-retained');
      newStep.value.onSent();

      expect(q.ownsYieldedGeneration('uuid-gen-retained', 4)).toBe(false);
      expect(q.ownsYieldedGeneration('uuid-gen-retained', 5)).toBe(true);
      expect(enqueueSpy.mock.calls.some((call) => call[0] === 'uuid-gen-retained')).toBe(false);
      q.stop();
    });

    it('fences direct persisted-user acknowledgments after the yielding query stopped', async () => {
      const q = new MessageQueue();
      q.start();
      const delivered = q.enqueueWithId('uuid-direct-ack', 'direct survivor', false, {
        durable: true,
      });
      delivered.catch(() => {});
      const generator = q.messageGenerator(testSessionId, { queryGeneration: 6 });
      const step = await generator.next();
      expect(step.value.message.uuid).toBe('uuid-direct-ack');

      expect(q.ownsLastYield('uuid-direct-ack', 6)).toBe(true);
      q.stop();
      expect(q.ownsLastYield('uuid-direct-ack', 6)).toBe(false);
      expect(q.ownsLastYield('uuid-direct-ack', null)).toBe(true);
      expect(q.ownsLastYield('uuid-never-yielded', 6)).toBe(true);
      q.clear();
      expect(q.ownsLastYield('uuid-direct-ack', 6)).toBe(false);
    });

    it('scopes a deferred early-gate release to the cycle that requested it', async () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'uuid-scope-1',
        content: 'scope survivor 1',
        internal: false,
      } as never);
      q.noteInternalCompactionSent({
        id: 'uuid-scope-2',
        content: 'scope survivor 2',
        internal: false,
      } as never);
      let releaseFirst: () => void = () => {};
      const firstHang = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let releaseSecond: () => void = () => {};
      const secondHang = new Promise<void>((resolve) => {
        releaseSecond = resolve;
      });
      const firstOpts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-scope-1'] }),
        cancelAsyncMessage: async () => false,
        restart: async () => {
          await firstHang;
        },
      });
      const secondOpts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-scope-2'] }),
        cancelAsyncMessage: async () => false,
        restart: async () => {
          await secondHang;
        },
      });

      const first = q.runMidTurnBudgetInterrupt(firstOpts);
      await tick(30);
      q.releaseEarlyDeliveryGate(firstOpts);
      const second = q.runMidTurnBudgetInterrupt(secondOpts);
      await tick(50);

      releaseFirst();
      await tick(100);
      releaseSecond();
      await Promise.all([first, second]);
      await tick(100);

      const generator = q.messageGenerator(testSessionId);
      const step = await Promise.race([generator.next(), tick(200).then(() => null)]);
      expect(step?.value?.message).toBeDefined();
      q.stop();
    }, 15_000);

    it('preserves fresh work in the delayed stand-down when turn ownership moved on', async () => {
      const q = new MessageQueue();
      q.start();
      let releaseRestart: () => void = () => {};
      const restartHang = new Promise<void>((resolve) => {
        releaseRestart = resolve;
      });
      let ownsTurn = true;
      const onResumeClear = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-delayed-own'] }),
        cancelAsyncMessage: async () => false,
        ownsTurn: () => ownsTurn,
        restart: async (options) => {
          q.stop();
          await options?.beforeStart?.();
          await restartHang;
          q.start();
        },
        onResumeClear,
      });

      const run = q.runMidTurnBudgetInterrupt(opts);
      await tick(5_400);
      q.noteUserInterrupt();
      const fresh = q.enqueueWithId('uuid-fresh-work', 'fresh user work', false, {
        durable: true,
      });
      fresh.catch(() => {});
      ownsTurn = false;
      releaseRestart();
      await run;
      await tick(50);

      expect(q.hasPendingOrClaimed('uuid-fresh-work')).toBe(true);
      expect(onResumeClear).toHaveBeenCalled();
      q.stop();
    }, 15_000);

    it('stands the cycle down when the restart fails before any teardown', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueueWithId('uuid-no-teardown', 'no-teardown-survivor', false, {
        durable: true,
      });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      let releaseInterrupt: (receipt: { still_queued: string[] }) => void = () => {};
      const slowInterrupt = new Promise<{ still_queued: string[] }>((resolve) => {
        releaseInterrupt = resolve;
      });
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const onResumeClear = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: () => slowInterrupt,
        cancelAsyncMessage: async () => true,
        onResumeClear,
        restart: async () => {
          throw new Error('session.errorClear rejected');
        },
      });

      const run = q.runMidTurnBudgetInterrupt(opts);
      await tick(5_200);
      releaseInterrupt({ still_queued: ['uuid-no-teardown'] });
      await run;
      await tick(50);

      expect(enqueueSpy.mock.calls.some((call) => call[0] === 'uuid-no-teardown')).toBe(false);
      expect(enqueueSpy.mock.calls.some((call) => call[1] === '/compact')).toBe(false);
      expect(onResumeClear).toHaveBeenCalled();
      expect(q.isRunning()).toBe(true);
      expect(q.hasPendingOrClaimed('uuid-no-teardown')).toBe(false);
      q.stop();
    }, 15_000);

    it('aborts the restart when a user stop lands during survivor cancellation', async () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'uuid-arm-stop',
        content: 'arm stop survivor',
        internal: false,
      } as never);
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const onResumeClear = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-arm-stop'] }),
        cancelAsyncMessage: async () => {
          q.noteUserInterrupt();
          return false;
        },
        onResumeClear,
        restart: async (options) => {
          q.stop();
          await options?.beforeStart?.();
          q.start();
        },
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(enqueueSpy.mock.calls.some((call) => call[1] === '/compact')).toBe(false);
      expect(onResumeClear).toHaveBeenCalled();
      q.stop();
    });

    it('quarantines recovered entries behind the gate until a slow restart settles', async () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'uuid-quarantine',
        content: 'quarantine survivor',
        internal: false,
      } as never);
      let releaseRestart: () => void = () => {};
      const restartHang = new Promise<void>((resolve) => {
        releaseRestart = resolve;
      });
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-quarantine'] }),
        cancelAsyncMessage: async () => false,
        restart: async (options) => {
          q.stop();
          await options?.beforeStart?.();
          await restartHang;
          q.start();
        },
      });

      const run = q.runMidTurnBudgetInterrupt(opts);
      await tick(5_400);
      q.noteUserInterrupt();
      q.start();
      const generator = q.messageGenerator(testSessionId);
      const bypassing = await generator.next();
      bypassing.value.onSent();
      q.acknowledgeCompactionsAwaitingBoundary();
      let got: { done: boolean; value: { message: { uuid: string } } } | null = null;
      void generator.next().then((entry) => {
        got = entry;
      });
      await tick(150);
      expect(got).toBeNull();

      releaseRestart();
      await run;
      await tick(50);

      expect(q.hasPendingOrClaimed('uuid-quarantine')).toBe(false);
      q.stop();
    }, 15_000);

    it('removes restored survivors when an immediate receipt precedes a pre-teardown failure', async () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'uuid-imm-fail',
        content: 'immediate survivor',
        internal: false,
      } as never);
      const onResumeClear = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-imm-fail'] }),
        cancelAsyncMessage: async () => false,
        restart: async () => {
          throw new Error('session.errorClear rejected');
        },
        onResumeClear,
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(q.hasPendingOrClaimed('uuid-imm-fail')).toBe(false);
      expect(onResumeClear).toHaveBeenCalled();
      expect(q.isRunning()).toBe(true);
    });

    it('keeps failed-restart recovery across unrelated boundaries until its compaction is sent', async () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'uuid-boundary-bind',
        content: 'boundary survivor',
        internal: false,
      } as never);
      const opts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-boundary-bind'] }),
        cancelAsyncMessage: async () => false,
        restart: async () => {
          q.stop();
          throw new Error('restart failed');
        },
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(q.shouldEnqueueLateCompaction(0)).toBe(true);
      q.noteBoundaryCompleted();
      expect(q.shouldEnqueueLateCompaction(0)).toBe(true);
      q.noteInternalCompactionSent({
        id: 'uuid-recovery-compact',
        content: '/compact',
        internal: true,
      } as never);
      expect(q.shouldEnqueueLateCompaction(0)).toBe(false);
    });

    it('serializes concurrent recovery restarts', async () => {
      const q = new MessageQueue();
      q.start();
      const order: string[] = [];
      let releaseFirst: () => void = () => {};
      const firstHang = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstOpts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-ser-1'] }),
        cancelAsyncMessage: async () => false,
        restart: async () => {
          order.push('first-start');
          await firstHang;
          order.push('first-end');
        },
      });
      const secondOpts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-ser-2'] }),
        cancelAsyncMessage: async () => false,
        restart: async () => {
          order.push('second-start');
          order.push('second-end');
        },
      });

      const first = q.runMidTurnBudgetInterrupt(firstOpts);
      await tick(30);
      const second = q.runMidTurnBudgetInterrupt(secondOpts);
      await tick(50);

      expect(order).toEqual(['first-start']);

      releaseFirst();
      await Promise.all([first, second]);
      expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
    });

    it('holds the recovery restart chain past the race timeout until the restart settles', async () => {
      const q = new MessageQueue();
      q.start();
      const order: string[] = [];
      let releaseFirst: () => void = () => {};
      const firstHang = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstOpts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-chain-1'] }),
        cancelAsyncMessage: async () => false,
        restart: async () => {
          order.push('first-start');
          await firstHang;
          order.push('first-end');
        },
      });
      const secondOpts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-chain-2'] }),
        cancelAsyncMessage: async () => false,
        restart: async () => {
          order.push('second-start');
          order.push('second-end');
        },
      });

      const first = q.runMidTurnBudgetInterrupt(firstOpts);
      await tick(30);
      const second = q.runMidTurnBudgetInterrupt(secondOpts);
      await tick(5_400);

      expect(order).toEqual(['first-start']);

      releaseFirst();
      await Promise.all([first, second]);
      await tick(100);
      expect(order).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
    }, 15_000);

    it('scopes recovered-entry removal to the restart cycle that owns them', async () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'uuid-own-1',
        content: 'first survivor',
        internal: false,
      } as never);
      q.noteInternalCompactionSent({
        id: 'uuid-own-2',
        content: 'second survivor',
        internal: false,
      } as never);
      let releaseFirst: () => void = () => {};
      const firstHang = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      const firstOpts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-own-1'] }),
        cancelAsyncMessage: async () => false,
        restart: async () => {
          await firstHang;
          throw new Error('first restart failed pre-teardown');
        },
      });
      const secondOpts = makeInterruptOpts({
        interrupt: async () => ({ still_queued: ['uuid-own-2'] }),
        cancelAsyncMessage: async () => false,
        restart: async () => {},
      });

      const first = q.runMidTurnBudgetInterrupt(firstOpts);
      await tick(30);
      const second = q.runMidTurnBudgetInterrupt(secondOpts);
      await tick(30);

      releaseFirst();
      await Promise.all([first, second]);
      await tick(50);

      expect(q.hasPendingOrClaimed('uuid-own-1')).toBe(false);
      expect(q.hasPendingOrClaimed('uuid-own-2')).toBe(true);
      q.stop();
    });

    it('includes late survivors restored during the restart in its cleanup scope', async () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'uuid-late-scope',
        content: 'late scope survivor',
        internal: false,
      } as never);
      let releaseInterrupt: (receipt: { still_queued: string[] }) => void = () => {};
      const slowInterrupt = new Promise<{ still_queued: string[] }>((resolve) => {
        releaseInterrupt = resolve;
      });
      let releaseRestart: () => void = () => {};
      const restartHang = new Promise<void>((resolve) => {
        releaseRestart = resolve;
      });
      const opts = makeInterruptOpts({
        interrupt: () => slowInterrupt,
        cancelAsyncMessage: async () => false,
        restart: async (options) => {
          q.stop();
          await options?.beforeStart?.();
          await restartHang;
        },
      });

      const run = q.runMidTurnBudgetInterrupt(opts);
      await tick(5_200);
      releaseInterrupt({ still_queued: ['uuid-late-scope'] });
      await tick(50);
      q.noteUserInterrupt();
      releaseRestart();
      await run;
      await tick(50);

      expect(q.hasPendingOrClaimed('uuid-late-scope')).toBe(false);
      q.stop();
    }, 15_000);

    it('retains yield stamps for outstanding messages past the retention cap', async () => {
      const q = new MessageQueue();
      q.start();
      const generator = q.messageGenerator(testSessionId, { queryGeneration: 3 });
      const steps: Array<{ message: { uuid: string }; onSent: () => void }> = [];
      for (let index = 0; index < 70; index += 1) {
        const delivered = q.enqueueWithId(`uuid-ret-${index}`, `retained ${index}`, false, {});
        delivered.catch(() => {});
        const step = await generator.next();
        steps.push(step.value);
      }
      for (let index = 10; index < 70; index += 1) {
        steps[index].onSent();
      }
      const extra = q.enqueueWithId('uuid-ret-extra', 'retained extra', false, {});
      extra.catch(() => {});
      (await generator.next()).value.onSent();

      q.stop();
      expect(q.ownsLastYield('uuid-ret-3', 3)).toBe(false);
    });

    it('retains stopped yield stamps beyond the retention cap until the queue restarts', async () => {
      const q = new MessageQueue();
      q.start();
      const generator = q.messageGenerator(testSessionId, { queryGeneration: 3 });
      const steps: Array<{ message: { uuid: string }; onSent: () => void }> = [];
      for (let index = 0; index < 70; index += 1) {
        const delivered = q.enqueueWithId(`uuid-stop-ret-${index}`, `stopped ${index}`, false, {});
        delivered.catch(() => {});
        const step = await generator.next();
        steps.push(step.value);
      }
      for (let index = 10; index < 70; index += 1) {
        steps[index].onSent();
      }
      q.clear();
      const extra = q.enqueueWithId('uuid-stop-ret-extra', 'stopped extra', false, {});
      extra.catch(() => {});
      (await generator.next()).value.onSent();

      q.stop();
      expect(q.ownsLastYield('uuid-stop-ret-3', 3)).toBe(false);
    });

    it('preserves acknowledgment fences past the hard cap', async () => {
      const q = new MessageQueue();
      q.start();
      const generator = q.messageGenerator(testSessionId, { queryGeneration: 9 });
      const steps: Array<{ message: { uuid: string }; onSent: () => void }> = [];
      for (let index = 0; index < 260; index += 1) {
        const delivered = q.enqueueWithId(`uuid-hard-${index}`, `hard ${index}`, false, {});
        delivered.catch(() => {});
        const step = await generator.next();
        steps.push(step.value);
      }
      for (let index = 60; index < 260; index += 1) {
        steps[index].onSent();
      }
      q.clear();
      const extra = q.enqueueWithId('uuid-hard-extra', 'hard extra', false, {});
      extra.catch(() => {});
      (await generator.next()).value.onSent();

      q.stop();
      expect(q.ownsLastYield('uuid-hard-3', 9)).toBe(false);
    });

    it('stands down a late receipt after the recovery replacement was stopped', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueueWithId('uuid-stale-receipt', 'stale-survivor', false, {
        durable: true,
      });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      let releaseInterrupt: (receipt: { still_queued: string[] }) => void = () => {};
      const slowInterrupt = new Promise<{ still_queued: string[] }>((resolve) => {
        releaseInterrupt = resolve;
      });
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      let ownsTurn = true;
      const opts = makeInterruptOpts({
        interrupt: () => slowInterrupt,
        cancelAsyncMessage: async () => true,
        ownsTurn: () => ownsTurn,
        restart: async (options) => {
          q.stop();
          ownsTurn = false;
          await options?.beforeStart?.();
          q.start();
        },
      });

      const run = q.runMidTurnBudgetInterrupt(opts);
      await tick(5_200);
      q.stop();
      q.start();
      releaseInterrupt({ still_queued: ['uuid-stale-receipt'] });
      await run;
      await tick(50);

      expect(enqueueSpy).not.toHaveBeenCalledWith(
        'uuid-stale-receipt',
        expect.anything(),
        expect.anything(),
        expect.anything()
      );
      q.stop();
    }, 15_000);

    it('preserves a late receipt that arrives during the recovery restart', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueueWithId('uuid-late-restart', 'late-survivor', false, {
        durable: true,
      });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      let releaseInterrupt: (receipt: { still_queued: string[] }) => void = () => {};
      const slowInterrupt = new Promise<{ still_queued: string[] }>((resolve) => {
        releaseInterrupt = resolve;
      });
      let releaseRestart: () => void = () => {};
      const restartHang = new Promise<void>((resolve) => {
        releaseRestart = resolve;
      });
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const onResumeClear = mock(() => {});
      const opts = makeInterruptOpts({
        interrupt: () => slowInterrupt,
        restart: async (options) => {
          q.stop();
          await options?.beforeStart?.();
          await restartHang;
        },
        onResumeClear,
      });

      const run = q.runMidTurnBudgetInterrupt(opts);
      await tick(5_200);
      releaseInterrupt({ still_queued: ['uuid-late-restart'] });
      await run;
      await tick(50);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-late-restart', 'late-survivor', false, {
        durable: true,
        prepend: true,
      });
      expect(onResumeClear).not.toHaveBeenCalled();
    }, 15_000);

    it('suppresses the prompt-phase compaction when a boundary completed mid-cycle', async () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'uuid-s',
        content: 'survivor-content',
        internal: false,
      } as never);
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const opts = makeInterruptOpts({
        interrupt: async () => {
          q.noteBoundaryCompleted();
          return { still_queued: ['uuid-s'] };
        },
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(enqueueSpy.mock.calls.some((call) => call[1] === '/compact')).toBe(false);
      expect(enqueueSpy).toHaveBeenCalledWith('uuid-s', 'survivor-content', false, {
        durable: true,
        prepend: true,
      });
      q.stop();
    });

    it('re-asserts compaction-first ordering when a late receipt follows a restart', async () => {
      const q = new MessageQueue();
      q.start();
      const sent = q.enqueueWithId('uuid-late-order', 'late-survivor', false, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      let resolveInterrupt: (receipt: { still_queued: string[] }) => void = () => {};
      const slowInterrupt = new Promise<{ still_queued: string[] }>((resolve) => {
        resolveInterrupt = resolve;
      });
      const restartMock = mock(async (options?: { beforeStart?: () => void }) => {
        options?.beforeStart?.();
      });
      const opts = makeInterruptOpts({
        interrupt: () => slowInterrupt,
        cancelAsyncMessage: async () => true,
        restart: restartMock,
      });

      const run = q.runMidTurnBudgetInterrupt(opts);
      await tick(5_200);
      resolveInterrupt({ still_queued: ['uuid-late-order'] });
      await run;
      await tick(50);

      const replay = q.messageGenerator(testSessionId);
      const first = await replay.next();
      expect((first.value.message.message.content as Array<{ text?: string }>)[0].text).toBe(
        '/compact'
      );
      first.value.onSent();
      q.acknowledgeCompactionsAwaitingBoundary();
      const second = await replay.next();
      expect((second.value.message.message.content as Array<{ text?: string }>)[0].text).toBe(
        'late-survivor'
      );
      second.value.onSent();
      q.stop();
    }, 15_000);

    it('skips the late replacement compaction when a boundary lands mid-window', async () => {
      const q = new MessageQueue();
      q.start();
      const queued = q.enqueueWithId('compact-late-boundary', '/compact', true, {
        durable: true,
      });
      queued.catch(() => {});
      q.noteInternalCompactionSent({
        id: 'uuid-lb',
        content: 'late-survivor',
        internal: false,
      } as never);
      let releaseCancel: () => void = () => {};
      const cancelGate = new Promise<void>((resolve) => {
        releaseCancel = resolve;
      });
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const opts = makeInterruptOpts({
        cancelAsyncMessage: async () => {
          await cancelGate;
          return true;
        },
      });

      q.armInterruptCycle(opts);
      q.registerLateReceipt(opts, {
        promise: Promise.resolve({ still_queued: ['uuid-lb'] }),
        timedOut: true,
      });
      await tick(20);
      q.noteBoundaryCompleted();
      releaseCancel();
      await tick(50);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-lb', 'late-survivor', false, {
        durable: true,
        prepend: true,
      });
      expect(enqueueSpy.mock.calls.filter((call) => call[1] === '/compact')).toHaveLength(0);
      q.clear();
      q.stop();
    });

    it('skips a second compaction when the recovery boundary already completed', async () => {
      const q = new MessageQueue();
      q.start();
      const compact = q.enqueueWithId('compact-done', '/compact', true, { durable: true });
      const prelude = q.messageGenerator(testSessionId);
      (await prelude.next()).value.onSent();
      await compact;
      q.acknowledgeCompactionsAwaitingBoundary();
      const sent = q.enqueueWithId('uuid-acked', 'acked-survivor', false, { durable: true });
      const generator = q.messageGenerator(testSessionId);
      (await generator.next()).value.onSent();
      await sent;
      let releaseInterrupt: (receipt: { still_queued: string[] }) => void = () => {};
      const slowInterrupt = new Promise<{ still_queued: string[] }>((resolve) => {
        releaseInterrupt = resolve;
      });
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const opts = makeInterruptOpts({
        interrupt: () => slowInterrupt,
        cancelAsyncMessage: async () => true,
        restart: async () => {},
      });

      const run = q.runMidTurnBudgetInterrupt(opts);
      await tick(5_200);
      releaseInterrupt({ still_queued: ['uuid-acked'] });
      await run;
      await tick(50);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-acked', 'acked-survivor', false, {
        durable: true,
        prepend: true,
      });
      expect(enqueueSpy.mock.calls.some((call) => call[1] === '/compact')).toBe(false);
    }, 15_000);

    it('keeps boundary suppression local to each late-receipt window', async () => {
      const q = new MessageQueue();
      q.start();
      const queued = q.enqueueWithId('compact-boundary-window', '/compact', true, {
        durable: true,
      });
      queued.catch(() => {});
      q.noteInternalCompactionSent({
        id: 'uuid-bw1',
        content: 'boundary-window survivor',
        internal: false,
      } as never);
      let releaseWindow1: (cancelled: boolean) => void = () => {};
      const window1Cancel = new Promise<boolean>((resolve) => {
        releaseWindow1 = resolve;
      });
      const opts1 = makeInterruptOpts({ cancelAsyncMessage: () => window1Cancel });
      const opts2 = makeInterruptOpts({});
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);

      q.armInterruptCycle(opts1);
      q.registerLateReceipt(opts1, {
        promise: Promise.resolve({ still_queued: ['uuid-bw1'] }),
        timedOut: true,
      });
      await tick(20);
      q.noteBoundaryCompleted();
      q.armInterruptCycle(opts2);
      q.registerLateReceipt(opts2, {
        promise: Promise.resolve({ still_queued: [] }),
        timedOut: true,
      });
      await tick(20);
      releaseWindow1(true);
      await tick(20);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-bw1', 'boundary-window survivor', false, {
        durable: true,
        prepend: true,
      });
      expect(enqueueSpy.mock.calls.some((call) => call[1] === '/compact')).toBe(false);
      q.clear();
      q.stop();
    });

    it('keeps the removed-compaction count local to each late-receipt window', async () => {
      const q = new MessageQueue();
      q.start();
      const queued = q.enqueueWithId('compact-window', '/compact', true, { durable: true });
      queued.catch(() => {});
      let releaseWindow1: (cancelled: boolean) => void = () => {};
      const window1Cancel = new Promise<boolean>((resolve) => {
        releaseWindow1 = resolve;
      });
      const opts1 = makeInterruptOpts({ cancelAsyncMessage: () => window1Cancel });
      const opts2 = makeInterruptOpts({});
      q.armInterruptCycle(opts1);
      q.registerLateReceipt(opts1, {
        promise: Promise.resolve({ still_queued: ['survivor-1'] }),
        timedOut: true,
      });
      q.armInterruptCycle(opts2);
      q.registerLateReceipt(opts2, {
        promise: Promise.resolve({ still_queued: ['survivor-2'] }),
        timedOut: true,
      });
      await tick(20);

      releaseWindow1(true);
      await tick(20);

      expect(q.hasOutstandingInternalCompaction()).toBe(true);
      q.clear();
      q.stop();
    });

    it('holds a queued tool result behind a pending mid-turn compaction', async () => {
      const q = new MessageQueue();
      q.start();
      const opts = makeInterruptOpts({});
      q.enqueueMidTurnCompaction(opts, 'test');
      const toolResult = q.enqueueWithId(
        'tool-result-mid-turn',
        [{ type: 'tool_result', tool_use_id: 'tu-mid', content: 'done' }],
        false,
        { durable: true }
      );

      const generator = q.messageGenerator(testSessionId);
      const first = await generator.next();
      expect(first.value.message.internal).toBe(true);
      first.value.onSent();
      const second = await generator.next();
      expect(second.value.message.uuid).toBe('tool-result-mid-turn');
      second.value.onSent();
      await toolResult;
      q.stop();
    });

    it('skips the restart compaction when a boundary completed mid-cycle', async () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'uuid-rb',
        content: 'restart-boundary survivor',
        internal: false,
      } as never);
      const restartMock = mock(async (options?: { beforeStart?: () => void }) => {
        options?.beforeStart?.();
      });
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const opts = makeInterruptOpts({
        interrupt: async () => {
          q.noteBoundaryCompleted();
          return { still_queued: ['uuid-rb'] };
        },
        cancelAsyncMessage: async () => false,
        restart: restartMock,
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(restartMock).toHaveBeenCalledTimes(1);
      expect(enqueueSpy).toHaveBeenCalledWith('uuid-rb', 'restart-boundary survivor', false, {
        durable: true,
        prepend: true,
      });
      expect(enqueueSpy.mock.calls.some((call) => call[1] === '/compact')).toBe(false);
      q.stop();
    });

    it('skips the restart-failure compaction when a boundary completed mid-cycle', async () => {
      const q = new MessageQueue();
      q.start();
      q.noteInternalCompactionSent({
        id: 'uuid-rbf',
        content: 'restart-failure survivor',
        internal: false,
      } as never);
      const enqueueSpy = spyOn(q, 'enqueueWithId').mockResolvedValue(undefined);
      const opts = makeInterruptOpts({
        interrupt: async () => {
          q.noteBoundaryCompleted();
          return { still_queued: ['uuid-rbf'] };
        },
        cancelAsyncMessage: async () => false,
        restart: () => Promise.reject(new Error('restart failed')),
      });

      await q.runMidTurnBudgetInterrupt(opts);

      expect(enqueueSpy).toHaveBeenCalledWith('uuid-rbf', 'restart-failure survivor', false, {
        durable: true,
        prepend: true,
      });
      expect(enqueueSpy.mock.calls.some((call) => call[1] === '/compact')).toBe(false);
      q.stop();
    });

    it('reports queued compactions aborted by stop', async () => {
      const q = new MessageQueue();
      q.start();
      const abortedCallback = mock(() => {});
      q.onInternalCompactionsAborted = abortedCallback;
      const opts = makeInterruptOpts({});
      q.enqueueMidTurnCompaction(opts, 'test');
      expect(q.hasOutstandingInternalCompaction()).toBe(true);

      q.stop();

      expect(q.hasOutstandingInternalCompaction()).toBe(false);
      expect(abortedCallback).toHaveBeenCalledTimes(1);
    });

    it('resets mid-turn state when clear() rejects a queued compaction', async () => {
      const q = new MessageQueue();
      q.start();
      const abortedCallback = mock(() => {});
      q.onInternalCompactionsAborted = abortedCallback;
      const opts = makeInterruptOpts({});
      q.enqueueMidTurnCompaction(opts, 'test');
      expect(q.hasOutstandingInternalCompaction()).toBe(true);

      q.clear();

      expect(q.hasOutstandingInternalCompaction()).toBe(false);
      expect(abortedCallback).toHaveBeenCalledTimes(1);

      const compaction = q.enqueue('/compact', true, { durable: true });
      compaction.catch(() => {});
      const toolResult = q.enqueueWithId(
        'tool-result-after-clear',
        [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'done' }],
        false,
        { durable: true }
      );

      const generator = q.messageGenerator(testSessionId);
      const first = await generator.next();
      expect(first.value.message.uuid).toBe('tool-result-after-clear');
      first.value.onSent();
      await toolResult;

      const second = await generator.next();
      expect(second.value.message.internal).toBe(true);
      second.value.onSent();
      await compaction;
      q.stop();
    });

    it('does not re-snapshot the budget-cycle epochs during a late receipt', async () => {
      const q = new MessageQueue();
      q.start();
      q.clear();
      const budget = q as unknown as {
        budgetCycleClearEpoch: number;
        budgetCycleUserInterruptEpoch: number;
      };
      const opts = makeInterruptOpts({
        cancelAsyncMessage: async () => true,
      });

      q.noteBudgetCycleStarted();
      const expectedClear = budget.budgetCycleClearEpoch;
      const expectedUser = budget.budgetCycleUserInterruptEpoch;

      q.clear();
      q.noteUserInterrupt();
      q.armInterruptCycle(opts);
      q.registerLateReceipt(opts, {
        promise: Promise.resolve({ still_queued: ['uuid-late-epoch'] }),
        timedOut: true,
      });
      await tick(20);

      expect(budget.budgetCycleClearEpoch).toBe(expectedClear);
      expect(budget.budgetCycleUserInterruptEpoch).toBe(expectedUser);

      q.clear();
      q.stop();
    });
  });
});
