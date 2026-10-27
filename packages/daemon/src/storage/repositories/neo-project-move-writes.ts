import { neoProjectMoveReason } from '@hyperneo/shared/types/neo-project-tree';
import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import { NeoRepository } from './neo-repository.ts';

class NeoProjectMoveCommands {
  constructor(private readonly db: Database) {}

  move(id: string, parentId: string | null, expectedRevision: number) {
    const repo = new NeoRepository(this.db);
    const reason = neoProjectMoveReason(repo.listProjects(), id, parentId);
    return reason
      ? { ok: false as const, reason }
      : repo.moveProject(id, parentId, expectedRevision);
  }
}

export const neoProjectMoveWrites = defineRepositoryOp(
  'neo.project.move',
  'write',
  NeoProjectMoveCommands,
  ['move']
);
