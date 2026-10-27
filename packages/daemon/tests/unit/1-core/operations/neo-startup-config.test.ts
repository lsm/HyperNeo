import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MessageHub, Session } from '@hyperneo/shared';
import { vi } from 'vitest';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import { neoPrompt } from '../../../../src/lib/neo/prompt.ts';
import type { CreateSessionParams } from '../../../../src/lib/session/session-lifecycle.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const root = 'neo:synthetic-startup';
const tools = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'Bash'];
const allowed = [...tools, 'mcp__hyperneo-operations__invoke', 'mcp__fetch-mcp'];

describe('Neo startup configuration', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let service: ReturnType<typeof createNeoService>;
  const updateSession = vi.fn();

  beforeEach(async () => {
    db = await createTestDb();
    updateSession.mockReset();
    updateSession.mockImplementation(async (id: string, updates: Partial<Session>) => {
      await db.updateSession(id, updates);
    });
    service = createNeoService(
      db,
      {
        updateSession,
        createSession: async (params: CreateSessionParams) => {
          await db.createSession({
            ...createTestSession(params.sessionId!),
            config: params.config!,
          });
        },
      } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus<DaemonInternalEventMap>()
    );
  });

  afterEach(async () => {
    await service.dispose();
    db.close();
    vi.restoreAllMocks();
  });

  test.each(['recover', 'open'] as const)(
    '%s refreshes a stored root without changing its history or ordinary settings',
    async (method) => {
      const session = createTestSession(root);
      session.sdkSessionId = 'synthetic-sdk-history';
      session.sdkOriginPath = '/synthetic/old/.coordinators/root';
      session.config = {
        ...session.config,
        systemPrompt: 'You are Neo, the user’s personal context coordinator.',
        sdkToolsPreset: [],
        allowedTools: ['mcp__fetch-mcp__fetch'],
        disallowedTools: ['Read(/synthetic/keep)'],
        settingSources: ['user', 'project', 'local'],
        permissionMode: 'acceptEdits',
        autoCompactPercent: 70,
      };
      await db.createSession(session);
      service.repo.reserveBinding({ sessionId: root, projectId: null, kind: 'neo' });
      await service[method]();
      const restored = db.getSession(root)!;
      expect(restored.config.systemPrompt).toBe(neoPrompt(service.packBriefs()));
      expect(restored.config.systemPrompt).toContain('the human sees none of your assistant text');
      expect(restored.config.sdkToolsPreset).toEqual(tools);
      expect(restored.config.allowedTools).toEqual(allowed);
      expect(restored).toMatchObject({
        sdkSessionId: session.sdkSessionId,
        sdkOriginPath: session.sdkOriginPath,
        workspacePath: session.workspacePath,
        metadata: session.metadata,
      });
      expect(restored.config).toMatchObject({
        model: session.config.model,
        maxTokens: 8192,
        disallowedTools: ['Read(/synthetic/keep)'],
        settingSources: [],
        permissionMode: 'dontAsk',
        autoCompactPercent: 70,
      });
      await service[method]();
      expect(updateSession).toHaveBeenCalledTimes(1);
    }
  );

  test('refreshing tools approves reading and unsandboxed Bash without native mutation', async () => {
    const session = createTestSession(root);
    session.config = { ...session.config, permissionMode: 'acceptEdits', allowedTools: ['Read'] };
    await db.createSession(session);
    service.repo.reserveBinding({ sessionId: root, projectId: null, kind: 'neo' });
    await service.open();
    const config = db.getSession(root)!.config;
    expect(config.sdkToolsPreset).toContain('Bash');
    expect(config.allowedTools).toContain('Read');
    expect(config.allowedTools).toContain('Bash');
    for (const tool of ['Write', 'Edit', 'NotebookEdit'])
      expect(config.allowedTools).not.toContain(tool);
    expect(config.permissionMode).toBe('dontAsk');
  });

  test('new roots start with current prompt and native tools', async () => {
    const id = await service.open();
    expect(db.getSession(id)?.config).toMatchObject({
      systemPrompt: neoPrompt(service.packBriefs()),
      sdkToolsPreset: tools,
      allowedTools: allowed,
    });
  });

  test('a later startup refreshes changed pack guidance', async () => {
    const id = await service.open();
    const packs = [{ id: 'synthetic', describe: 'Test domain', guidance: 'New pack instruction' }];
    vi.spyOn(service, 'packBriefs').mockReturnValue(packs);
    await service.recover();
    expect(db.getSession(id)?.config.systemPrompt).toBe(neoPrompt(packs));
    expect(updateSession).toHaveBeenCalledTimes(1);
  });

  test('recovery without a root does not create one', async () => {
    await service.recover();
    expect(service.defaultSessionId()).toBeUndefined();
    expect(updateSession).not.toHaveBeenCalled();
  });

  test('a recovered root runs without its own OS sandbox and cannot approve native writes', async () => {
    const session = createTestSession(root);
    session.config.allowedTools = ['Write', 'Edit', 'NotebookEdit'];
    session.config.coordinatorMode = true;
    await db.createSession(session);
    service.repo.reserveBinding({ sessionId: root, projectId: null, kind: 'neo' });
    await service.recover();
    const config = db.getSession(root)!.config;
    expect(config.allowedTools).toEqual(allowed);
    expect(config.permissionMode).toBe('dontAsk');
    expect(config.coordinatorMode).toBe(false);
    expect(config.sandbox).toBeUndefined();
  });
});
