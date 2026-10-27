import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import type { OperationCaller } from '../../lib/operations/registry.ts';
import { readNeoPublicationPage } from '../../lib/neo/publication-read-operation.ts';
import { NeoRepository } from './neo-repository.ts';
import { NeoPublicationRepository } from './neo-publication-repository.ts';

class NeoPublicationPageCommands {
  constructor(private readonly db: Database) {}

  read(page: Parameters<typeof readNeoPublicationPage>[0], caller: OperationCaller) {
    return readNeoPublicationPage(
      page,
      caller,
      new NeoRepository(this.db),
      new NeoPublicationRepository(this.db)
    );
  }
}

export const neoPublicationPageWrites = defineRepositoryOp(
  'neo.publication.page',
  'write',
  NeoPublicationPageCommands,
  ['read']
);
