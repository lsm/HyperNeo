import type { Database } from '../../storage/database.ts';
import type { ReactiveDatabase } from '../../storage/reactive-database.ts';
import { SpaceRepository } from '../../storage/repositories/space-repository.ts';
import { SPACE_SCHEMA } from '../../storage/schema/space-schema.ts';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import { createSpaceDefaultOperations } from '../tasks/catalog-operations.ts';
import { captureDirectMailboxAdmission } from '../tasks/direct-mailbox-admission.ts';
import { createSpaceDaemonExtension } from '../../../../space/src/daemon-extension.ts';
import { EvolutionLogEvidenceService } from '../../../../space/src/evolution/log-evidence-service.ts';
import { createSpaceExternalEvents } from '../../../../space/src/external-event-wiring.ts';
import { SpaceManager } from '../../../../space/src/managers/space-manager.ts';
import { createSpaceRpc } from '../../../../space/src/rpc/space-setup.ts';

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
