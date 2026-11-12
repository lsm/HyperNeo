import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { NEO_PACK_CODING_INSTRUCTIONS } from '@hyperneo/prompts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import { createNeoOperations, createNeoService } from '../../helpers/neo-service';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import type { SessionManager } from '../../../../src/lib/session/session-manager';
import { createTestDb } from '../../../helpers/database';

describe('retired Write plan operation', () => {
  test('is absent with coding enabled or disabled while coding assignment remains registered', async () => {
    const db = await createTestDb();
    const service = createNeoService(
      db,
      { getOperationRegistry: () => createOperationRegistry([]) } as unknown as SessionManager,
      { event: mock(() => {}) } as unknown as MessageHub,
      new InternalEventBus()
    );
    try {
      for (const packs of [[], ['coding']]) {
        db.updateGlobalSettings({ neo: { packs } });
        const registry = createOperationRegistry(createNeoOperations(service));
        expect(registry.get('neo.coding.write.plan')).toBeUndefined();
        expect(registry.get('neo.coding.assign')).toBeDefined();
        expect(
          await invokeOperation(
            registry,
            'neo.coding.write.plan',
            {},
            { source: 'rpc', principal: 'local' }
          )
        ).toMatchObject({ kind: 'failed', code: 'unknown_operation' });
      }
    } finally {
      service.dispose();
      db.close();
    }
  });

  test('coding guidance selects Write targets through saved preferences and starts the existing todo', () => {
    expect(NEO_PACK_CODING_INSTRUCTIONS).toContain('default-first');
    expect(NEO_PACK_CODING_INSTRUCTIONS).toContain('pack.preferences.get');
    expect(NEO_PACK_CODING_INSTRUCTIONS).toContain('neo.todo.add');
    expect(NEO_PACK_CODING_INSTRUCTIONS).toContain('start: true');
    expect(NEO_PACK_CODING_INSTRUCTIONS).not.toContain('neo.coding.write.plan');
  });
});
