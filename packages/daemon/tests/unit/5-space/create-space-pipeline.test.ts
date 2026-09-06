import { describe, expect, mock, test } from 'bun:test';
import type { CreateSpaceParams, Space } from '@hyperneo/shared';
import {
  assembleResult,
  type CreateSpaceCtx,
  type CreateSpaceDeps,
  createSpace,
  createSpaceRecord,
  ensureCoordinator,
  provisionChatSession,
  publishSpaceCreated,
  seedWorkflows,
  validateParams,
} from '../../../src/lib/space/create-space-pipeline.ts';

const params: CreateSpaceParams = { workspacePath: '/workspace', name: 'Test Space' };
const space: Space = {
  id: 'space-1',
  slug: 'test-space',
  workspacePath: '/workspace',
  name: 'Test Space',
  description: '',
  backgroundContext: '',
  instructions: '',
  defaultModel: 'claude-sonnet-5',
  sessionIds: [],
  status: 'active',
  paused: false,
  stopped: false,
  maxConcurrentTasks: 1,
  createdAt: 1,
  updatedAt: 1,
};

interface CallLog {
  calls: string[];
  sessionParams: unknown[];
  published: Space[];
}

function makeDeps(
  overrides: Partial<CreateSpaceDeps> = {},
  chat = true
): { deps: CreateSpaceDeps; log: CallLog } {
  const log: CallLog = { calls: [], sessionParams: [], published: [] };
  const deps: CreateSpaceDeps = {
    createSpaceRecord: async (input) => {
      log.calls.push(`create:${input.name}`);
      return space;
    },
    ensureCoordinator: (spaceId) => {
      log.calls.push(`coordinator:${spaceId}`);
    },
    seedWorkflows: (spaceId) => {
      log.calls.push(`seed:${spaceId}`);
      return { errors: [] };
    },
    ...(chat
      ? {
          chat: {
            createSession: async (input) => {
              log.calls.push(`session:${input.sessionId}`);
              log.sessionParams.push(input);
              return input.sessionId ?? 'generated-session';
            },
            addSession: async (spaceId, sessionId) => {
              log.calls.push(`add:${spaceId}:${sessionId}`);
              return space;
            },
            provisionRuntime: async (input) => {
              log.calls.push(`runtime:${input.id}`);
            },
          },
        }
      : {}),
    dispatchSpaceCreated: async (input) => {
      log.calls.push(`publish:${input.id}`);
      log.published.push(input);
    },
    warn: (message) => {
      log.calls.push(`warn:${message}`);
    },
    ...overrides,
  };
  return { deps, log };
}

function makeCtx(overrides: Partial<CreateSpaceCtx> = {}): CreateSpaceCtx {
  return { params, deps: makeDeps().deps, warnings: [], ...overrides };
}

describe('createSpace pipeline stages', () => {
  describe('validateParams', () => {
    test('continues with valid params without mutating them', () => {
      const input: CreateSpaceParams = {
        ...params,
        autonomyLevel: 5,
        maxConcurrentTasks: 20,
        config: { maxConcurrentTasks: 1 },
        additionalWorkspaces: [{ path: '/other', label: 'Other' }],
      };
      const result = validateParams(makeCtx({ params: input }));
      expect(result).toEqual({ value: expect.objectContaining({ params: input }) });
      expect(input).toEqual({
        ...params,
        autonomyLevel: 5,
        maxConcurrentTasks: 20,
        config: { maxConcurrentTasks: 1 },
        additionalWorkspaces: [{ path: '/other', label: 'Other' }],
      });
    });

    const invalidCases: Array<[string, CreateSpaceParams, string]> = [
      ['missing workspace path', { ...params, workspacePath: '' }, 'workspacePath is required'],
      ['blank name', { ...params, name: '  ' }, 'name is required'],
      [
        'invalid autonomy',
        { ...params, autonomyLevel: 6 as 5 },
        'Invalid autonomyLevel: 6. Must be one of: 1, 2, 3, 4, 5',
      ],
      [
        'fractional concurrency',
        { ...params, maxConcurrentTasks: 1.5 },
        'Invalid concurrent task limit: 1.5. Must be an integer between 1 and 20',
      ],
      [
        'nested concurrency above maximum',
        { ...params, config: { maxConcurrentTasks: 21 } },
        'Invalid concurrent task limit: 21. Must be an integer between 1 and 20',
      ],
      [
        'invalid additional workspace at its index',
        {
          ...params,
          additionalWorkspaces: [{ path: '/valid' }, { path: 3 as unknown as string }],
        },
        'additionalWorkspaces[1].path is required',
      ],
    ];

    for (const [name, input, message] of invalidCases) {
      test(`returns an early reason for ${name}`, () => {
        const result = validateParams(makeCtx({ params: input }));
        expect('reason' in result ? result.reason.message : undefined).toBe(message);
      });
    }
  });

  test('createSpaceRecord delegates params and enriches context', async () => {
    const createSpaceRecordDep = mock(async () => space);
    const ctx = makeCtx({ deps: makeDeps({ createSpaceRecord: createSpaceRecordDep }).deps });
    const result = await createSpaceRecord(ctx);
    expect(createSpaceRecordDep).toHaveBeenCalledWith(params);
    expect(result).toEqual({ ...ctx, space });
  });

  test('ensureCoordinator delegates the created space id', () => {
    const ensureCoordinatorDep = mock(() => undefined);
    const ctx = makeCtx({
      deps: makeDeps({ ensureCoordinator: ensureCoordinatorDep }).deps,
      space,
    });
    expect(ensureCoordinator(ctx)).toBe(ctx);
    expect(ensureCoordinatorDep).toHaveBeenCalledWith(space.id);
  });

  describe('seedWorkflows', () => {
    test('preserves context when seeding succeeds', () => {
      const ctx = makeCtx({ space });
      expect(seedWorkflows(ctx)).toBe(ctx);
    });

    test('appends failed workflow names without mutating prior warnings', () => {
      const warnings = ['prior warning'];
      const deps = makeDeps({
        seedWorkflows: () => ({
          errors: [
            { name: 'Coding', error: 'failed' },
            { name: 'Research', error: 'failed' },
          ],
        }),
      }).deps;
      const result = seedWorkflows(makeCtx({ deps, space, warnings }));
      expect(result.warnings).toEqual([
        'prior warning',
        'Failed to seed workflows: Coding, Research',
      ]);
      expect(warnings).toEqual(['prior warning']);
    });

    test('converts a thrown seed error into a warning', () => {
      const deps = makeDeps({
        seedWorkflows: () => {
          throw new Error('seed failed');
        },
      }).deps;
      expect(seedWorkflows(makeCtx({ deps, space })).warnings).toEqual([
        'Failed to seed built-in workflows',
      ]);
    });
  });

  describe('provisionChatSession', () => {
    test('creates, registers, and provisions the canonical session', async () => {
      const { deps, log } = makeDeps();
      const result = await provisionChatSession(makeCtx({ deps, space }));
      expect(result.warnings).toEqual([]);
      expect(log.calls).toEqual([
        'session:space:chat:space-1',
        'add:space-1:space:chat:space-1',
        'runtime:space-1',
      ]);
      expect(log.sessionParams).toEqual([
        {
          sessionId: 'space:chat:space-1',
          title: 'Test Space',
          workspacePath: '/workspace',
          config: { model: 'claude-sonnet-5' },
          sessionType: 'space_chat',
          spaceId: 'space-1',
        },
      ]);
    });

    test('is a no-op when chat dependencies are absent', async () => {
      const { deps, log } = makeDeps({}, false);
      const ctx = makeCtx({ deps, space });
      expect(await provisionChatSession(ctx)).toBe(ctx);
      expect(log.calls).toEqual([]);
    });

    test('logs a creation failure without warnings and skips later chat effects', async () => {
      const { deps, log } = makeDeps();
      if (!deps.chat) throw new Error('expected chat dependencies');
      deps.chat.createSession = async () => {
        log.calls.push('session-failed');
        throw new Error('failed');
      };
      const result = await provisionChatSession(makeCtx({ deps, space }));
      expect(result.warnings).toEqual([]);
      expect(log.calls).toEqual([
        'session-failed',
        'warn:Failed to create space chat session for space space-1',
      ]);
    });

    test('logs a registration failure without warnings and skips runtime provisioning', async () => {
      const { deps, log } = makeDeps();
      if (!deps.chat) throw new Error('expected chat dependencies');
      deps.chat.addSession = async () => {
        log.calls.push('add-failed');
        throw new Error('failed');
      };
      const result = await provisionChatSession(makeCtx({ deps, space }));
      expect(result.warnings).toEqual([]);
      expect(log.calls).toEqual([
        'session:space:chat:space-1',
        'add-failed',
        'warn:Failed to create space chat session for space space-1',
      ]);
    });

    test('logs a runtime provisioning failure without warnings', async () => {
      const { deps, log } = makeDeps();
      if (!deps.chat) throw new Error('expected chat dependencies');
      deps.chat.provisionRuntime = async () => {
        log.calls.push('runtime-failed');
        throw new Error('failed');
      };
      const result = await provisionChatSession(makeCtx({ deps, space }));
      expect(result.warnings).toEqual([]);
      expect(log.calls).toContain('warn:Failed to provision space chat session for space space-1');
    });
  });

  describe('publishSpaceCreated', () => {
    test('dispatches without changing context', () => {
      const { deps, log } = makeDeps();
      const ctx = makeCtx({ deps, space });
      expect(publishSpaceCreated(ctx)).toBe(ctx);
      expect(log.published).toEqual([space]);
    });

    test('logs an asynchronous dispatch failure without changing warnings', async () => {
      const failure = new Error('publish failed');
      const warn = mock(() => undefined);
      const deps = makeDeps({
        dispatchSpaceCreated: async () => {
          throw failure;
        },
        warn,
      }).deps;
      const ctx = makeCtx({ deps, space });
      expect(publishSpaceCreated(ctx)).toBe(ctx);
      await Promise.resolve();
      expect(warn).toHaveBeenCalledWith('Failed to emit space.created', failure);
      expect(ctx.warnings).toEqual([]);
    });
  });

  describe('assembleResult', () => {
    test('uses the original space when no warnings exist', () => {
      const result = assembleResult(makeCtx({ space }));
      expect(result.result).toBe(space);
      expect(result.result).not.toHaveProperty('seedWarnings');
    });

    test('copies accumulated warnings into the result', () => {
      const warnings = ['one', 'two'];
      const result = assembleResult(makeCtx({ space, warnings }));
      expect(result.result).toEqual({ ...space, seedWarnings: warnings });
      expect(result.result?.seedWarnings).not.toBe(warnings);
    });
  });
});

describe('createSpace pipeline', () => {
  test('runs the complete business path in order', async () => {
    const { deps, log } = makeDeps();
    expect(await createSpace(deps, params)).toBe(space);
    expect(log.calls).toEqual([
      'create:Test Space',
      'coordinator:space-1',
      'seed:space-1',
      'session:space:chat:space-1',
      'add:space-1:space:chat:space-1',
      'runtime:space-1',
      'publish:space-1',
    ]);
  });

  test('validation early return prevents every effect', async () => {
    const { deps, log } = makeDeps();
    await expect(createSpace(deps, { ...params, autonomyLevel: 0 as 1 })).rejects.toThrow(
      'Invalid autonomyLevel: 0'
    );
    expect(log.calls).toEqual([]);
  });

  test('fatal record failure prevents every later effect', async () => {
    const failure = new Error('record failed');
    const { deps, log } = makeDeps({
      createSpaceRecord: async () => {
        log.calls.push('create-failed');
        throw failure;
      },
    });
    await expect(createSpace(deps, params)).rejects.toBe(failure);
    expect(log.calls).toEqual(['create-failed']);
  });

  test('fatal coordinator failure prevents nonfatal stages and publication', async () => {
    const failure = new Error('coordinator failed');
    const { deps, log } = makeDeps({
      ensureCoordinator: () => {
        log.calls.push('coordinator-failed');
        throw failure;
      },
    });
    await expect(createSpace(deps, params)).rejects.toBe(failure);
    expect(log.calls).toEqual(['create:Test Space', 'coordinator-failed']);
  });

  test('accumulates seed warnings and still publishes', async () => {
    const { deps, log } = makeDeps({
      seedWorkflows: () => ({ errors: [{ name: 'Coding', error: 'failed' }] }),
    });
    if (!deps.chat) throw new Error('expected chat dependencies');
    deps.chat.provisionRuntime = async () => {
      throw new Error('runtime failed');
    };
    const result = await createSpace(deps, params);
    expect(result.seedWarnings).toEqual(['Failed to seed workflows: Coding']);
    expect(log.calls.at(-1)).toBe('publish:space-1');
  });
});
