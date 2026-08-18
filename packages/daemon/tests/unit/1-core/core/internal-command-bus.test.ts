import { beforeEach, describe, expect, it } from 'bun:test';
import {
  createInternalCommandBus,
  DuplicateCommandHandlerError,
  InternalCommandBus,
  MissingCommandHandlerError,
  type CommandResult,
  type AgentMessageInjectCommand,
} from '../../../../src/lib/internal-command-bus';

interface TestCommandMap {
  'agent.message.inject': AgentMessageInjectCommand;
  'space.workflow.resume': { workflowRunId: string };
  'github.repo.watch': { owner: string; repo: string };
}

describe('InternalCommandBus', () => {
  let bus: InternalCommandBus<TestCommandMap>;

  beforeEach(() => {
    bus = new InternalCommandBus<TestCommandMap>();
  });

  describe('register', () => {
    it('should register a handler and return an unsubscribe function', () => {
      const unsub = bus.register('space.workflow.resume', async () => ({ ok: true }));
      expect(typeof unsub).toBe('function');
      expect(bus.hasHandler('space.workflow.resume')).toBe(true);
    });

    it('should reject duplicate handlers for the same command', () => {
      bus.register('space.workflow.resume', async () => ({ ok: true }));

      expect(() => bus.register('space.workflow.resume', async () => ({ ok: true }))).toThrow(
        DuplicateCommandHandlerError
      );
    });

    it('should include the command name in the duplicate error', () => {
      bus.register('github.repo.watch', async () => ({ ok: true }));

      try {
        bus.register('github.repo.watch', async () => ({ ok: true }));
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(DuplicateCommandHandlerError);
        const dup = e as DuplicateCommandHandlerError;
        expect(dup.commandName).toBe('github.repo.watch');
        expect(dup.message).toContain('github.repo.watch');
      }
    });
  });

  describe('dispatch', () => {
    it('should return the handler result on success', async () => {
      const result: CommandResult = { ok: true, metadata: { processedAt: 42 } };
      bus.register('space.workflow.resume', async () => result);

      const received = await bus.dispatch('space.workflow.resume', { workflowRunId: 'wr-1' });
      expect(received.ok).toBe(true);
      expect(received.metadata).toEqual({ processedAt: 42 });
    });

    it('should pass the command payload to the handler', async () => {
      const payloads: Array<AgentMessageInjectCommand> = [];
      bus.register('agent.message.inject', async (cmd) => {
        payloads.push(cmd);
        return { ok: true };
      });

      await bus.dispatch('agent.message.inject', {
        sessionId: 's1',
        message: 'hello',
        metadata: { source: 'test' },
      });

      expect(payloads).toHaveLength(1);
      expect(payloads[0].sessionId).toBe('s1');
      expect(payloads[0].message).toBe('hello');
      expect(payloads[0].metadata).toEqual({ source: 'test' });
    });

    it('should return failure results without throwing when the handler returns ok:false', async () => {
      bus.register('github.repo.watch', async () => ({
        ok: false,
        error: new Error('rate limited'),
        metadata: { retryAfter: 60 },
      }));

      const result = await bus.dispatch('github.repo.watch', { owner: 'acme', repo: 'demo' });
      expect(result.ok).toBe(false);
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toBe('rate limited');
      expect(result.metadata).toEqual({ retryAfter: 60 });
    });

    it('should normalize handler throws to a structured failure result', async () => {
      const err = new Error('handler blew up');
      bus.register('space.workflow.resume', async () => {
        throw err;
      });

      const result = await bus.dispatch('space.workflow.resume', { workflowRunId: 'wr-1' });
      expect(result.ok).toBe(false);
      expect(result.error).toBe(err);
    });

    it('should throw MissingCommandHandlerError when no handler is registered', async () => {
      await expect(
        bus.dispatch('space.workflow.resume', { workflowRunId: 'wr-1' })
      ).rejects.toBeInstanceOf(MissingCommandHandlerError);
    });

    it('should include the command name in the missing-handler error', async () => {
      try {
        await bus.dispatch('github.repo.watch', { owner: 'acme', repo: 'demo' });
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(MissingCommandHandlerError);
        const missing = e as MissingCommandHandlerError;
        expect(missing.commandName).toBe('github.repo.watch');
        expect(missing.message).toContain('github.repo.watch');
      }
    });
  });

  describe('unregister', () => {
    it('should remove the handler for a specific command', async () => {
      bus.register('space.workflow.resume', async () => ({ ok: true }));
      expect(bus.hasHandler('space.workflow.resume')).toBe(true);

      bus.unregister('space.workflow.resume');
      expect(bus.hasHandler('space.workflow.resume')).toBe(false);
    });

    it('should make the command undispatchable after unregister', async () => {
      bus.register('space.workflow.resume', async () => ({ ok: true }));
      bus.unregister('space.workflow.resume');

      await expect(
        bus.dispatch('space.workflow.resume', { workflowRunId: 'wr-1' })
      ).rejects.toBeInstanceOf(MissingCommandHandlerError);
    });
  });

  describe('unsubscribe returned by register', () => {
    it('should remove the handler when called', async () => {
      const unsub = bus.register('space.workflow.resume', async () => ({ ok: true }));
      expect(bus.hasHandler('space.workflow.resume')).toBe(true);

      unsub();
      expect(bus.hasHandler('space.workflow.resume')).toBe(false);
    });

    it('should allow re-registration after unsubscribe', () => {
      const unsub = bus.register('space.workflow.resume', async () => ({ ok: true }));
      unsub();

      expect(() => bus.register('space.workflow.resume', async () => ({ ok: true }))).not.toThrow();
      expect(bus.hasHandler('space.workflow.resume')).toBe(true);
    });

    it('should not remove a newer handler when a stale unsubscribe is called', async () => {
      const unsubA = bus.register('space.workflow.resume', async () => ({
        ok: true,
        metadata: { version: 'A' },
      }));
      unsubA();

      bus.register('space.workflow.resume', async () => ({ ok: true, metadata: { version: 'B' } }));

      unsubA();
      expect(bus.hasHandler('space.workflow.resume')).toBe(true);

      const result = await bus.dispatch('space.workflow.resume', { workflowRunId: 'wr-1' });
      expect(result.ok).toBe(true);
      expect(result.metadata).toEqual({ version: 'B' });
    });
  });

  describe('clear', () => {
    it('should remove all handlers', () => {
      bus.register('space.workflow.resume', async () => ({ ok: true }));
      bus.register('github.repo.watch', async () => ({ ok: true }));

      bus.clear();

      expect(bus.hasHandler('space.workflow.resume')).toBe(false);
      expect(bus.hasHandler('github.repo.watch')).toBe(false);
      expect(bus.getHandlerCount()).toBe(0);
    });
  });

  describe('diagnostics', () => {
    it('should report correct handler count', () => {
      expect(bus.getHandlerCount()).toBe(0);
      bus.register('space.workflow.resume', async () => ({ ok: true }));
      expect(bus.getHandlerCount()).toBe(1);
      bus.register('github.repo.watch', async () => ({ ok: true }));
      expect(bus.getHandlerCount()).toBe(2);
    });

    it('should report hasHandler correctly', () => {
      expect(bus.hasHandler('space.workflow.resume')).toBe(false);
      bus.register('space.workflow.resume', async () => ({ ok: true }));
      expect(bus.hasHandler('space.workflow.resume')).toBe(true);
      expect(bus.hasHandler('github.repo.watch')).toBe(false);
    });
  });

  describe('createInternalCommandBus factory', () => {
    it('should produce a working typed bus', async () => {
      const factoryBus = createInternalCommandBus<TestCommandMap>();
      factoryBus.register('space.workflow.resume', async () => ({ ok: true }));

      const result = await factoryBus.dispatch('space.workflow.resume', {
        workflowRunId: 'factory-test',
      });
      expect(result.ok).toBe(true);
    });
  });
});
