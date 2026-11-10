import { readCodingTodoWorker } from '../../../src/lib/neo/packs/coding/worker-read.ts';
import { codingProjectIdentity } from '../../../src/lib/neo/packs/coding/project-cleanup.ts';
import { createNeoOperations as createCoreNeoOperations } from '../../../src/lib/neo/operations.ts';
import {
  createNeoService as createBareNeoService,
  neoPacksExtension,
} from '../../../src/lib/neo/packs/runtime.ts';
import type { NeoService } from '../../../src/lib/neo/service.ts';

export function createNeoService(...args: Parameters<typeof createBareNeoService>) {
  const service = createBareNeoService(...args);
  neoPacksExtension(service).schema?.(args[0].getDatabase());
  return service;
}

export function createNeoOperations(service: NeoService) {
  return [
    ...(neoPacksExtension(service).operations?.() ?? []),
    ...createCoreNeoOperations(service, codingProjectIdentity, readCodingTodoWorker),
  ];
}
