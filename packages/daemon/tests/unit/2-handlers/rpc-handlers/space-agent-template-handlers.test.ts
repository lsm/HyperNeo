import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageHub, SpaceAgentTemplate } from '@hyperneo/shared';
import { setupSpaceAgentTemplateHandlers } from '../../../../src/lib/rpc-handlers/space-agent-template-handlers';
import { SpaceAgentTemplateManager } from '../../../../src/lib/space/managers/space-agent-template-manager';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';
import { SpaceAgentTemplateRepository } from '../../../../src/storage/repositories/space-agent-template-repository';
import { runMigration226 } from '../../../../src/storage/schema/m226-space-agent-templates-version';
import { runMigration227 } from '../../../../src/storage/schema/m227-space-agent-template-version-seq';
import { runMigration238 } from '../../../../src/storage/schema/m238-space-agent-template-labels';
import { runMigration243 } from '../../../../src/storage/schema/m243-space-agent-template-space-key';
import { runMigration246 } from '../../../../src/storage/schema/m246-template-version-seq-space-key';
import { createSpaceAgentTemplatesTable } from '../../../../src/storage/schema/space-agent-templates';
import { Database } from '../../../../src/storage/sqlite-compat';

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

function createMockSpaceManager(): Pick<SpaceManager, 'getSpace'> {
  return {
    getSpace: mock(async (spaceId: string) =>
      spaceId === 'space-1' || spaceId === 'space-2' ? { id: spaceId } : null
    ),
  } as unknown as Pick<SpaceManager, 'getSpace'>;
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

function templateParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spaceId: 'space-1',
    key: 'custom.researcher',
    handle: 'researcher',
    displayName: 'Researcher',
    ...overrides,
  };
}

describe('spaceAgentTemplate RPC handlers', () => {
  let db: Database;
  let hubData: ReturnType<typeof createMockMessageHub>;

  beforeEach(() => {
    db = new Database(':memory:');
    createSpaceAgentTemplatesTable(db);
    runMigration226(db);
    runMigration227(db);
    runMigration238(db);
    runMigration243(db);
    runMigration246(db);
    hubData = createMockMessageHub();
    setupSpaceAgentTemplateHandlers(hubData.hub, {
      spaceManager: createMockSpaceManager(),
      templateManager: new SpaceAgentTemplateManager(new SpaceAgentTemplateRepository(db)),
    });
  });

  afterEach(() => {
    db.close();
    mock.restore();
  });

  it('registers every route under the spaceAgentTemplate prefix', () => {
    expect([...hubData.handlers.keys()].sort()).toEqual([
      'spaceAgentTemplate.create',
      'spaceAgentTemplate.delete',
      'spaceAgentTemplate.list',
      'spaceAgentTemplate.listBuiltIn',
      'spaceAgentTemplate.update',
    ]);
  });

  it('registers only listBuiltIn when no template manager is supplied', () => {
    const bare = createMockMessageHub();
    setupSpaceAgentTemplateHandlers(bare.hub, { spaceManager: createMockSpaceManager() });

    expect([...bare.handlers.keys()]).toEqual(['spaceAgentTemplate.listBuiltIn']);
  });

  describe('listBuiltIn', () => {
    it('returns built-in templates without reserved handles', async () => {
      const result = await call<{ templates: SpaceAgentTemplate[] }>(
        hubData.handlers,
        'spaceAgentTemplate.listBuiltIn',
        { spaceId: 'space-1' }
      );

      expect(result.templates.length).toBeGreaterThan(0);
      expect(result.templates.map((t) => t.handle)).not.toContain('space-manager');
    });

    it('requires a spaceId', async () => {
      await expect(call(hubData.handlers, 'spaceAgentTemplate.listBuiltIn', {})).rejects.toThrow(
        'spaceId is required'
      );
    });

    it('rejects an unknown space', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgentTemplate.listBuiltIn', { spaceId: 'missing' })
      ).rejects.toThrow('Space not found: missing');
    });
  });

  describe('create', () => {
    it('round-trips a stored template through list', async () => {
      await call(hubData.handlers, 'spaceAgentTemplate.create', templateParams());

      const result = await call<{ templates: SpaceAgentTemplate[] }>(
        hubData.handlers,
        'spaceAgentTemplate.list',
        { spaceId: 'space-1' }
      );

      expect(result.templates.map((t) => t.key)).toContain('custom.researcher');
    });

    it('requires a key', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgentTemplate.create', templateParams({ key: '' }))
      ).rejects.toThrow('key is required');
    });

    it('requires a handle', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgentTemplate.create', templateParams({ handle: '' }))
      ).rejects.toThrow('handle is required');
    });

    it('rejects an unknown space', async () => {
      await expect(
        call(hubData.handlers, 'spaceAgentTemplate.create', templateParams({ spaceId: 'missing' }))
      ).rejects.toThrow('Space not found: missing');
    });
  });

  it('update patches a stored template', async () => {
    await call(hubData.handlers, 'spaceAgentTemplate.create', templateParams());

    const result = await call<{ template: SpaceAgentTemplate }>(
      hubData.handlers,
      'spaceAgentTemplate.update',
      { spaceId: 'space-1', key: 'custom.researcher', displayName: 'Renamed' }
    );

    expect(result.template.displayName).toBe('Renamed');
  });

  it('delete removes a stored template', async () => {
    await call(hubData.handlers, 'spaceAgentTemplate.create', templateParams());

    await call(hubData.handlers, 'spaceAgentTemplate.delete', {
      spaceId: 'space-1',
      key: 'custom.researcher',
    });

    const result = await call<{ templates: SpaceAgentTemplate[] }>(
      hubData.handlers,
      'spaceAgentTemplate.list',
      { spaceId: 'space-1' }
    );
    expect(result.templates.map((t) => t.key)).not.toContain('custom.researcher');
  });

  it('hides another space stored template from list', async () => {
    await call(
      hubData.handlers,
      'spaceAgentTemplate.create',
      templateParams({ spaceId: 'space-2' })
    );

    const result = await call<{ templates: SpaceAgentTemplate[] }>(
      hubData.handlers,
      'spaceAgentTemplate.list',
      { spaceId: 'space-1' }
    );

    expect(result.templates.map((t) => t.key)).not.toContain('custom.researcher');
  });
});
