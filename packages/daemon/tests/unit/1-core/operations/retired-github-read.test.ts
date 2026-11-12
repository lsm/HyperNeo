import { describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { NEO_PACK_CODING_INSTRUCTIONS } from '@hyperneo/prompts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus';
import { createNeoOperations, createNeoService } from '../../helpers/neo-service';
import { createOperationRegistry } from '../../../../src/lib/operations/registry';
import { invokeOperation } from '../../../../src/lib/operations/invoke';
import type { SessionManager } from '../../../../src/lib/session/session-manager';
import { createTestDb } from '../../../helpers/database';

describe('retired GitHub read operation', () => {
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
        expect(registry.get('neo.github.read')).toBeUndefined();
        expect(registry.get('neo.coding.assign')).toBeDefined();
        expect(
          await invokeOperation(
            registry,
            'neo.github.read',
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

  test('coding guidance uses gh for single references and bounded recent activity', () => {
    expect(NEO_PACK_CODING_INSTRUCTIONS).toContain('gh pr view');
    expect(NEO_PACK_CODING_INSTRUCTIONS).toContain('gh issue view');
    expect(NEO_PACK_CODING_INSTRUCTIONS).toContain('gh pr list --repo');
    expect(NEO_PACK_CODING_INSTRUCTIONS).toContain('--search');
    expect(NEO_PACK_CODING_INSTRUCTIONS).toContain('owner/repo#N');
    expect(NEO_PACK_CODING_INSTRUCTIONS).not.toContain('neo.github.read');
  });
});
