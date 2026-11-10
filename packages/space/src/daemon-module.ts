import type { Database } from '../../daemon/src/storage/database.ts';
import type { ReactiveDatabase } from '../../daemon/src/storage/reactive-database.ts';
import { SpaceRepository } from '../../daemon/src/storage/repositories/space-repository.ts';
import { SPACE_SCHEMA } from '../../daemon/src/storage/schema/space-schema.ts';
import type { Database as BunDatabase } from '../../daemon/src/storage/sqlite-compat.ts';
import { createSpaceDefaultOperations } from '../../daemon/src/lib/tasks/catalog-operations.ts';
import { captureDirectMailboxAdmission } from '../../daemon/src/lib/tasks/direct-mailbox-admission.ts';
import { createSpaceDaemonExtension } from './daemon-extension.ts';
import { EvolutionLogEvidenceService } from './evolution/log-evidence-service.ts';
import { createSpaceExternalEvents } from './external-event-wiring.ts';
import { SpaceManager } from './managers/space-manager.ts';
import { createSpaceRpc } from './rpc/space-setup.ts';

export const spaceDaemonModule = {
  schema: SPACE_SCHEMA,
  defaultOperations: createSpaceDefaultOperations,
  captureMailboxAdmission: captureDirectMailboxAdmission,
  createExternalEvents: createSpaceExternalEvents,
  createRpc: createSpaceRpc,
  createDaemonExtension: createSpaceDaemonExtension,
  createSpaceManager: (db: BunDatabase, reactiveDb: ReactiveDatabase) =>
    new SpaceManager(db, reactiveDb),
  createLogEvidenceService: (db: Database) =>
    new EvolutionLogEvidenceService({
      evolutionRepo: db.evolution,
      spaceRepo: new SpaceRepository(db.getDatabase()),
    }),
};

export type SpaceDaemonModule = typeof spaceDaemonModule;
