import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { ApiErrorCircuitBreaker } from '../../../../src/lib/agent/api-error-circuit-breaker';

describe('ApiErrorCircuitBreaker', () => {
  let circuitBreaker: ApiErrorCircuitBreaker;

  beforeEach(() => {
    circuitBreaker = new ApiErrorCircuitBreaker('test-session-123');
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
});
