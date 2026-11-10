import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { Database } from '../../../../src/storage/database.ts';
import type { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import {
  contributeDefaultOperations,
  createDatabaseOperationCatalog,
} from '../../../../src/lib/operations/database-catalog.ts';
import { defineOperation } from '../../../../src/lib/operations/registry.ts';

function operation(name: string, label: string) {
  return defineOperation({
    name,
    description: label,
    inputSchema: z.object({}).default({}),
    resultSchema: z.object({}),
    policy: { safetyClass: 'read' },
    execute: async () => ({}),
  });
}

const db = { getDatabase: () => ({}) } as unknown as Database;
const jobQueue = {} as JobQueueRepository;

describe('createDatabaseOperationCatalog', () => {
  test('adds contributed operations unless the caller supplies one of the same name', () => {
    const seen: Database[] = [];
    contributeDefaultOperations('test-extension', (database) => {
      seen.push(database);
      return [operation('contributed.read', 'default'), operation('shared.read', 'default')];
    });
    const registry = createDatabaseOperationCatalog(db, jobQueue, {}, [
      operation('shared.read', 'explicit'),
    ]);
    expect(seen).toEqual([db]);
    expect(registry.get('contributed.read')?.description).toBe('default');
    expect(registry.get('shared.read')?.description).toBe('explicit');
    expect(registry.entries.filter((entry) => entry.name === 'shared.read')).toHaveLength(1);
  });
});
