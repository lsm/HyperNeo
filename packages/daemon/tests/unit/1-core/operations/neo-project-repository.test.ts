import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { NEO_LOOK_UP } from '@hyperneo/prompts';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb } from '../../../helpers/database.ts';

describe('neo.snapshot project repository', () => {
  test('names each project’s repository from its stored identity, so its history is read there', async () => {
    const db = await createTestDb();
    try {
      const service = new NeoService(
        db,
        { getOperationRegistry: () => createOperationRegistry([]) } as unknown as SessionManager,
        { event: mock(() => {}) } as unknown as MessageHub,
        new InternalEventBus<DaemonInternalEventMap>()
      );
      const raw = db.getDatabase();
      for (const id of ['ios', 'web', 'notes'])
        service.repo.saveProject({ id, title: id, summary: id, context: '' }, 0);
      const alias = raw.prepare(
        'INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)'
      );
      alias.run('repo:lsm/neo-ios\u0000tts\u0000/Users/lsm/focus/neo-ios', 'ios');
      alias.run('repo:lsm/old-name\u0000laptop\u0000/w/web', 'web');
      alias.run('repository:github.com/lsm/hyperneo', 'web');
      alias.run('folder:tts\u0000/Users/lsm/notes', 'notes');
      const result = await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.snapshot',
        {},
        { source: 'rpc', principal: 'local' }
      );
      const projects = (result as { value: { projects: { id: string; repository?: string }[] } })
        .value.projects;
      const repository = (id: string) => projects.find((project) => project.id === id)?.repository;
      expect(repository('ios')).toBe('github.com/lsm/neo-ios');
      expect(repository('web')).toBe('github.com/lsm/hyperneo');
      expect(repository('notes')).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test('tells Neo a folder without .git is never evidence of history', () => {
    expect(NEO_LOOK_UP).toContain('A folder without .git');
    expect(NEO_LOOK_UP).toContain('say you cannot tell, never that nothing happened');
  });
});
