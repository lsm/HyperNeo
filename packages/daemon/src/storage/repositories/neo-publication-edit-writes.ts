import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import type { OperationCaller } from '../../lib/operations/registry.ts';
import * as publicationChange from '../../lib/neo/publication-change-operation.ts';
import { NeoRepository } from './neo-repository.ts';
import { NeoPublicationRepository } from './neo-publication-repository.ts';

class NeoPublicationEditCommands {
  constructor(private readonly db: Database) {}

  revise(input: unknown, caller: OperationCaller, at: string) {
    const repo = new NeoRepository(this.db);
    const admit = publicationChange.createNeoPublicationChangeAdmission(
      {
        getBinding: (id) => repo.getBindingBySession(id),
        getRootBinding: () => repo.defaultBinding(),
        publications: new NeoPublicationRepository(this.db),
        notify: () => {},
      },
      () => new Date(at)
    );
    return admit(input, caller);
  }
}

export const neoPublicationEditWrites = defineRepositoryOp(
  'neo.publication.revision',
  'write',
  NeoPublicationEditCommands,
  ['revise']
);
