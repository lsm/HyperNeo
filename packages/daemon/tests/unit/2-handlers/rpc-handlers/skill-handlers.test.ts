import { describe, expect, it, beforeEach, mock, afterEach } from 'bun:test';
import { MessageHub } from '@hyperneo/shared';
import { registerSkillHandlers } from '../../../../src/lib/rpc-handlers/skill-handlers';
import type { SkillsManager } from '../../../../src/lib/skills-manager';
import type { AppSkill, CreateSkillParams, UpdateSkillParams } from '@hyperneo/shared';

const mockSkill: AppSkill = {
  id: 'skill-1',
  name: 'test-skill',
  displayName: 'Test Skill',
  description: 'A test skill',
  sourceType: 'builtin',
  config: { type: 'builtin', commandName: '/test' },
  enabled: true,
  builtIn: false,
  validationStatus: 'valid',
  createdAt: Date.now(),
};

const createSkillParams: CreateSkillParams = {
  name: 'new-skill',
  displayName: 'New Skill',
  description: 'A new skill',
  sourceType: 'builtin',
  config: { type: 'builtin', commandName: '/new' },
  enabled: true,
  validationStatus: 'pending',
};

const updateSkillParams: UpdateSkillParams = {
  displayName: 'Updated Skill',
  description: 'Updated description',
};

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): {
  hub: MessageHub;
  handlers: Map<string, RequestHandler>;
} {
  const handlers = new Map<string, RequestHandler>();

  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    onEvent: mock(() => () => {}),
    request: mock(async () => {}),
    event: mock(() => {}),
    joinChannel: mock(async () => {}),
    leaveChannel: mock(async () => {}),
    isConnected: mock(() => true),
    getState: mock(() => 'connected' as const),
    onConnection: mock(() => () => {}),
    onMessage: mock(() => () => {}),
    cleanup: mock(() => {}),
    registerTransport: mock(() => () => {}),
    registerRouter: mock(() => {}),
    getRouter: mock(() => null),
    getPendingCallCount: mock(() => 0),
  } as unknown as MessageHub;

  return { hub, handlers };
}

function createMockSkillsManager() {
  return {
    listSkills: mock(() => [mockSkill]),
    getSkill: mock((id: string) => (id === mockSkill.id ? mockSkill : null)),
    addSkill: mock((params: CreateSkillParams) => ({
      ...mockSkill,
      id: 'skill-new',
      name: params.name,
      displayName: params.displayName,
    })),
    updateSkill: mock((id: string, params: UpdateSkillParams) => ({
      ...mockSkill,
      ...params,
    })),
    removeSkill: mock((id: string) => id === mockSkill.id),
    setSkillEnabled: mock((id: string, enabled: boolean) => ({
      ...mockSkill,
      enabled,
    })),
  } as unknown as SkillsManager;
}

function createMockDaemonHub() {
  return {
    emit: mock(() => Promise.resolve()),
    on: mock(() => () => {}),
  } as unknown as import('../../../../tests/helpers/daemon-hub').DaemonHub;
}

describe('Skill RPC Handlers', () => {
  let hubData: ReturnType<typeof createMockMessageHub>;
  let skillsManager: ReturnType<typeof createMockSkillsManager>;
  let daemonHub: ReturnType<typeof createMockDaemonHub>;
  let internalEventBus: { publish: any; publish: any; subscribe: any };

  beforeEach(() => {
    hubData = createMockMessageHub();
    skillsManager = createMockSkillsManager();
    daemonHub = createMockDaemonHub();

    internalEventBus = {
      publish: mock(async () => {}),
      subscribe: mock(() => () => {}),
    } as unknown as InternalEventBus<any>;

    registerSkillHandlers(hubData.hub, skillsManager, internalEventBus);
  });

  afterEach(() => {
    mock.restore();
  });

  describe('skill.list', () => {
    it('returns all skills', async () => {
      const handler = hubData.handlers.get('skill.list');
      expect(handler).toBeDefined();

      const result = (await handler!({}, {})) as { skills: AppSkill[] };
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].id).toBe('skill-1');
      expect(skillsManager.listSkills).toHaveBeenCalledTimes(1);
    });
  });

  describe('skill.get', () => {
    it('returns a skill by id', async () => {
      const handler = hubData.handlers.get('skill.get');
      expect(handler).toBeDefined();

      const result = (await handler!({ id: 'skill-1' }, {})) as { skill: AppSkill };
      expect(result.skill).toBeDefined();
      expect(result.skill!.id).toBe('skill-1');
      expect(skillsManager.getSkill).toHaveBeenCalledWith('skill-1');
    });

    it('returns null for non-existent skill', async () => {
      const handler = hubData.handlers.get('skill.get');
      const result = (await handler!({ id: 'nonexistent' }, {})) as { skill: AppSkill | null };
      expect(result.skill).toBeNull();
    });

    it('throws if id is missing', async () => {
      const handler = hubData.handlers.get('skill.get');
      await expect(handler!({}, {})).rejects.toThrow('id is required');
    });
  });

  describe('skill.create', () => {
    it('creates a skill and emits skills.changed', async () => {
      const handler = hubData.handlers.get('skill.create');
      expect(handler).toBeDefined();

      const result = (await handler!({ params: createSkillParams }, {})) as { skill: AppSkill };
      expect(result.skill).toBeDefined();
      expect(result.skill.name).toBe('new-skill');
      expect(result.skill.id).toBe('skill-new');
      expect(skillsManager.addSkill).toHaveBeenCalledWith(createSkillParams);
      expect(internalEventBus.publish).toHaveBeenCalledWith('skills.changed', {
        sessionId: 'global',
      });
    });

    it('throws if params is missing', async () => {
      const handler = hubData.handlers.get('skill.create');
      await expect(handler!({}, {})).rejects.toThrow('params is required');
    });

    it('surfaces validation errors from SkillsManager', async () => {
      skillsManager.addSkill = mock(() => {
        throw new Error('sourceType "plugin" must match config.type "builtin"');
      }) as unknown as SkillsManager['addSkill'];

      const handler = hubData.handlers.get('skill.create');
      await expect(handler!({ params: createSkillParams }, {})).rejects.toThrow(
        'sourceType "plugin" must match config.type "builtin"'
      );
    });

    it('surfaces duplicate name error from SkillsManager', async () => {
      skillsManager.addSkill = mock(() => {
        throw new Error('A skill named "new-skill" already exists');
      }) as unknown as SkillsManager['addSkill'];

      const handler = hubData.handlers.get('skill.create');
      await expect(handler!({ params: createSkillParams }, {})).rejects.toThrow(
        'A skill named "new-skill" already exists'
      );
    });
  });

  describe('skill.update', () => {
    it('updates a skill and emits skills.changed', async () => {
      const handler = hubData.handlers.get('skill.update');
      expect(handler).toBeDefined();

      const result = (await handler!({ id: 'skill-1', params: updateSkillParams }, {})) as {
        skill: AppSkill;
      };
      expect(result.skill).toBeDefined();
      expect(result.skill.displayName).toBe('Updated Skill');
      expect(skillsManager.updateSkill).toHaveBeenCalledWith('skill-1', updateSkillParams);
      expect(internalEventBus.publish).toHaveBeenCalledWith('skills.changed', {
        sessionId: 'global',
      });
    });

    it('throws if id is missing', async () => {
      const handler = hubData.handlers.get('skill.update');
      await expect(handler!({ params: updateSkillParams }, {})).rejects.toThrow('id is required');
    });

    it('throws if params is missing', async () => {
      const handler = hubData.handlers.get('skill.update');
      await expect(handler!({ id: 'skill-1' }, {})).rejects.toThrow('params is required');
    });

    it('surfaces "not found" error from SkillsManager', async () => {
      skillsManager.updateSkill = mock(() => {
        throw new Error('Skill not found: nonexistent-id');
      }) as unknown as SkillsManager['updateSkill'];

      const handler = hubData.handlers.get('skill.update');
      await expect(
        handler!({ id: 'nonexistent-id', params: updateSkillParams }, {})
      ).rejects.toThrow('Skill not found: nonexistent-id');
    });
  });

  describe('skill.delete', () => {
    it('removes a skill and emits skills.changed', async () => {
      const handler = hubData.handlers.get('skill.delete');
      expect(handler).toBeDefined();

      const result = (await handler!({ id: 'skill-1' }, {})) as { success: boolean };
      expect(result.success).toBe(true);
      expect(skillsManager.removeSkill).toHaveBeenCalledWith('skill-1');
      expect(internalEventBus.publish).toHaveBeenCalledWith('skills.changed', {
        sessionId: 'global',
      });
    });

    it('throws if id is missing', async () => {
      const handler = hubData.handlers.get('skill.delete');
      await expect(handler!({}, {})).rejects.toThrow('id is required');
    });

    it('throws if skill cannot be removed (not found or built-in)', async () => {
      skillsManager.removeSkill = mock(() => false);

      const handler = hubData.handlers.get('skill.delete');
      await expect(handler!({ id: 'nonexistent' }, {})).rejects.toThrow(
        'Skill not found or cannot be removed: nonexistent'
      );
    });
  });

  describe('skill.setEnabled', () => {
    it('enables a skill and emits skills.changed', async () => {
      const handler = hubData.handlers.get('skill.setEnabled');
      expect(handler).toBeDefined();

      const result = (await handler!({ id: 'skill-1', enabled: false }, {})) as {
        skill: AppSkill;
      };
      expect(result.skill).toBeDefined();
      expect(result.skill.enabled).toBe(false);
      expect(skillsManager.setSkillEnabled).toHaveBeenCalledWith('skill-1', false);
      expect(internalEventBus.publish).toHaveBeenCalledWith('skills.changed', {
        sessionId: 'global',
      });
    });

    it('throws if id is missing', async () => {
      const handler = hubData.handlers.get('skill.setEnabled');
      await expect(handler!({ enabled: true }, {})).rejects.toThrow('id is required');
    });

    it('throws if enabled is not a boolean', async () => {
      const handler = hubData.handlers.get('skill.setEnabled');
      await expect(handler!({ id: 'skill-1', enabled: 'yes' }, {})).rejects.toThrow(
        'enabled must be a boolean'
      );
    });

    it('surfaces "not found" error from SkillsManager', async () => {
      skillsManager.setSkillEnabled = mock(() => {
        throw new Error('Skill not found: nonexistent');
      }) as unknown as SkillsManager['setSkillEnabled'];

      const handler = hubData.handlers.get('skill.setEnabled');
      await expect(handler!({ id: 'nonexistent', enabled: true }, {})).rejects.toThrow(
        'Skill not found: nonexistent'
      );
    });
  });
});
