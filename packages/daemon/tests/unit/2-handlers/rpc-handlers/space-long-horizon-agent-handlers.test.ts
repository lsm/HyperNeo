import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageHub } from '@neokai/shared';
import { setupSpaceLongHorizonAgentHandlers } from '../../../../src/lib/rpc-handlers/space-long-horizon-agent-handlers';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import type { SpaceLongHorizonAgentRepository } from '../../../../src/storage/repositories/space-long-horizon-agent-repository';

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

function createMockSpaceManager(): SpaceManager {
  type GetSpaceResult = Awaited<ReturnType<SpaceManager['getSpace']>>;
  return {
    getSpace: mock(async (spaceId: string): Promise<GetSpaceResult> => {
      return spaceId === 'space-1' ? ({ id: 'space-1' } as Exclude<GetSpaceResult, null>) : null;
    }),
  } as unknown as SpaceManager;
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

describe('Space long-horizon agent handlers', () => {
  let hubData: ReturnType<typeof createMockMessageHub>;
  let repo: SpaceLongHorizonAgentRepository;
  let runtimeService: {
    refreshLongHorizonAgentSubscriptions: ReturnType<typeof mock>;
    refreshLongHorizonSubscription: ReturnType<typeof mock>;
    removeLongHorizonSubscription: ReturnType<typeof mock>;
    removeLongHorizonAgentSubscriptions: ReturnType<typeof mock>;
  };

  beforeEach(() => {
    hubData = createMockMessageHub();
    repo = {
      ensureCoordinator: mock(() => {}),
      listBySpaceId: mock(() => []),
      create: mock((params) => ({
        id: params.id ?? 'agent-new',
        ...params,
        spaceId: params.spaceId,
      })),
      getById: mock(() => ({ id: 'agent-1', spaceId: 'space-1' })),
      getByHandle: mock(() => null),
      update: mock((agentId, params) => ({ id: agentId, spaceId: 'space-1', ...params })),
      delete: mock(() => {}),
      listReminders: mock(() => []),
      createReminder: mock(() => ({})),
      deleteReminder: mock(() => {}),
      listSubscriptions: mock(() => []),
      createSubscription: mock((params) => ({
        id: 'sub-1',
        ...params,
        status: params.status ?? 'active',
      })),
      getSubscription: mock(() => ({
        id: 'sub-1',
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/*/*/pull_request/*',
        filter: {},
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      })),
      updateSubscription: mock((subscriptionId, params) => ({
        id: subscriptionId,
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: params.source ?? 'github',
        topic: params.topic ?? 'github/*/*/pull_request/*',
        filter: params.filter ?? {},
        status: params.status ?? 'active',
        createdAt: 1,
        updatedAt: 2,
      })),
      deleteSubscription: mock(() => {}),
    } as unknown as SpaceLongHorizonAgentRepository;
    runtimeService = {
      refreshLongHorizonAgentSubscriptions: mock(() => ({ success: true })),
      refreshLongHorizonSubscription: mock(() => ({ success: true })),
      removeLongHorizonSubscription: mock(() => {}),
      removeLongHorizonAgentSubscriptions: mock(() => {}),
    };
    setupSpaceLongHorizonAgentHandlers(hubData.hub, createMockSpaceManager(), repo, runtimeService);
  });

  describe('spaceLongHorizonAgent.create', () => {
    it('uses a non-conflicting mirror handle when requested handle belongs to another row', async () => {
      repo.getByHandle = mock(() => ({
        id: 'standalone-agent',
        spaceId: 'space-1',
        handle: 'researcher',
      })) as SpaceLongHorizonAgentRepository['getByHandle'];
      repo.listBySpaceId = mock(() => [
        { id: 'standalone-agent', spaceId: 'space-1', handle: 'researcher' },
        { id: 'existing-events-agent', spaceId: 'space-1', handle: 'researcher-events' },
      ]) as SpaceLongHorizonAgentRepository['listBySpaceId'];

      const result = await call<{ agent: { id: string; handle: string } }>(
        hubData.handlers,
        'spaceLongHorizonAgent.create',
        {
          id: 'visible-agent',
          spaceId: 'space-1',
          handle: 'researcher',
          displayName: 'Researcher',
        }
      );

      expect(result.agent).toEqual(
        expect.objectContaining({ id: 'visible-agent', handle: 'researcher-events-2' })
      );
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'visible-agent', handle: 'researcher-events-2' })
      );
    });
  });

  describe('spaceLongHorizonAgent.update', () => {
    it('refreshes durable subscriptions after policy updates', async () => {
      const result = await call<{ agent: { id: string; status: string } }>(
        hubData.handlers,
        'spaceLongHorizonAgent.update',
        {
          agentId: 'agent-1',
          spaceId: 'space-1',
          status: 'paused',
          handle: 'coder',
          provider: 'openrouter',
          settingSources: ['project'],
          toolPermissions: { tools: ['Read'] },
        }
      );

      expect(result.agent).toEqual(expect.objectContaining({ id: 'agent-1', status: 'paused' }));
      expect(repo.update).toHaveBeenCalledWith(
        'agent-1',
        expect.objectContaining({
          status: 'paused',
          handle: 'coder',
          provider: 'openrouter',
          settingSources: ['project'],
          toolPermissions: { tools: ['Read'] },
        })
      );
      expect(runtimeService.refreshLongHorizonAgentSubscriptions).toHaveBeenCalledWith(
        'space-1',
        'agent-1'
      );
    });
  });

  describe('spaceLongHorizonAgent.delete', () => {
    it('removes runtime subscriptions before deleting the agent row', async () => {
      const result = await call<{ success: boolean }>(
        hubData.handlers,
        'spaceLongHorizonAgent.delete',
        {
          agentId: 'agent-1',
          spaceId: 'space-1',
        }
      );

      expect(result).toEqual({ success: true });
      expect(runtimeService.removeLongHorizonAgentSubscriptions).toHaveBeenCalledWith(
        'space-1',
        'agent-1'
      );
      expect(repo.delete).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('spaceLongHorizonAgent.subscriptions', () => {
    it('lists subscriptions for an agent', async () => {
      const result = await call<{ subscriptions: unknown[] }>(
        hubData.handlers,
        'spaceLongHorizonAgent.listSubscriptions',
        { agentId: 'agent-1', spaceId: 'space-1' }
      );

      expect(result.subscriptions).toEqual([]);
      expect(repo.listSubscriptions).toHaveBeenCalledWith('agent-1');
    });

    it('creates subscriptions and refreshes runtime target', async () => {
      const result = await call<{ subscription: { id: string; topic: string } }>(
        hubData.handlers,
        'spaceLongHorizonAgent.createSubscription',
        {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/*/*/pull_request/*',
          filter: { label: 'PRs' },
        }
      );

      expect(result.subscription.id).toBe('sub-1');
      expect(repo.createSubscription).toHaveBeenCalledWith({
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/*/*/pull_request/*',
        filter: { label: 'PRs' },
        status: undefined,
      });
      expect(runtimeService.refreshLongHorizonSubscription).toHaveBeenCalledWith(
        'space-1',
        'sub-1'
      );
    });

    it('rejects unregistered subscription sources', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'gihub',
          topic: 'lsm/neokai/pull_request/*',
        })
      ).rejects.toThrow('Source "gihub" is not registered');
    });

    it('rejects full topics whose source differs from the source field', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'space/task.done',
        })
      ).rejects.toThrow('Topic source "space" does not match source "github"');
    });

    it('rejects full topics whose source casing differs from the source field', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'GitHub/lsm/neokai/pull_request/*',
        })
      ).rejects.toThrow('Topic source "GitHub" does not match source "github"');
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'Space/task.done',
        })
      ).rejects.toThrow('Topic source "Space" does not match source "github"');
    });

    it('accepts GitHub owner/repo topic shorthands before known-source prefix checks', async () => {
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'space/neokai/pull_request/*',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/neokai/pull_request/*',
      });

      expect(repo.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'space/neokai/pull_request/*' })
      );
      expect(repo.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'github/neokai/pull_request/*' })
      );
    });

    it('rejects slash-separated GitHub entity actions', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request/42/closed',
        })
      ).rejects.toThrow(
        'GitHub topic "owner/repo/pull_request/42/closed" must use dotted entity actions like "pull_request/42.closed"'
      );
    });

    it('rejects GitHub entity patterns without dotted actions', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request/42',
        })
      ).rejects.toThrow(
        'GitHub topic "owner/repo/pull_request/42" must use dotted entity actions like "pull_request/42.opened"'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/owner/repo/pull_request/42',
        })
      ).rejects.toThrow(
        'GitHub topic "github/owner/repo/pull_request/42" must use dotted entity actions like "pull_request/42.opened"'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'pull_request/42',
        })
      ).rejects.toThrow(
        'GitHub topic "pull_request/42" must use dotted entity actions like "pull_request/42.opened"'
      );
    });

    it('rejects unsupported GitHub resources in exact and bare patterns', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/issue/42.opened',
        })
      ).rejects.toThrow(
        'GitHub topic "owner/repo/issue/42.opened" uses unsupported resource "issue"; supported resources: pull_request'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/owner/repo/issue/42.opened',
        })
      ).rejects.toThrow(
        'GitHub topic "github/owner/repo/issue/42.opened" uses unsupported resource "issue"; supported resources: pull_request'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'issue',
        })
      ).rejects.toThrow(
        'GitHub topic "issue" uses unsupported resource "issue"; supported resources: pull_request'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'issue.opened',
        })
      ).rejects.toThrow(
        'GitHub topic "issue.opened" uses unsupported resource "issue"; supported resources: pull_request'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/issue.opened',
        })
      ).rejects.toThrow(
        'GitHub topic "owner/repo/issue.opened" uses unsupported resource "issue"; supported resources: pull_request'
      );
    });

    it('rejects malformed GitHub entity actions and overlong shapes', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request/.opened',
        })
      ).rejects.toThrow(
        'GitHub topic "owner/repo/pull_request/.opened" must use dotted entity actions like "pull_request/42.opened"'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request/42.',
        })
      ).rejects.toThrow(
        'GitHub topic "owner/repo/pull_request/42." must use dotted entity actions like "pull_request/42.opened"'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request/42.opened.extra',
        })
      ).rejects.toThrow(
        'GitHub topic "owner/repo/pull_request/42.opened.extra" must use dotted entity actions like "pull_request/42.opened"'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request/42.opened/extra/x',
        })
      ).rejects.toThrow(
        'GitHub topic "owner/repo/pull_request/42.opened/extra/x" must match supported shape "owner/repo/pull_request/<id>.<action>"'
      );
    });

    it('expands GitHub resource shorthands with entity wildcards', async () => {
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'pull_request.closed',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'pull_request',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'owner/repo/pull_request',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/owner/repo/pull_request',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'owner/repo/pull_request.closed',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/pull_request.closed',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/pull_request',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/pull_request/*.closed',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/pull_request/42.closed',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/neokai/pull_request/*',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'space/neokai/pull_request',
      });
      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'github/neokai/pull_request.closed',
      });

      expect(repo.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'github/neokai/pull_request/*' })
      );
      expect(repo.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'space/neokai/pull_request' })
      );
      expect(repo.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'github/neokai/pull_request.closed' })
      );

      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'pull_request.closed',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/*/*/pull_request/*.closed',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/*/*/pull_request/*.closed'
      );

      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'pull_request',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/*/*/pull_request/*',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/*/*/pull_request/*'
      );

      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/pull_request.closed',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/*/*/pull_request/*.closed',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/*/*/pull_request/*.closed'
      );

      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/pull_request',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/*/*/pull_request/*',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/*/*/pull_request/*'
      );

      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/owner/repo/pull_request/*',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/owner/repo/pull_request/*'
      );

      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/owner/repo/pull_request',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/owner/repo/pull_request/*',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/owner/repo/pull_request/*'
      );

      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request.closed',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/owner/repo/pull_request/*.closed',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/owner/repo/pull_request/*.closed'
      );
    });

    it('rejects duplicate canonical subscription patterns', async () => {
      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/*/*/pull_request/*',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: '*/*/pull_request/*',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/*/*/pull_request/*'
      );
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'github/*/*/pull_request/*',
          filter: { label: 'Duplicate label' },
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/*/*/pull_request/*'
      );
    });

    it('rejects case-only duplicate event patterns', async () => {
      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request/*',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'Owner/Repo/pull_request/*',
        })
      ).rejects.toThrow(
        'Subscription pattern duplicates existing subscription sub-existing: github/Owner/Repo/pull_request/*'
      );
    });

    it('allows non-duplicate subscription patterns for the same agent', async () => {
      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-existing',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'owner/repo/pull_request/*',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      await call(hubData.handlers, 'spaceLongHorizonAgent.createSubscription', {
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: 'github',
        topic: 'owner/repo/pull_request/*.closed',
      });

      expect(repo.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'owner/repo/pull_request/*.closed' })
      );
    });

    it('skips invalid existing subscriptions during duplicate checks', async () => {
      repo.listSubscriptions = mock(() => [
        {
          id: 'sub-invalid',
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'space/task.done',
          filter: {},
          status: 'active',
          createdAt: 1,
          updatedAt: 1,
        },
      ]) as unknown as SpaceLongHorizonAgentRepository['listSubscriptions'];

      const result = await call<{ subscription: { id: string } }>(
        hubData.handlers,
        'spaceLongHorizonAgent.createSubscription',
        {
          spaceId: 'space-1',
          agentId: 'agent-1',
          source: 'github',
          topic: 'pull_request',
        }
      );

      expect(result.subscription.id).toBe('sub-1');
      expect(repo.createSubscription).toHaveBeenCalledWith(
        expect.objectContaining({ topic: 'pull_request' })
      );
    });

    it('updates subscriptions and refreshes runtime target', async () => {
      await call(hubData.handlers, 'spaceLongHorizonAgent.updateSubscription', {
        subscriptionId: 'sub-1',
        spaceId: 'space-1',
        status: 'paused',
      });

      expect(repo.updateSubscription).toHaveBeenCalledWith('sub-1', { status: 'paused' });
      expect(runtimeService.refreshLongHorizonSubscription).toHaveBeenCalledWith(
        'space-1',
        'sub-1'
      );
    });

    it('allows status-only updates for wildcard-source subscriptions', async () => {
      repo.getSubscription = mock(() => ({
        id: 'sub-wildcard',
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: '*',
        topic: '*/space/task.updated',
        filter: {},
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      })) as unknown as SpaceLongHorizonAgentRepository['getSubscription'];
      repo.updateSubscription = mock((subscriptionId, params) => ({
        id: subscriptionId,
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: '*',
        topic: '*/space/task.updated',
        filter: {},
        status: params.status ?? 'active',
        createdAt: 1,
        updatedAt: 2,
      })) as unknown as SpaceLongHorizonAgentRepository['updateSubscription'];

      await call(hubData.handlers, 'spaceLongHorizonAgent.updateSubscription', {
        subscriptionId: 'sub-wildcard',
        spaceId: 'space-1',
        status: 'paused',
      });

      expect(repo.updateSubscription).toHaveBeenCalledWith('sub-wildcard', { status: 'paused' });
    });

    it('rejects topic edits for wildcard-source subscriptions', async () => {
      repo.getSubscription = mock(() => ({
        id: 'sub-wildcard',
        spaceId: 'space-1',
        agentId: 'agent-1',
        source: '*',
        topic: '*/space/task.updated',
        filter: {},
        status: 'active',
        createdAt: 1,
        updatedAt: 1,
      })) as unknown as SpaceLongHorizonAgentRepository['getSubscription'];

      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.updateSubscription', {
          subscriptionId: 'sub-wildcard',
          spaceId: 'space-1',
          topic: '*/space/task.done',
        })
      ).rejects.toThrow('Source "*" must be lowercase');
    });

    it('deletes subscriptions and removes runtime target before deleting row', async () => {
      const result = await call<{ success: boolean }>(
        hubData.handlers,
        'spaceLongHorizonAgent.deleteSubscription',
        { subscriptionId: 'sub-1', spaceId: 'space-1' }
      );

      expect(result).toEqual({ success: true });
      expect(runtimeService.removeLongHorizonSubscription).toHaveBeenCalledWith('space-1', 'sub-1');
      expect(repo.deleteSubscription).toHaveBeenCalledWith('sub-1');
    });
  });

  describe('spaceLongHorizonAgent.listBuiltInTemplates', () => {
    it('registers the handler', () => {
      expect(hubData.handlers.has('spaceLongHorizonAgent.listBuiltInTemplates')).toBe(true);
    });

    it('returns built-in long-horizon agent templates', async () => {
      const result = await call<{
        templates: Array<{
          key: string;
          suggestedEventSubscriptions: unknown[];
          reminderDefaults: unknown[];
          ownershipPatterns: unknown[];
        }>;
      }>(hubData.handlers, 'spaceLongHorizonAgent.listBuiltInTemplates', {
        spaceId: 'space-1',
      });

      expect(result.templates).toHaveLength(9);
      expect(result.templates.map((template) => template.key)).toContain('coordinator.default');
      for (const template of result.templates) {
        expect(template.suggestedEventSubscriptions.length).toBeGreaterThan(0);
        expect(template.reminderDefaults.length).toBeGreaterThan(0);
        expect(template.ownershipPatterns.length).toBeGreaterThan(0);
      }
    });

    it('throws when spaceId is missing', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.listBuiltInTemplates', {})
      ).rejects.toThrow('spaceId is required');
    });

    it('throws when space does not exist', async () => {
      await expect(
        call(hubData.handlers, 'spaceLongHorizonAgent.listBuiltInTemplates', {
          spaceId: 'missing-space',
        })
      ).rejects.toThrow('Space not found: missing-space');
    });
  });
});
