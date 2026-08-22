import { afterEach, beforeEach, describe, expect, it, jest, mock } from 'bun:test';
import { ApiErrorCircuitBreaker } from '../../../../src/lib/agent/api-error-circuit-breaker';

const T0 = new Date('2026-01-01T00:00:00Z').getTime();

describe('ApiErrorCircuitBreaker', () => {
  let circuitBreaker: ApiErrorCircuitBreaker;

  beforeEach(() => {
    jest.setSystemTime(T0);
    circuitBreaker = new ApiErrorCircuitBreaker('test-session-123');
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('error pattern detection', () => {
    it('should detect prompt too long errors', async () => {
      const message = {
        type: 'user',
        message: {
          content:
            '<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 205616 tokens > 200000 maximum"}}</local-command-stderr>',
        },
      };

      const tripped = await circuitBreaker.checkMessage(message);
      expect(tripped).toBe(false);
    });

    it('should trip after threshold errors', async () => {
      const onTripMock = mock(async () => {});
      circuitBreaker.setOnTripCallback(onTripMock);

      const message = {
        type: 'user',
        message: {
          content:
            '<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 205616 tokens > 200000 maximum"}}</local-command-stderr>',
        },
      };

      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);
      expect(circuitBreaker.isTripped()).toBe(false);

      const tripped = await circuitBreaker.checkMessage(message);
      expect(tripped).toBe(true);
      expect(circuitBreaker.isTripped()).toBe(true);
      expect(onTripMock).toHaveBeenCalled();
    });

    it('should detect bare "Prompt is too long" errors (Kimi)', async () => {
      const onTripMock = mock(async () => {});
      circuitBreaker.setOnTripCallback(onTripMock);

      const message = {
        type: 'user',
        message: {
          content:
            '<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Prompt is too long"}}</local-command-stderr>',
        },
      };

      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);
      expect(circuitBreaker.isTripped()).toBe(false);

      const tripped = await circuitBreaker.checkMessage(message);
      expect(tripped).toBe(true);
      expect(circuitBreaker.isTripped()).toBe(true);
      expect(circuitBreaker.getState().tripReason).toBe('prompt_too_long');
      expect(onTripMock).toHaveBeenCalled();
    });

    it('should not trip on non-error messages', async () => {
      const message = {
        type: 'user',
        message: {
          content: 'Hello, how are you?',
        },
      };

      const tripped = await circuitBreaker.checkMessage(message);
      expect(tripped).toBe(false);
      expect(circuitBreaker.isTripped()).toBe(false);
    });

    it('should not trip on assistant messages', async () => {
      const message = {
        type: 'assistant',
        message: {
          content:
            '<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}</local-command-stderr>',
        },
      };

      const tripped = await circuitBreaker.checkMessage(message);
      expect(tripped).toBe(false);
    });

    it('should detect 400 API errors', async () => {
      const message = {
        type: 'user',
        message: {
          content: '<local-command-stderr>Error: 400 {"type":"error"}</local-command-stderr>',
        },
      };

      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);
      const tripped = await circuitBreaker.checkMessage(message);

      expect(tripped).toBe(true);
    });

    it('should detect 429 rate limit errors', async () => {
      const message = {
        type: 'user',
        message: {
          content: '<local-command-stderr>Error: 429 {"type":"error"}</local-command-stderr>',
        },
      };

      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);
      const tripped = await circuitBreaker.checkMessage(message);

      expect(tripped).toBe(true);
    });

    it('should detect connection errors', async () => {
      const message = {
        type: 'user',
        message: {
          content: '<local-command-stderr>Error: Connection error.</local-command-stderr>',
        },
      };

      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);
      const tripped = await circuitBreaker.checkMessage(message);

      expect(tripped).toBe(true);
      expect(circuitBreaker.isTripped()).toBe(true);
    });

    it('should provide connection error message', async () => {
      const message = {
        type: 'user',
        message: {
          content: '<local-command-stderr>Error: Connection error.</local-command-stderr>',
        },
      };

      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);

      const tripMessage = circuitBreaker.getTripMessage();
      expect(tripMessage).toContain('Connection error detected repeatedly');
      expect(tripMessage).toContain('Network connectivity issues');
    });
  });

  describe('reset behavior', () => {
    it('should reset error count after reset()', async () => {
      const message = {
        type: 'user',
        message: {
          content:
            '<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 100 tokens > 50 maximum"}}</local-command-stderr>',
        },
      };

      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);

      circuitBreaker.reset();

      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);
      expect(circuitBreaker.isTripped()).toBe(false);

      await circuitBreaker.checkMessage(message);
      expect(circuitBreaker.isTripped()).toBe(true);
    });

    it('should clear error count on markSuccess()', async () => {
      const message = {
        type: 'user',
        message: {
          content:
            '<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 100 tokens > 50 maximum"}}</local-command-stderr>',
        },
      };

      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);

      circuitBreaker.markSuccess();

      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);
      expect(circuitBreaker.isTripped()).toBe(false);
    });
  });

  describe('trip message', () => {
    it('should provide helpful message for prompt too long', async () => {
      const message = {
        type: 'user',
        message: {
          content:
            '<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 205616 tokens > 200000 maximum"}}</local-command-stderr>',
        },
      };

      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);

      const tripMessage = circuitBreaker.getTripMessage();
      expect(tripMessage).toContain('Context limit exceeded');
      expect(tripMessage).toContain('200000');
    });

    it('should provide helpful message for bare prompt too long', async () => {
      const message = {
        type: 'user',
        message: {
          content:
            '<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Prompt is too long"}}</local-command-stderr>',
        },
      };

      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);

      const tripMessage = circuitBreaker.getTripMessage();
      expect(tripMessage).toContain('Context limit exceeded');
      expect(circuitBreaker.getState().tripReason).toBe('prompt_too_long');
    });

    it('should provide helpful message for rate limit', async () => {
      const message = {
        type: 'user',
        message: {
          content: '<local-command-stderr>Error: 429 {"type":"error"}</local-command-stderr>',
        },
      };

      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);

      const tripMessage = circuitBreaker.getTripMessage();
      expect(tripMessage).toContain('Rate limit');
    });
  });

  describe('per-agent rapid-fire isolation', () => {
    it('should track rapid-fire independently for main agent and subagents', async () => {
      const cb = new ApiErrorCircuitBreaker('test-session', {
        rapidFireThreshold: 5,
        rapidFireWindowMs: 3000,
      });

      for (let i = 0; i < 4; i++) {
        await cb.checkMessage({
          type: 'user',
          message: { content: 'main message' },
          parent_tool_use_id: null,
        });
      }
      expect(cb.isTripped()).toBe(false);

      for (let i = 0; i < 4; i++) {
        await cb.checkMessage({
          type: 'user',
          message: { content: 'subagent message' },
          parent_tool_use_id: 'tool-use-id-1',
        });
      }
      expect(cb.isTripped()).toBe(false);
    });

    it('should trip when single agent exceeds threshold', async () => {
      const cb = new ApiErrorCircuitBreaker('test-session', {
        rapidFireThreshold: 5,
        rapidFireWindowMs: 3000,
      });

      for (let i = 0; i < 3; i++) {
        await cb.checkMessage({
          type: 'user',
          message: { content: 'main' },
          parent_tool_use_id: null,
        });
      }

      for (let i = 0; i < 4; i++) {
        await cb.checkMessage({
          type: 'user',
          message: { content: 'subagent' },
          parent_tool_use_id: 'subagent-tool-id',
        });
      }
      expect(cb.isTripped()).toBe(false);

      const tripped = await cb.checkMessage({
        type: 'user',
        message: { content: 'subagent' },
        parent_tool_use_id: 'subagent-tool-id',
      });
      expect(tripped).toBe(true);
      expect(cb.isTripped()).toBe(true);
    });

    it('should track multiple subagents independently', async () => {
      const cb = new ApiErrorCircuitBreaker('test-session', {
        rapidFireThreshold: 3,
        rapidFireWindowMs: 3000,
      });

      for (const subagentId of ['sub-1', 'sub-2', 'sub-3']) {
        for (let i = 0; i < 2; i++) {
          await cb.checkMessage({
            type: 'user',
            message: { content: 'message' },
            parent_tool_use_id: subagentId,
          });
        }
      }

      expect(cb.isTripped()).toBe(false);
    });
  });

  describe('state management', () => {
    it('should track trip count', async () => {
      const message = {
        type: 'user',
        message: {
          content:
            '<local-command-stderr>Error: 400 {"type":"error","error":{"type":"invalid_request_error"}}</local-command-stderr>',
        },
      };

      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);

      const state1 = circuitBreaker.getState();
      expect(state1.tripCount).toBe(1);

      circuitBreaker.reset();
      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);

      const state2 = circuitBreaker.getState();
      expect(state2.tripCount).toBe(2);
    });
  });

  describe('transient connection error filtering', () => {
    it('should NOT count transient fetch errors as connection errors', async () => {
      const message = {
        type: 'user',
        message: {
          content:
            'API Error: The socket connection was closed unexpectedly. For more information, pass verbose: true',
        },
      };

      for (let i = 0; i < 5; i++) {
        const tripped = await circuitBreaker.checkMessage(message);
        expect(tripped).toBe(false);
      }
      expect(circuitBreaker.isTripped()).toBe(false);
    });

    it('should NOT count TypeError fetch failed as connection errors', async () => {
      const message = {
        type: 'user',
        message: {
          content: 'TypeError: fetch failed',
        },
      };

      for (let i = 0; i < 5; i++) {
        const tripped = await circuitBreaker.checkMessage(message);
        expect(tripped).toBe(false);
      }
      expect(circuitBreaker.isTripped()).toBe(false);
    });

    it('should NOT count stream-closed as connection errors', async () => {
      const message = {
        type: 'user',
        message: {
          content: 'stream closed',
        },
      };

      for (let i = 0; i < 5; i++) {
        const tripped = await circuitBreaker.checkMessage(message);
        expect(tripped).toBe(false);
      }
      expect(circuitBreaker.isTripped()).toBe(false);
    });

    it('should still count genuine repeated Connection errors (stderr format)', async () => {
      const message = {
        type: 'user',
        message: {
          content: '<local-command-stderr>Error: Connection error.</local-command-stderr>',
        },
      };

      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);
      expect(circuitBreaker.isTripped()).toBe(false);

      const tripped = await circuitBreaker.checkMessage(message);
      expect(tripped).toBe(true);
      expect(circuitBreaker.isTripped()).toBe(true);
    });

    it('should count fatal Connection errors even when transient substring is present', async () => {
      const message = {
        type: 'user',
        message: {
          content:
            '<local-command-stderr>Error: Connection error. The connection reset unexpectedly.</local-command-stderr>',
        },
      };

      await circuitBreaker.checkMessage(message);
      await circuitBreaker.checkMessage(message);
      expect(circuitBreaker.isTripped()).toBe(false);

      const tripped = await circuitBreaker.checkMessage(message);
      expect(tripped).toBe(true);
      expect(circuitBreaker.isTripped()).toBe(true);
    });
  });

  describe('transition table characterization', () => {
    const stderrMessage = (body: string) => ({
      type: 'user',
      message: { content: `<local-command-stderr>${body}</local-command-stderr>` },
    });
    const connectionErrorMessage = stderrMessage('Error: Connection error.');
    const promptTooLongMessage = stderrMessage(
      'Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 205616 tokens > 200000 maximum"}}'
    );
    const userMessage = (text: string, parentToolUseId: string | null = null) => ({
      type: 'user',
      message: { content: text },
      parent_tool_use_id: parentToolUseId,
    });

    describe('closed to open: error threshold counts per pattern inside the window', () => {
      it('counts errors per pattern: mixed patterns do not combine into one trip', async () => {
        const cb = new ApiErrorCircuitBreaker('s');
        const onTripMock = mock(async () => {});
        cb.setOnTripCallback(onTripMock);

        await cb.checkMessage(connectionErrorMessage);
        await cb.checkMessage(promptTooLongMessage);
        await cb.checkMessage(connectionErrorMessage);
        const notYetTripped = await cb.checkMessage(promptTooLongMessage);
        expect(notYetTripped).toBe(false);
        expect(cb.getState().isTripped).toBe(false);

        const tripped = await cb.checkMessage(connectionErrorMessage);
        expect(tripped).toBe(true);
        expect(cb.getState().tripReason).toBe('connection_error');
        expect(onTripMock).toHaveBeenCalledWith('connection_error', 3);
      });

      it('errors at exactly timeWindowMs of age are already outside the window', async () => {
        const cb = new ApiErrorCircuitBreaker('s');
        await cb.checkMessage(connectionErrorMessage);
        await cb.checkMessage(connectionErrorMessage);

        jest.setSystemTime(T0 + 30000);
        const tripped = await cb.checkMessage(connectionErrorMessage);
        expect(tripped).toBe(false);
        expect(cb.getState().isTripped).toBe(false);
      });

      it('errors just inside the window still count toward the threshold', async () => {
        const cb = new ApiErrorCircuitBreaker('s');
        await cb.checkMessage(connectionErrorMessage);
        await cb.checkMessage(connectionErrorMessage);

        jest.setSystemTime(T0 + 29999);
        const tripped = await cb.checkMessage(connectionErrorMessage);
        expect(tripped).toBe(true);
      });

      it('the just-recorded error counts toward the threshold (errorThreshold 1 trips immediately)', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 1 });
        const tripped = await cb.checkMessage(connectionErrorMessage);
        expect(tripped).toBe(true);
      });

      it('a trip clears the error memory: a fresh threshold run is required to trip again', async () => {
        const cb = new ApiErrorCircuitBreaker('s');
        await cb.checkMessage(connectionErrorMessage);
        await cb.checkMessage(connectionErrorMessage);
        await cb.checkMessage(connectionErrorMessage);
        expect(cb.getState().tripCount).toBe(1);

        await cb.checkMessage(connectionErrorMessage);
        const notRetripped = await cb.checkMessage(connectionErrorMessage);
        expect(notRetripped).toBe(false);
        expect(cb.getState().tripCount).toBe(1);
      });
    });

    describe('closed to open: rapid fire counts per agent inside its window', () => {
      it('timestamps at exactly rapidFireWindowMs of age are already outside the window', async () => {
        const cb = new ApiErrorCircuitBreaker('s', {
          rapidFireThreshold: 3,
          rapidFireWindowMs: 3000,
        });

        await cb.checkMessage(userMessage('one'));
        jest.setSystemTime(T0 + 3000);
        const second = await cb.checkMessage(userMessage('two'));
        expect(second).toBe(false);
        const third = await cb.checkMessage(userMessage('three'));
        expect(third).toBe(false);

        const tripped = await cb.checkMessage(userMessage('four'));
        expect(tripped).toBe(true);
        expect(cb.getState().tripReason).toBe('rapid_fire');
      });

      it('timestamps just inside the window still count', async () => {
        const cb = new ApiErrorCircuitBreaker('s', {
          rapidFireThreshold: 3,
          rapidFireWindowMs: 3000,
        });

        await cb.checkMessage(userMessage('one'));
        jest.setSystemTime(T0 + 2999);
        const second = await cb.checkMessage(userMessage('two'));
        expect(second).toBe(false);

        const tripped = await cb.checkMessage(userMessage('three'));
        expect(tripped).toBe(true);
      });

      it('non-user messages do not record rapid-fire timestamps', async () => {
        const cb = new ApiErrorCircuitBreaker('s', {
          rapidFireThreshold: 3,
          rapidFireWindowMs: 3000,
        });

        await cb.checkMessage(userMessage('one'));
        const assistant = await cb.checkMessage({
          type: 'assistant',
          message: { content: 'skipped' },
        });
        expect(assistant).toBe(false);
        const second = await cb.checkMessage(userMessage('two'));
        expect(second).toBe(false);

        const tripped = await cb.checkMessage(userMessage('three'));
        expect(tripped).toBe(true);
      });

      it('user messages with empty content still record rapid-fire timestamps', async () => {
        const cb = new ApiErrorCircuitBreaker('s', {
          rapidFireThreshold: 2,
          rapidFireWindowMs: 3000,
        });

        const first = await cb.checkMessage(userMessage(''));
        expect(first).toBe(false);

        const tripped = await cb.checkMessage(userMessage(''));
        expect(tripped).toBe(true);
        expect(cb.getState().tripReason).toBe('rapid_fire');
      });

      it('the rapid-fire gate runs before error classification', async () => {
        const cb = new ApiErrorCircuitBreaker('s', {
          rapidFireThreshold: 3,
          rapidFireWindowMs: 3000,
        });
        const onTripMock = mock(async () => {});
        cb.setOnTripCallback(onTripMock);

        await cb.checkMessage(userMessage('one'));
        await cb.checkMessage(userMessage('two'));
        const tripped = await cb.checkMessage(connectionErrorMessage);
        expect(tripped).toBe(true);
        expect(cb.getState().tripReason).toBe('rapid_fire');
        expect(onTripMock).toHaveBeenCalledWith('rapid_fire', 3);
      });

      it('a trip clears the error memory but not the rapid-fire timestamps', async () => {
        const cb = new ApiErrorCircuitBreaker('s', {
          rapidFireThreshold: 3,
          rapidFireWindowMs: 100000,
        });

        const firstTrip = await cb.checkMessage(userMessage('one'));
        await cb.checkMessage(userMessage('two'));
        const tripped = await cb.checkMessage(userMessage('three'));
        expect(firstTrip).toBe(false);
        expect(tripped).toBe(true);
        expect(cb.getState().tripCount).toBe(1);

        const trippedAgain = await cb.checkMessage(userMessage('four'));
        expect(trippedAgain).toBe(true);
        expect(cb.getState().tripCount).toBe(2);
      });
    });

    describe('trip effects on state', () => {
      it('a trip sets isTripped, tripReason, lastTripTime and increments tripCount', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 1 });
        await cb.checkMessage(connectionErrorMessage);

        expect(cb.getState()).toEqual({
          isTripped: true,
          tripReason: 'connection_error',
          tripCount: 1,
          lastTripTime: T0,
        });
      });

      it('a throwing onTrip callback is contained: the trip still stands', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 1 });
        cb.setOnTripCallback(async () => {
          throw new Error('callback failed');
        });

        const tripped = await cb.checkMessage(connectionErrorMessage);
        expect(tripped).toBe(true);
        expect(cb.getState().isTripped).toBe(true);
      });
    });

    describe('open to closed: cooldown release happens lazily inside isTripped()', () => {
      it('stays tripped while elapsed is below or exactly at cooldownMs, releases past it', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 1, cooldownMs: 1000 });
        await cb.checkMessage(connectionErrorMessage);

        jest.setSystemTime(T0 + 999);
        expect(cb.isTripped()).toBe(true);
        jest.setSystemTime(T0 + 1000);
        expect(cb.isTripped()).toBe(true);
        jest.setSystemTime(T0 + 1001);
        expect(cb.isTripped()).toBe(false);
      });

      it('cooldown release clears tripReason but preserves tripCount and lastTripTime', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 1, cooldownMs: 1000 });
        await cb.checkMessage(connectionErrorMessage);

        jest.setSystemTime(T0 + 1001);
        expect(cb.isTripped()).toBe(false);
        expect(cb.getState()).toEqual({
          isTripped: false,
          tripReason: null,
          tripCount: 1,
          lastTripTime: T0,
        });
      });

      it('cooldown release clears the error memory: re-tripping needs a fresh threshold run', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 2, cooldownMs: 1000 });
        await cb.checkMessage(connectionErrorMessage);
        await cb.checkMessage(connectionErrorMessage);
        expect(cb.getState().tripCount).toBe(1);

        jest.setSystemTime(T0 + 500);
        const whileOpen = await cb.checkMessage(connectionErrorMessage);
        expect(whileOpen).toBe(false);

        jest.setSystemTime(T0 + 1001);
        expect(cb.isTripped()).toBe(false);

        const first = await cb.checkMessage(connectionErrorMessage);
        expect(first).toBe(false);
        const tripped = await cb.checkMessage(connectionErrorMessage);
        expect(tripped).toBe(true);
        expect(cb.getState().tripCount).toBe(2);
      });

      it('cooldown release clears per-agent rapid-fire timestamps', async () => {
        const cb = new ApiErrorCircuitBreaker('s', {
          errorThreshold: 1,
          cooldownMs: 1000,
          rapidFireThreshold: 4,
          rapidFireWindowMs: 100000,
        });
        await cb.checkMessage(connectionErrorMessage);

        jest.setSystemTime(T0 + 500);
        await cb.checkMessage(userMessage('one'));
        const two = await cb.checkMessage(userMessage('two'));
        expect(two).toBe(false);

        jest.setSystemTime(T0 + 1001);
        expect(cb.isTripped()).toBe(false);

        const three = await cb.checkMessage(userMessage('three'));
        expect(three).toBe(false);
        expect(cb.getState().isTripped).toBe(false);

        await cb.checkMessage(userMessage('four'));
        await cb.checkMessage(userMessage('five'));
        const tripped = await cb.checkMessage(userMessage('six'));
        expect(tripped).toBe(true);
        expect(cb.getState().tripReason).toBe('rapid_fire');
      });

      it('a never-tripped breaker reports not tripped', () => {
        const cb = new ApiErrorCircuitBreaker('s');
        expect(cb.isTripped()).toBe(false);
      });
    });

    describe('manual reset semantics', () => {
      it('reset clears isTripped and tripReason but preserves tripCount and lastTripTime', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 1 });
        await cb.checkMessage(connectionErrorMessage);

        cb.reset();
        expect(cb.getState()).toEqual({
          isTripped: false,
          tripReason: null,
          tripCount: 1,
          lastTripTime: T0,
        });
      });

      it('reset clears per-agent rapid-fire timestamps', async () => {
        const cb = new ApiErrorCircuitBreaker('s', {
          rapidFireThreshold: 3,
          rapidFireWindowMs: 100000,
        });
        await cb.checkMessage(userMessage('one'));
        await cb.checkMessage(userMessage('two'));

        cb.reset();

        const third = await cb.checkMessage(userMessage('three'));
        expect(third).toBe(false);
        expect(cb.getState().isTripped).toBe(false);

        await cb.checkMessage(userMessage('four'));
        const tripped = await cb.checkMessage(userMessage('five'));
        expect(tripped).toBe(true);
      });
    });

    describe('markSuccess semantics', () => {
      it('markSuccess clears the error memory but keeps rapid-fire timestamps', async () => {
        const cb = new ApiErrorCircuitBreaker('s', {
          errorThreshold: 2,
          rapidFireThreshold: 3,
          rapidFireWindowMs: 100000,
        });
        await cb.checkMessage(connectionErrorMessage);
        cb.markSuccess();

        const second = await cb.checkMessage(connectionErrorMessage);
        expect(second).toBe(false);
        expect(cb.getState().isTripped).toBe(false);

        await cb.checkMessage(userMessage('one'));
        await cb.checkMessage(userMessage('two'));
        cb.markSuccess();
        const tripped = await cb.checkMessage(userMessage('three'));
        expect(tripped).toBe(true);
        expect(cb.getState().tripReason).toBe('rapid_fire');
      });
    });

    describe('state snapshot isolation', () => {
      it('getState returns a copy: mutating it does not affect the breaker', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 1 });
        await cb.checkMessage(connectionErrorMessage);

        const snapshot = cb.getState();
        snapshot.isTripped = false;
        snapshot.tripReason = 'tampered';
        snapshot.tripCount = 99;

        expect(cb.getState().isTripped).toBe(true);
        expect(cb.getState().tripReason).toBe('connection_error');
        expect(cb.getState().tripCount).toBe(1);
      });
    });

    describe('error pattern classification table', () => {
      it('plain ImageSizeError text without a stderr wrapper trips as image_size_error', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 1 });
        const tripped = await cb.checkMessage(userMessage('ImageSizeError: file too large'));
        expect(tripped).toBe(true);
        expect(cb.getState().tripReason).toBe('image_size_error');
      });

      it('stderr Error: 500 is not counted as an api_error pattern', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 1 });
        const message = stderrMessage('Error: 500 {"type":"error"}');
        for (let i = 0; i < 5; i++) {
          const tripped = await cb.checkMessage(message);
          expect(tripped).toBe(false);
        }
        expect(cb.getState().isTripped).toBe(false);
      });

      it('prompt too long with tokens yields the prompt_too_long:max pattern', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 1 });
        await cb.checkMessage(promptTooLongMessage);
        expect(cb.getState().tripReason).toBe('prompt_too_long:200000');
      });

      it('prompt_too_long takes precedence over connection_error inside one stderr blob', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 1 });
        const message = stderrMessage(
          'Error: 400 {"message":"prompt is too long: 205616 tokens > 200000 maximum"} … Connection error.'
        );
        await cb.checkMessage(message);
        expect(cb.getState().tripReason).toBe('prompt_too_long:200000');
      });

      it('tool_result block content contributes to the scanned text', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 1 });
        const tripped = await cb.checkMessage({
          type: 'user',
          message: {
            content: [{ type: 'tool_result', content: 'ImageSizeError: file too large' }],
          },
        });
        expect(tripped).toBe(true);
        expect(cb.getState().tripReason).toBe('image_size_error');
      });

      it('text and tool_result blocks are concatenated before scanning', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 1 });
        const tripped = await cb.checkMessage({
          type: 'user',
          message: {
            content: [
              { type: 'text', text: 'before ' },
              {
                type: 'tool_result',
                content: '<local-command-stderr>Error: Connection error.</local-command-stderr>',
              },
            ],
          },
        });
        expect(tripped).toBe(true);
        expect(cb.getState().tripReason).toBe('connection_error');
      });
    });

    describe('trip message table', () => {
      it('reports Unknown error before any trip', () => {
        const cb = new ApiErrorCircuitBreaker('s');
        expect(cb.getTripMessage()).toBe('Unknown error');
      });

      it('renders the rapid_fire message', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { rapidFireThreshold: 1 });
        await cb.checkMessage(userMessage('one'));
        expect(cb.getTripMessage()).toContain('Rapid message loop detected');
      });

      it('renders the api_error:400 message', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 1 });
        await cb.checkMessage(stderrMessage('Error: 400 {"type":"error"}'));
        expect(cb.getTripMessage()).toContain('API error (400)');
      });

      it('renders the invalid_request_error message', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 1 });
        await cb.checkMessage(stderrMessage('Error: {"type":"invalid_request_error"}'));
        expect(cb.getTripMessage()).toContain('The API rejected the request');
      });

      it('renders the image_size_error message', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 1 });
        await cb.checkMessage(userMessage('ImageSizeError: file too large'));
        expect(cb.getTripMessage()).toContain('Image size exceeds API limit');
        expect(cb.getTripMessage()).toContain('- Use image compression tools to reduce file size');
      });

      it('renders the bare prompt_too_long message without a token count', async () => {
        const cb = new ApiErrorCircuitBreaker('s', { errorThreshold: 1 });
        await cb.checkMessage(
          stderrMessage(
            'Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"Prompt is too long"}}'
          )
        );
        expect(cb.getTripMessage()).toContain('Context limit exceeded.');
      });
    });
  });
});
