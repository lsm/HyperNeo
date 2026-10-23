import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import {
  type DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus.ts';
import { createNeoOperations } from '../../../../src/lib/neo/operations.ts';
import { createNeoService } from '../../../../src/lib/neo/packs/runtime.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb } from '../../../helpers/database.ts';

describe('neo.snapshot project repository', () => {
  test('names each project’s repository from its stored identity, so its history is read there', async () => {
    const db = await createTestDb();
    try {
      const service = createNeoService(
        db,
        { getOperationRegistry: () => createOperationRegistry([]) } as unknown as SessionManager,
        { event: mock(() => {}) } as unknown as MessageHub,
        new InternalEventBus<DaemonInternalEventMap>()
      );
      const raw = db.getDatabase();
      for (const id of ['ios', 'web', 'notes', 'forked'])
        service.repo.saveProject({ id, title: id, summary: id, context: '' }, 0);
      const alias = raw.prepare(
        'INSERT INTO neo_project_workspaces (alias, project_id) VALUES (?, ?)'
      );
      alias.run('repo:lsm/neo-ios\u0000tts\u0000/Users/lsm/focus/neo-ios', 'ios');
      alias.run('repo:lsm/old-name\u0000laptop\u0000/w/web', 'web');
      alias.run('repository:github.com/lsm/hyperneo', 'web');
      alias.run('folder:tts\u0000/Users/lsm/notes', 'notes');
      alias.run('repo:lsm/app\u0000tts\u0000/w/app', 'forked');
      alias.run('repo:upstream/app\u0000tts\u0000/w/app', 'forked');
      const result = await invokeOperation(
        createOperationRegistry(createNeoOperations(service)),
        'neo.snapshot',
        {},
        { source: 'rpc', principal: 'local' }
      );
      const projects = (result as { value: { projects: { id: string; repository?: string }[] } })
        .value.projects;
      const repository = (id: string) => projects.find((project) => project.id === id)?.repository;
      expect(repository('ios')).toBe('lsm/neo-ios');
      expect(repository('web')).toBe('lsm/hyperneo');
      expect(repository('notes')).toBeUndefined();
      expect(repository('forked')).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
