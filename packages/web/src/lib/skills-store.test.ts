import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AppSkill, LiveQuerySnapshotEvent, LiveQueryDeltaEvent } from '@hyperneo/shared';

type EventHandler<T = unknown> = (data: T) => void;

interface MockHub {
  _handlers: Map<string, EventHandler[]>;
  _connectionHandlers: EventHandler[];
  onEvent: <T>(method: string, handler: EventHandler<T>) => () => void;
  onConnection: (handler: EventHandler<string>) => () => void;
  request: ReturnType<typeof vi.fn>;
  fire: <T>(method: string, data: T) => void;
  fireConnection: (state: string) => void;
}

function createMockHub(): MockHub {
  const _handlers = new Map<string, EventHandler[]>();
  const _connectionHandlers: EventHandler[] = [];
  return {
    _handlers,
    _connectionHandlers,
    onEvent: <T>(method: string, handler: EventHandler<T>) => {
      if (!_handlers.has(method)) _handlers.set(method, []);
      _handlers.get(method)!.push(handler as EventHandler);
      return () => {
        const list = _handlers.get(method);
        if (list) {
          const i = list.indexOf(handler as EventHandler);
          if (i >= 0) list.splice(i, 1);
        }
      };
    },
    onConnection: (handler: EventHandler<string>) => {
      _connectionHandlers.push(handler as EventHandler);
      return () => {
        const i = _connectionHandlers.indexOf(handler as EventHandler);
        if (i >= 0) _connectionHandlers.splice(i, 1);
      };
    },
    request: vi.fn(),
    fire: <T>(method: string, data: T) => {
      for (const h of _handlers.get(method) ?? []) h(data);
    },
    fireConnection: (state: string) => {
      for (const h of _connectionHandlers) h(state);
    },
  };
}

vi.mock('./connection-manager.ts', () => ({
  connectionManager: {
    getHub: vi.fn(),
    getHubIfConnected: vi.fn(),
  },
}));

import { connectionManager } from './connection-manager.js';
import { skillsStore } from './skills-store.js';

function makeSkill(id: string, overrides: Partial<AppSkill> = {}): AppSkill {
  return {
    id,
    name: `skill-${id}`,
    displayName: `Skill ${id}`,
    description: `Description for skill ${id}`,
    sourceType: 'builtin',
    config: { type: 'builtin', commandName: `cmd-${id}` },
    enabled: true,
    builtIn: false,
    validationStatus: 'valid',
    createdAt: Date.now(),
    ...overrides,
  };
}

const SUBSCRIPTION_ID = 'skills-global';

describe('SkillsStore', () => {
  let mockHub: MockHub;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHub = createMockHub();

    skillsStore.skills.value = [];
    skillsStore.isLoading.value = false;
    skillsStore.loaded.value = false;
    skillsStore.error.value = null;

    vi.mocked(connectionManager.getHub).mockResolvedValue(mockHub as never);
    vi.mocked(connectionManager.getHubIfConnected).mockReturnValue(mockHub as never);
    vi.mocked(mockHub.request).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    skillsStore.unsubscribe();
    skillsStore.unsubscribe();
  });

  describe('subscribe()', () => {
    it('should send liveQuery.subscribe request with skills.list query', async () => {
      await skillsStore.subscribe();
      expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
        queryName: 'skills.list',
        params: [],
        subscriptionId: SUBSCRIPTION_ID,
      });
    });

    it('should set isLoading true while awaiting snapshot', async () => {
      let resolveHub: (hub: MockHub) => void;
      const hubPromise = new Promise<MockHub>((resolve) => {
        resolveHub = (hub) => resolve(hub);
      });
      vi.mocked(connectionManager.getHub).mockReturnValue(hubPromise as never);

      const loadingValues: boolean[] = [];
      const unsub = skillsStore.isLoading.subscribe((v) => loadingValues.push(v));

      const subPromise = skillsStore.subscribe();

      resolveHub!(mockHub);

      await Promise.resolve();

      expect(skillsStore.isLoading.value).toBe(true);

      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [],
        version: 1,
      });

      await subPromise;
      expect(skillsStore.isLoading.value).toBe(false);

      unsub();
    });

    it('should start with loaded=false and flip to true on first snapshot', async () => {
      expect(skillsStore.loaded.value).toBe(false);

      await skillsStore.subscribe();
      expect(skillsStore.loaded.value).toBe(false);

      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [],
        version: 1,
      });
      expect(skillsStore.loaded.value).toBe(true);
    });

    it('should flip loaded=true even when the snapshot delivers zero rows', async () => {
      await skillsStore.subscribe();
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [],
        version: 1,
      });
      expect(skillsStore.loaded.value).toBe(true);
      expect(skillsStore.skills.value).toHaveLength(0);
    });

    it('should reset loaded=false on unsubscribe so the next mount re-arms the gate', async () => {
      await skillsStore.subscribe();
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeSkill('1')],
        version: 1,
      });
      expect(skillsStore.loaded.value).toBe(true);

      skillsStore.unsubscribe();
      expect(skillsStore.loaded.value).toBe(false);
    });

    it('should populate skills from snapshot rows', async () => {
      const skills = [makeSkill('1'), makeSkill('2')];

      await skillsStore.subscribe();
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: skills,
        version: 1,
      });

      expect(skillsStore.skills.value).toHaveLength(2);
      expect(skillsStore.skills.value[0].id).toBe('1');
      expect(skillsStore.skills.value[1].id).toBe('2');
    });

    it('should be idempotent — second subscribe() call is no-op', async () => {
      await skillsStore.subscribe();
      mockHub.request.mockClear();
      await skillsStore.subscribe();
      expect(mockHub.request).not.toHaveBeenCalled();
    });

    it('should set error signal and re-throw when hub subscription fails', async () => {
      vi.mocked(mockHub.request).mockRejectedValue(new Error('subscribe failed'));

      await expect(skillsStore.subscribe()).rejects.toThrow('subscribe failed');
      expect(skillsStore.error.value).toBe('subscribe failed');
      expect(skillsStore.isLoading.value).toBe(false);
    });

    it('should clean up handlers and clear activeSubscriptionIds on subscribe failure', async () => {
      vi.mocked(mockHub.request).mockRejectedValue(new Error('subscribe failed'));

      await expect(skillsStore.subscribe()).rejects.toThrow('subscribe failed');

      vi.mocked(mockHub.request).mockResolvedValue({ ok: true });
      await skillsStore.subscribe();

      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeSkill('fresh')],
        version: 1,
      });

      expect(skillsStore.skills.value).toHaveLength(1);
      expect(skillsStore.skills.value[0].id).toBe('fresh');
    });
  });

  describe('delta handling', () => {
    beforeEach(async () => {
      await skillsStore.subscribe();
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeSkill('1'), makeSkill('2')],
        version: 1,
      });
      expect(skillsStore.skills.value).toHaveLength(2);
    });

    it('should add new skills from delta.added', () => {
      mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
        subscriptionId: SUBSCRIPTION_ID,
        added: [makeSkill('3')],
        version: 2,
      });

      expect(skillsStore.skills.value).toHaveLength(3);
      expect(skillsStore.skills.value.find((s) => s.id === '3')).toBeDefined();
    });

    it('should remove skills from delta.removed', () => {
      mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
        subscriptionId: SUBSCRIPTION_ID,
        removed: [makeSkill('1')],
        version: 2,
      });

      expect(skillsStore.skills.value).toHaveLength(1);
      expect(skillsStore.skills.value.find((s) => s.id === '1')).toBeUndefined();
    });

    it('should update existing skills from delta.updated', () => {
      mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
        subscriptionId: SUBSCRIPTION_ID,
        updated: [makeSkill('1', { displayName: 'Updated Skill 1', enabled: false })],
        version: 2,
      });

      const skill1 = skillsStore.skills.value.find((s) => s.id === '1');
      expect(skill1?.displayName).toBe('Updated Skill 1');
      expect(skill1?.enabled).toBe(false);
    });

    it('should ignore delta with wrong subscriptionId', () => {
      mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
        subscriptionId: 'other-subscription',
        added: [makeSkill('99')],
        version: 2,
      });

      expect(skillsStore.skills.value).toHaveLength(2);
      expect(skillsStore.skills.value.find((s) => s.id === '99')).toBeUndefined();
    });

    it('should ignore snapshot with wrong subscriptionId', () => {
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: 'other-subscription',
        rows: [makeSkill('99')],
        version: 2,
      });

      expect(skillsStore.skills.value).toHaveLength(2);
    });
  });

  describe('stale-event guard', () => {
    it('should discard snapshot event fired after unsubscribe', async () => {
      await skillsStore.subscribe();

      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeSkill('pre-1')],
        version: 1,
      });
      expect(skillsStore.skills.value).toHaveLength(1);

      skillsStore.unsubscribe();

      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeSkill('stale-skill')],
        version: 2,
      });

      expect(skillsStore.skills.value).toHaveLength(0);
    });

    it('should discard delta event fired after unsubscribe', async () => {
      await skillsStore.subscribe();
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeSkill('1'), makeSkill('2')],
        version: 1,
      });
      expect(skillsStore.skills.value).toHaveLength(2);

      skillsStore.unsubscribe();

      mockHub.fire<LiveQueryDeltaEvent>('liveQuery.delta', {
        subscriptionId: SUBSCRIPTION_ID,
        added: [makeSkill('stale-add')],
        version: 2,
      });

      expect(skillsStore.skills.value).toHaveLength(0);
    });
  });

  describe('post-await unsubscribe race guard', () => {
    it('should not leave dangling handlers when unsubscribe races with hub resolution', async () => {
      let resolveRequest: () => void;
      const requestPromise = new Promise<void>((resolve) => {
        resolveRequest = () => resolve();
      });
      vi.mocked(mockHub.request).mockReturnValue(requestPromise as never);
      vi.mocked(connectionManager.getHub).mockResolvedValue(mockHub as never);

      const subPromise = skillsStore.subscribe();

      skillsStore.unsubscribe();

      resolveRequest!();

      await subPromise;

      expect(skillsStore.isLoading.value).toBe(false);
      expect(skillsStore.skills.value).toHaveLength(0);
    });
  });

  describe('WebSocket reconnect', () => {
    it('should re-subscribe with same subscriptionId on reconnect', async () => {
      await skillsStore.subscribe();

      mockHub.fireConnection('connected');

      expect(mockHub.request).toHaveBeenCalledWith('liveQuery.subscribe', {
        queryName: 'skills.list',
        params: [],
        subscriptionId: SUBSCRIPTION_ID,
      });
    });

    it('should set isLoading true before re-subscribe on reconnect', async () => {
      await skillsStore.subscribe();
      mockHub.request.mockClear();

      const loadingValues: boolean[] = [];
      const unsub = skillsStore.isLoading.subscribe((v) => loadingValues.push(v));

      mockHub.fireConnection('connected');

      expect(loadingValues).toContain(true);

      unsub();
    });

    it('should not re-subscribe for non-connected state changes', async () => {
      await skillsStore.subscribe();
      mockHub.request.mockClear();

      mockHub.fireConnection('disconnected');

      expect(mockHub.request).not.toHaveBeenCalled();
    });
  });

  describe('unsubscribe()', () => {
    it('should call liveQuery.unsubscribe', async () => {
      await skillsStore.subscribe();
      mockHub.request.mockClear();

      skillsStore.unsubscribe();

      expect(mockHub.request).toHaveBeenCalledWith('liveQuery.unsubscribe', {
        subscriptionId: SUBSCRIPTION_ID,
      });
    });

    it('should clear skills signal', async () => {
      await skillsStore.subscribe();
      mockHub.fire<LiveQuerySnapshotEvent>('liveQuery.snapshot', {
        subscriptionId: SUBSCRIPTION_ID,
        rows: [makeSkill('1')],
        version: 1,
      });
      expect(skillsStore.skills.value).toHaveLength(1);

      skillsStore.unsubscribe();

      expect(skillsStore.skills.value).toHaveLength(0);
    });

    it('should clear error signal', async () => {
      vi.mocked(mockHub.request).mockRejectedValue(new Error('fail'));
      await expect(skillsStore.subscribe()).rejects.toThrow();
      expect(skillsStore.error.value).not.toBeNull();

      skillsStore.unsubscribe();
      expect(skillsStore.error.value).toBeNull();
    });

    it('should be idempotent — second unsubscribe() call is no-op', async () => {
      await skillsStore.subscribe();
      skillsStore.unsubscribe();
      mockHub.request.mockClear();

      skillsStore.unsubscribe();

      expect(mockHub.request).not.toHaveBeenCalled();
    });

    it('should be safe to call before subscribe()', () => {
      expect(() => skillsStore.unsubscribe()).not.toThrow();
    });
  });

  describe('addSkill()', () => {
    it('should call skill.create RPC with params', async () => {
      const params = {
        name: 'new-skill',
        displayName: 'New Skill',
        description: 'A new skill',
        sourceType: 'builtin' as const,
        config: { type: 'builtin' as const, commandName: 'new-cmd' },
        enabled: true,
        validationStatus: 'pending' as const,
      };
      const created = makeSkill('new-id', { name: 'new-skill' });
      vi.mocked(mockHub.request).mockResolvedValue({ skill: created });

      const result = await skillsStore.addSkill(params);

      expect(mockHub.request).toHaveBeenCalledWith('skill.create', { params });
      expect(result).toEqual(created);
    });

    it('should propagate errors from skill.create', async () => {
      vi.mocked(mockHub.request).mockRejectedValue(new Error('create failed'));

      await expect(
        skillsStore.addSkill({
          name: 'x',
          displayName: 'X',
          description: '',
          sourceType: 'builtin',
          config: { type: 'builtin', commandName: 'x' },
          enabled: true,
          validationStatus: 'pending',
        })
      ).rejects.toThrow('create failed');
    });
  });

  describe('updateSkill()', () => {
    it('should call skill.update RPC with id and params', async () => {
      const updated = makeSkill('skill-1', { displayName: 'Updated' });
      vi.mocked(mockHub.request).mockResolvedValue({ skill: updated });

      const result = await skillsStore.updateSkill('skill-1', { displayName: 'Updated' });

      expect(mockHub.request).toHaveBeenCalledWith('skill.update', {
        id: 'skill-1',
        params: { displayName: 'Updated' },
      });
      expect(result.displayName).toBe('Updated');
    });

    it('should propagate errors from skill.update', async () => {
      vi.mocked(mockHub.request).mockRejectedValue(new Error('update failed'));

      await expect(skillsStore.updateSkill('skill-1', { displayName: 'X' })).rejects.toThrow(
        'update failed'
      );
    });
  });

  describe('removeSkill()', () => {
    it('should call skill.delete RPC with id and return success boolean', async () => {
      vi.mocked(mockHub.request).mockResolvedValue({ success: true });

      const result = await skillsStore.removeSkill('skill-1');

      expect(mockHub.request).toHaveBeenCalledWith('skill.delete', { id: 'skill-1' });
      expect(result).toBe(true);
    });

    it('should propagate errors from skill.delete', async () => {
      vi.mocked(mockHub.request).mockRejectedValue(new Error('delete failed'));

      await expect(skillsStore.removeSkill('skill-1')).rejects.toThrow('delete failed');
    });
  });

  describe('setEnabled()', () => {
    it('should call skill.setEnabled RPC with id and enabled=true', async () => {
      const updated = makeSkill('skill-1', { enabled: true });
      vi.mocked(mockHub.request).mockResolvedValue({ skill: updated });

      const result = await skillsStore.setEnabled('skill-1', true);

      expect(mockHub.request).toHaveBeenCalledWith('skill.setEnabled', {
        id: 'skill-1',
        enabled: true,
      });
      expect(result.enabled).toBe(true);
    });

    it('should call skill.setEnabled RPC with id and enabled=false', async () => {
      const updated = makeSkill('skill-1', { enabled: false });
      vi.mocked(mockHub.request).mockResolvedValue({ skill: updated });

      const result = await skillsStore.setEnabled('skill-1', false);

      expect(mockHub.request).toHaveBeenCalledWith('skill.setEnabled', {
        id: 'skill-1',
        enabled: false,
      });
      expect(result.enabled).toBe(false);
    });

    it('should propagate errors from skill.setEnabled', async () => {
      vi.mocked(mockHub.request).mockRejectedValue(new Error('setEnabled failed'));

      await expect(skillsStore.setEnabled('skill-1', true)).rejects.toThrow('setEnabled failed');
    });
  });
});
