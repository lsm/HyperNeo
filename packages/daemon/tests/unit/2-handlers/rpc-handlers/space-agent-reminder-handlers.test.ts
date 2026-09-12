import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageHub, SpaceLongHorizonAgentReminder } from '@hyperneo/shared';
import { setupSpaceAgentReminderHandlers } from '../../../../src/lib/rpc-handlers/space-agent-reminder-handlers';
import { SpaceAgentReminderRepository } from '../../../../src/storage/repositories/space-agent-reminder-repository';
import { SpaceAgentRepository } from '../../../../src/storage/repositories/space-agent-repository';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
  const handlers = new Map<string, RequestHandler>();
  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
  } as unknown as MessageHub;
  return { hub, handlers };
}

async function call<T>(
  handlers: Map<string, RequestHandler>,
  method: string,
  params: unknown
): Promise<T> {
  const handler = handlers.get(method);
  if (!handler) throw new Error(`Handler not registered: ${method}`);
  return (await handler(params, {})) as T;
}

describe('spaceAgentReminder RPC handlers', () => {
  let db: BunDatabase;
  let repo: SpaceAgentReminderRepository;
  let hubData: ReturnType<typeof createMockMessageHub>;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSpaceTables(db);
    db.prepare(
      `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('space-1', 'space-1', '/tmp/space-1', 'Space One', Date.now(), Date.now());
    db.prepare(
      `INSERT INTO space_long_horizon_agents
         (id, space_id, handle, display_name, status, autonomy_level, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 2, ?, ?)`
    ).run('agent-1', 'space-1', 'researcher', 'Researcher', Date.now(), Date.now());
    repo = new SpaceAgentReminderRepository(db, new SpaceAgentRepository(db));
    hubData = createMockMessageHub();
    setupSpaceAgentReminderHandlers(hubData.hub, { reminders: repo });
  });

  afterEach(() => {
    db.close();
    mock.restore();
  });

  it('registers every route under the spaceAgentReminder prefix', () => {
    expect([...hubData.handlers.keys()].sort()).toEqual([
      'spaceAgentReminder.create',
      'spaceAgentReminder.delete',
      'spaceAgentReminder.listCounts',
    ]);
  });

  describe('create', () => {
    it('stores an "at" reminder and seeds nextRunAt from runAt', async () => {
      const result = await call<{ reminder: SpaceLongHorizonAgentReminder }>(
        hubData.handlers,
        'spaceAgentReminder.create',
        {
          spaceId: 'space-1',
          agentId: 'agent-1',
          title: 'Check the PR',
          triggerType: 'at',
          runAt: 4242,
        }
      );

      expect(result.reminder.triggerType).toBe('at');
      expect(result.reminder.nextRunAt).toBe(4242);
      expect(repo.getReminder(result.reminder.id)?.title).toBe('Check the PR');
    });

    it('computes nextRunAt for a cron reminder', async () => {
      const result = await call<{ reminder: SpaceLongHorizonAgentReminder }>(
        hubData.handlers,
        'spaceAgentReminder.create',
        {
          spaceId: 'space-1',
          agentId: 'agent-1',
          title: 'Nag',
          triggerType: 'cron',
          cronExpression: '*/15 * * * *',
        }
      );

      expect(result.reminder.nextRunAt).toBeGreaterThan(Date.now() - 1000);
    });

    it.each([
      ['spaceId', { agentId: 'agent-1', title: 't', triggerType: 'at' }, 'spaceId is required'],
      ['agentId', { spaceId: 'space-1', title: 't', triggerType: 'at' }, 'agentId is required'],
      ['title', { spaceId: 'space-1', agentId: 'agent-1', triggerType: 'at' }, 'title is required'],
      [
        'triggerType',
        { spaceId: 'space-1', agentId: 'agent-1', title: 't' },
        'triggerType is required',
      ],
    ])('requires %s', async (_name, params, message) => {
      await expect(call(hubData.handlers, 'spaceAgentReminder.create', params)).rejects.toThrow(
        message
      );
    });

    it('requires runAt for an "at" reminder', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgentReminder.create', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          title: 't',
          triggerType: 'at',
        })
      ).rejects.toThrow('runAt is required for triggerType "at"');
    });

    it('requires a cronExpression for a cron reminder', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgentReminder.create', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          title: 't',
          triggerType: 'cron',
        })
      ).rejects.toThrow('cronExpression is required for triggerType "cron"');
    });

    it('rejects an invalid cron expression', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgentReminder.create', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          title: 't',
          triggerType: 'cron',
          cronExpression: 'not a cron',
        })
      ).rejects.toThrow('Invalid cron expression: not a cron');
    });

    it('propagates the repository agent-in-space guard', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgentReminder.create', {
          spaceId: 'space-1',
          agentId: 'missing',
          title: 't',
          triggerType: 'at',
          runAt: 1,
        })
      ).rejects.toThrow('Long-horizon agent not found: missing');
    });
  });

  describe('listCounts', () => {
    it('counts only active reminders per agent', async () => {
      repo.createReminder({
        spaceId: 'space-1',
        agentId: 'agent-1',
        title: 'a',
        triggerType: 'at',
      });
      repo.createReminder({
        spaceId: 'space-1',
        agentId: 'agent-1',
        title: 'b',
        triggerType: 'at',
        status: 'cancelled',
      });

      const result = await call<{ counts: Record<string, number> }>(
        hubData.handlers,
        'spaceAgentReminder.listCounts',
        { agentIds: ['agent-1'] }
      );

      expect(result.counts).toEqual({ 'agent-1': 1 });
    });

    it('requires an agentIds array', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgentReminder.listCounts', { agentIds: 'agent-1' })
      ).rejects.toThrow('agentIds is required');
    });
  });

  describe('delete', () => {
    it('removes an existing reminder', async () => {
      const reminder = repo.createReminder({
        spaceId: 'space-1',
        agentId: 'agent-1',
        title: 'a',
        triggerType: 'at',
      });

      await call(hubData.handlers, 'spaceAgentReminder.delete', { reminderId: reminder.id });

      expect(repo.getReminder(reminder.id)).toBeNull();
    });

    it('requires a reminderId', async () => {
      await expect(call(hubData.handlers, 'spaceAgentReminder.delete', {})).rejects.toThrow(
        'reminderId is required'
      );
    });

    it('rejects an unknown reminder', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgentReminder.delete', { reminderId: 'nope' })
      ).rejects.toThrow('Reminder not found: nope');
    });
  });
});
