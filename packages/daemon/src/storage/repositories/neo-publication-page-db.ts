import { defineDbOp } from '../db-gateway/db-op.ts';
import type { OperationCaller } from '../../lib/operations/registry.ts';
import { readNeoPublicationPage } from '../../lib/neo/publication-read-operation.ts';
import { NeoRepository } from './neo-repository.ts';
import { NeoPublicationRepository } from './neo-publication-repository.ts';

export const neoPublicationPageWrites = defineDbOp({
  name: 'neo.publication.page',
  mode: 'write',
  run: (
    db,
    {
      page,
      caller,
    }: { page: Parameters<typeof readNeoPublicationPage>[0]; caller: OperationCaller }
  ) =>
    readNeoPublicationPage(page, caller, new NeoRepository(db), new NeoPublicationRepository(db)),
});
