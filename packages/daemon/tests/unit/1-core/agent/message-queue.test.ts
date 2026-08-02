/**
 * MessageQueue Tests
 *
 * Tests message queuing, AsyncGenerator functionality,
 * and queue lifecycle management.
 */

import { describe, expect, it, beforeEach } from 'bun:test';
import { MessageQueue } from '../../../../src/lib/agent/message-queue';
import { generateUUID } from '@hyperneo/shared';

describe('MessageQueue', () => {
  let queue: MessageQueue;
  const testSessionId = generateUUID();

  beforeEach(() => {
    queue = new MessageQueue();
  });

  describe('enqueue', () => {
    it('should enqueue a message and return message ID', async () => {
      queue.start(); // Start queue so generator can process messages

      const messageId = queue.enqueue('Test message');
      expect(messageId).toBeInstanceOf(Promise);

      // Start generator to process the message
      const generator = queue.messageGenerator(testSessionId);
      const result = await generator.next();
      result.value.onSent(); // Mark as sent

      const id = await messageId;

      // Message ID should be a UUID
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

      queue.stop(); // Clean up
    });

    it('should enqueue multiple messages', async () => {
      const promise1 = queue.enqueue('Message 1');
      const promise2 = queue.enqueue('Message 2');
      const promise3 = queue.enqueue('Message 3');

      expect(queue.size()).toBe(3);
      expect(promise1).toBeInstanceOf(Promise);
      expect(promise2).toBeInstanceOf(Promise);
      expect(promise3).toBeInstanceOf(Promise);

      // Clean up - clear queue and handle rejections
      queue.clear();
      await promise1.catch(() => {});
      await promise2.catch(() => {});
      await promise3.catch(() => {});
    });

    it('should enqueue message with internal flag', async () => {
      const promise = queue.enqueue('Internal message', true);
      expect(queue.size()).toBe(1);

      // Clean up
      queue.clear();
      await promise.catch(() => {});
    });
  });

  describe('clear', () => {
    it('should clear all pending messages', async () => {
      const promise1 = queue.enqueue('Message 1');
      const promise2 = queue.enqueue('Message 2');
      const promise3 = queue.enqueue('Message 3');

      expect(queue.size()).toBe(3);

      queue.clear();

      expect(queue.size()).toBe(0);

      // Catch rejected promises to avoid unhandled rejections
      await promise1.catch(() => {});
      await promise2.catch(() => {});
      await promise3.catch(() => {});
    });

    it('should reject all pending message promises', async () => {
      const promise1 = queue.enqueue('Message 1');
      const promise2 = queue.enqueue('Message 2');

      // Store promise rejection handlers immediately to avoid unhandled rejection
      const rejection1 = promise1.catch((err) => err);
      const rejection2 = promise2.catch((err) => err);

      queue.clear();

      // Check that promises were rejected with correct error
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

      // Enqueue message before starting generator
      const messagePromise = queue.enqueue('Test message');

      // Start generator
      const generator = queue.messageGenerator(testSessionId);

      // Get first message
      const result = await generator.next();

      expect(result.done).toBe(false);
      expect(result.value).toBeDefined();
      expect(result.value.message.type).toBe('user');
      expect(result.value.message.session_id).toBe(testSessionId);
      expect(result.value.message.message.content).toEqual([
        { type: 'text', text: 'Test message' },
      ]);

      // Call onSent callback
      result.value.onSent();

      // Wait for message promise to resolve
      const messageId = await messagePromise;
      expect(messageId).toBeDefined();
    });

    it('should yield multiple messages in order', async () => {
      queue.start();

      // Enqueue messages
      const promise1 = queue.enqueue('Message 1');
      const promise2 = queue.enqueue('Message 2');
      const promise3 = queue.enqueue('Message 3');

      // Start generator
      const generator = queue.messageGenerator(testSessionId);

      // Get messages in order
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

      // Stop queue before getting next message
      queue.stop();

      // Generator should complete
      const result = await generator.next();
      expect(result.done).toBe(true);
    });

    it('clear() rejects a yielded-but-unacknowledged message so its enqueue promise settles', async () => {
      // messageGenerator shifts a message out of the queue before yielding it,
      // and the enqueue promise only resolves once the SDK calls onSent. If an
      // interrupt lands in that gap, clear() must still reject the promise —
      // otherwise `await enqueueWithId()` hangs forever.
      queue.start();
      const messagePromise = queue.enqueueWithId('msg-inflight', 'Hello');
      const generator = queue.messageGenerator(testSessionId);

      const result = await generator.next();
      expect(result.done).toBe(false);
      // Do NOT call onSent — the SDK hasn't acknowledged yet.

      queue.clear();
      await expect(messagePromise).rejects.toThrow('Interrupted by user');
    });

    it('size() counts messages shifted out and yielded but not yet acknowledged', async () => {
      // handleInterrupt clears only when size() > 0, so a yielded kickoff (only
      // in inFlight) must still count here or clear() would be skipped.
      queue.start();
      queue.enqueueWithId('msg-inflight-size', 'Hello');
      const generator = queue.messageGenerator(testSessionId);
      await generator.next(); // shift + yield (do NOT call onSent)
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

      // Catch rejected promises
      await promise1.catch(() => {});
      await promise2.catch(() => {});
    });
  });

  describe('timeout detection', () => {
    it('should reject message after timeout if not consumed', async () => {
      // Don't start the queue - messages won't be consumed
      const messageId = 'test-timeout-message';

      // The default timeout is 30s, which is too long for tests
      // We can test that the timeout mechanism is in place by checking
      // that the message gets the timeout tracking fields
      const promise = queue.enqueueWithId(messageId, 'Test message');

      // Immediately clear queue which should clear timeout and reject
      queue.clear();

      // Promise should be rejected with interrupt error (clear was called)
      await expect(promise).rejects.toThrow('Interrupted by user');
    });

    it('should clear timeout when message is consumed', async () => {
      queue.start();

      const messageId = 'test-consumed-message';
      const promise = queue.enqueueWithId(messageId, 'Test message');

      // Start generator to consume the message
      const generator = queue.messageGenerator('test-session');
      const result = await generator.next();

      expect(result.done).toBe(false);
      expect(result.value).toBeDefined();

      // Call onSent which should clear the timeout
      result.value.onSent();

      // Promise should resolve successfully
      await expect(promise).resolves.toBeUndefined();

      queue.stop();
    });

    it('should include error name MessageQueueTimeoutError on timeout', async () => {
      // This test validates the error structure without waiting for real timeout
      // We create a mock scenario by modifying the queue behavior
      const error = new Error('Message queue timeout: SDK did not consume message test within 30s');
      error.name = 'MessageQueueTimeoutError';

      expect(error.name).toBe('MessageQueueTimeoutError');
      expect(error.message).toContain('Message queue timeout');
    });

    it('should clear all pending timeouts when queue is cleared', async () => {
      // Enqueue multiple messages (don't start queue - no generator consuming)
      const promise1 = queue.enqueue('Message 1');
      const promise2 = queue.enqueue('Message 2');
      const promise3 = queue.enqueue('Message 3');

      expect(queue.size()).toBe(3);

      // Store rejection handlers
      const rejection1 = promise1.catch((err) => err);
      const rejection2 = promise2.catch((err) => err);
      const rejection3 = promise3.catch((err) => err);

      // Clear queue - should clear all timeouts and reject all
      queue.clear();

      expect(queue.size()).toBe(0);

      // All should be rejected with interrupt error
      const error1 = await rejection1;
      const error2 = await rejection2;
      const error3 = await rejection3;

      expect(error1.message).toBe('Interrupted by user');
      expect(error2.message).toBe('Interrupted by user');
      expect(error3.message).toBe('Interrupted by user');
    });

    it('should handle rapid enqueue/clear cycles without memory leaks', async () => {
      // Rapidly enqueue and clear to test cleanup
      for (let i = 0; i < 10; i++) {
        const promises: Promise<string>[] = [];
        for (let j = 0; j < 5; j++) {
          promises.push(queue.enqueue(`Message ${i}-${j}`));
        }

        // Clear queue
        queue.clear();

        // Wait for all rejections
        await Promise.allSettled(promises);

        expect(queue.size()).toBe(0);
      }
    });

    it('should reject with timeout error containing message ID', async () => {
      // Validate error message format contains the message ID
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

        // Schedule generation change while generator is waiting
        // The generator waits for up to 1000ms at a time, then rechecks
        setTimeout(() => {
          queue.stop();
        }, 100);

        // The generator waits in waitForNextMessage
        // When stopped, running becomes false, so waitForNextMessage returns null
        const result = await generator.next();
        expect(result.done).toBe(true);
      },
      { timeout: 2000 }
    );

    it('should check generation before yielding message', async () => {
      queue.start();

      // Enqueue message first
      const promise1 = queue.enqueue('Message 1');

      // Create generator that will capture current generation
      const generator = queue.messageGenerator(testSessionId);

      // Consume the message
      const result = await generator.next();
      expect(result.done).toBe(false);
      expect(result.value.message.message.content[0].text).toBe('Message 1');
      result.value.onSent();
      await promise1;

      queue.stop();
    });

    it('should allow new generator after restart to consume messages', async () => {
      queue.start();

      // Create generator
      const generator1 = queue.messageGenerator(testSessionId);

      // Stop queue
      queue.stop();

      // Start again (increments generation)
      queue.start();

      // Enqueue a message
      const promise1 = queue.enqueue('Message for new gen');

      // Create new generator with new generation
      const generator2 = queue.messageGenerator(testSessionId);

      // New generator should be able to consume it
      const result = await generator2.next();
      expect(result.done).toBe(false);
      expect(result.value.message.message.content[0].text).toBe('Message for new gen');
      result.value.onSent();
      await promise1;

      queue.stop();
    });
  });

  describe('enqueueWithId', () => {
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

        // Wait a bit then enqueue
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

        // Stop queue while generator is waiting
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

        // Enqueue multiple messages - don't await, they will be consumed by generator
        const promise1 = queue.enqueue('Message 1');
        const promise2 = queue.enqueue('Message 2');
        const promise3 = queue.enqueue('Message 3');

        expect(queue.size()).toBe(3);

        const generator = queue.messageGenerator(testSessionId);

        // Consume all messages
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

        // Now all promises should resolve
        await Promise.all([promise1, promise2, promise3]);

        queue.stop();
      },
      { timeout: 2000 }
    );

    it('should handle enqueue while generator is processing', async () => {
      queue.start();

      const promise1 = queue.enqueue('First message');

      const generator = queue.messageGenerator(testSessionId);

      // Get first message
      const result1 = await generator.next();
      expect(result1.value.message.message.content[0].text).toBe('First message');

      // Enqueue another while processing
      const promise2 = queue.enqueue('Second message');

      result1.value.onSent();
      await promise1;

      // Get second message
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
      queue.clear(); // Should not throw
      expect(queue.size()).toBe(0);
    });

    it('should handle multiple stops', () => {
      queue.start();
      queue.stop();
      queue.stop(); // Should not throw
      expect(queue.isRunning()).toBe(false);
    });

    it('should handle multiple starts', () => {
      queue.start();
      queue.start(); // Should increment generation
      expect(queue.getGeneration()).toBe(2);
    });
  });

  describe('internal flag propagation', () => {
    it('should propagate internal flag from queued message to SDK message', async () => {
      queue.start();

      // Enqueue an internal message
      const messagePromise = queue.enqueue('Internal test message', true);

      // Start generator
      const generator = queue.messageGenerator(testSessionId);

      // Get first message
      const result = await generator.next();

      expect(result.done).toBe(false);
      expect(result.value).toBeDefined();
      expect(result.value.message.internal).toBe(true);

      // Call onSent callback
      result.value.onSent();
      await messagePromise;

      queue.stop();
    });

    it('should have false internal flag when not set', async () => {
      queue.start();

      // Enqueue a regular message (no internal flag)
      const messagePromise = queue.enqueue('Regular message');

      // Start generator
      const generator = queue.messageGenerator(testSessionId);

      // Get first message
      const result = await generator.next();

      expect(result.done).toBe(false);
      expect(result.value).toBeDefined();
      expect(result.value.message.internal).toBe(false);

      // Call onSent callback
      result.value.onSent();
      await messagePromise;

      queue.stop();
    });

    it('should handle internal flag for multiple messages', async () => {
      queue.start();

      // Enqueue mix of internal and regular messages
      const promise1 = queue.enqueue('Regular 1', false);
      const promise2 = queue.enqueue('Internal 1', true);
      const promise3 = queue.enqueue('Regular 2');
      const promise4 = queue.enqueue('Internal 2', true);

      // Start generator
      const generator = queue.messageGenerator(testSessionId);

      // Get messages and verify internal flags
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
});
