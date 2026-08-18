import { beforeEach, describe, expect, it } from 'bun:test';
import {
  createInternalQueryBus,
  DuplicateQueryHandlerError,
  InternalQueryBus,
  MissingQueryHandlerError,
  type RoomTasksListQuery,
  type RoomTasksListResult,
  type SpaceWorkflowRunGetQuery,
  type SpaceWorkflowRunGetResult,
} from '../../../../src/lib/internal-query-bus';

interface TestQueryMap {
  'space.workflowRun.get': { input: SpaceWorkflowRunGetQuery; output: SpaceWorkflowRunGetResult };
  'room.tasks.list': { input: RoomTasksListQuery; output: RoomTasksListResult };
  'app.health': { input: { component?: string }; output: { status: string } };
}

describe('InternalQueryBus', () => {
  let bus: InternalQueryBus<TestQueryMap>;

  beforeEach(() => {
    bus = new InternalQueryBus<TestQueryMap>();
  });

  describe('register', () => {
    it('should register a handler and return an unsubscribe function', () => {
      const unsub = bus.register('space.workflowRun.get', async () => ({ run: null }));
      expect(typeof unsub).toBe('function');
      expect(bus.hasHandler('space.workflowRun.get')).toBe(true);
    });

    it('should reject duplicate handlers for the same query', () => {
      bus.register('space.workflowRun.get', async () => ({ run: null }));

      expect(() => bus.register('space.workflowRun.get', async () => ({ run: null }))).toThrow(
        DuplicateQueryHandlerError
      );
    });

    it('should include the query name in the duplicate error', () => {
      bus.register('room.tasks.list', async () => ({ tasks: [] }));

      try {
        bus.register('room.tasks.list', async () => ({ tasks: [] }));
        expect.unreachable('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(DuplicateQueryHandlerError);
        const dup = e as DuplicateQueryHandlerError;
        expect(dup.queryName).toBe('room.tasks.list');
        expect(dup.message).toContain('room.tasks.list');
      }
    });
  });

  describe('execute', () => {
    it('should return the handler result on success', async () => {
      const result: SpaceWorkflowRunGetResult = { run: { id: 'wr-1', status: 'running' } };
      bus.register('space.workflowRun.get', async () => result);

      const received = await bus.execute('space.workflowRun.get', { runId: 'wr-1' });
      expect(received.ok).toBe(true);
      expect(received.data).toEqual(result);
    });

    it('should pass the query payload to the handler', async () => {
      const payloads: Array<RoomTasksListQuery> = [];
      bus.register('room.tasks.list', async (q) => {
        payloads.push(q);
        return { tasks: [] };
      });

      await bus.execute('room.tasks.list', { roomId: 'r1', includeArchived: true });

      expect(payloads).toHaveLength(1);
      expect(payloads[0].roomId).toBe('r1');
      expect(payloads[0].includeArchived).toBe(true);
    });

    it('should return data on a successful handler result', async () => {
      bus.register('app.health', async () => ({ status: 'ok' }));

      const received = await bus.execute('app.health', { component: 'db' });
      expect(received.ok).toBe(true);
      expect(received.data).toEqual({ status: 'ok' });
    });

    it('should return a structured failure when the handler throws', async () => {
      const err = new Error('db timeout');
      bus.register('space.workflowRun.get', async () => {
        throw err;
      });

      const result = await bus.execute('space.workflowRun.get', { runId: 'wr-1' });
      expect(result.ok).toBe(false);
      expect(result.error).toBe(err);
      expect(result.data).toBeUndefined();
    });

    it('should return a structured failure for a missing handler', async () => {
      const result = await bus.execute('space.workflowRun.get', { runId: 'wr-1' });
      expect(result.ok).toBe(false);
      expect(result.error).toBeInstanceOf(MissingQueryHandlerError);
      expect(result.data).toBeUndefined();
    });

    it('should include the query name in the missing-handler failure', async () => {
      const result = await bus.execute('room.tasks.list', { roomId: 'r1' });
      expect(result.ok).toBe(false);

      const missing = result.error as MissingQueryHandlerError;
      expect(missing.queryName).toBe('room.tasks.list');
      expect(missing.message).toContain('room.tasks.list');
    });

    it('should not throw when the handler throws (structured failure instead)', async () => {
      bus.register('app.health', async () => {
        throw new Error('unexpected');
      });

      await expect(bus.execute('app.health', { component: 'x' })).resolves.toMatchObject({
        ok: false,
      });
    });

    it('should not throw when no handler is registered (structured failure instead)', async () => {
      await expect(bus.execute('app.health', { component: 'x' })).resolves.toMatchObject({
        ok: false,
      });
    });
  });

  describe('unregister', () => {
    it('should remove the handler for a specific query', () => {
      bus.register('space.workflowRun.get', async () => ({ run: null }));
      expect(bus.hasHandler('space.workflowRun.get')).toBe(true);

      bus.unregister('space.workflowRun.get');
      expect(bus.hasHandler('space.workflowRun.get')).toBe(false);
    });

    it('should make the query return missing-handler after unregister', async () => {
      bus.register('space.workflowRun.get', async () => ({ run: null }));
      bus.unregister('space.workflowRun.get');

      const result = await bus.execute('space.workflowRun.get', { runId: 'wr-1' });
      expect(result.ok).toBe(false);
      expect(result.error).toBeInstanceOf(MissingQueryHandlerError);
    });
  });

  describe('unsubscribe returned by register', () => {
    it('should remove the handler when called', () => {
      const unsub = bus.register('space.workflowRun.get', async () => ({ run: null }));
      expect(bus.hasHandler('space.workflowRun.get')).toBe(true);

      unsub();
      expect(bus.hasHandler('space.workflowRun.get')).toBe(false);
    });

    it('should allow re-registration after unsubscribe', () => {
      const unsub = bus.register('space.workflowRun.get', async () => ({ run: null }));
      unsub();

      expect(() =>
        bus.register('space.workflowRun.get', async () => ({ run: null }))
      ).not.toThrow();
      expect(bus.hasHandler('space.workflowRun.get')).toBe(true);
    });

    it('should not remove a newer handler when a stale unsubscribe is called', async () => {
      const unsubA = bus.register('space.workflowRun.get', async () => ({
        run: { id: 'A' },
      }));
      unsubA();

      bus.register('space.workflowRun.get', async () => ({ run: { id: 'B' } }));

      unsubA();
      expect(bus.hasHandler('space.workflowRun.get')).toBe(true);

      const result = await bus.execute('space.workflowRun.get', { runId: 'wr-1' });
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ run: { id: 'B' } });
    });
  });

  describe('clear', () => {
    it('should remove all handlers', () => {
      bus.register('space.workflowRun.get', async () => ({ run: null }));
      bus.register('room.tasks.list', async () => ({ tasks: [] }));

      bus.clear();

      expect(bus.hasHandler('space.workflowRun.get')).toBe(false);
      expect(bus.hasHandler('room.tasks.list')).toBe(false);
      expect(bus.getHandlerCount()).toBe(0);
    });
  });

  describe('diagnostics', () => {
    it('should report correct handler count', () => {
      expect(bus.getHandlerCount()).toBe(0);
      bus.register('space.workflowRun.get', async () => ({ run: null }));
      expect(bus.getHandlerCount()).toBe(1);
      bus.register('room.tasks.list', async () => ({ tasks: [] }));
      expect(bus.getHandlerCount()).toBe(2);
    });

    it('should report hasHandler correctly', () => {
      expect(bus.hasHandler('space.workflowRun.get')).toBe(false);
      bus.register('space.workflowRun.get', async () => ({ run: null }));
      expect(bus.hasHandler('space.workflowRun.get')).toBe(true);
      expect(bus.hasHandler('room.tasks.list')).toBe(false);
    });
  });

  describe('createInternalQueryBus factory', () => {
    it('should produce a working typed bus', async () => {
      const factoryBus = createInternalQueryBus<TestQueryMap>();
      factoryBus.register('space.workflowRun.get', async () => ({
        run: { id: 'factory-test' },
      }));

      const result = await factoryBus.execute('space.workflowRun.get', { runId: 'factory-test' });
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ run: { id: 'factory-test' } });
    });
  });

  describe('structured failure shape', () => {
    it('should preserve the original error when handler throws', async () => {
      const err = new Error('downstream failure');
      bus.register('app.health', async () => {
        throw err;
      });

      const result = await bus.execute('app.health', {});
      expect(result.ok).toBe(false);
      expect(result.error).toBe(err);
    });

    it('should return ok:true with data when handler returns a falsy value', async () => {
      bus.register('space.workflowRun.get', async () => ({ run: null }));

      const result = await bus.execute('space.workflowRun.get', { runId: 'missing' });
      expect(result.ok).toBe(true);
      expect(result.data).toEqual({ run: null });
    });
  });
});
