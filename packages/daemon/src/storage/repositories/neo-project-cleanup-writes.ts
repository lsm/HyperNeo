import { defineRepositoryOp } from '../db-gateway/db-op.ts';
import type { Database } from '../sqlite-compat.ts';
import type { NeoProjectCleanup } from '../../lib/neo/project-cleanup.ts';
import { NeoRepository } from './neo-repository.ts';

class NeoProjectCleanupCommands {
  constructor(private readonly db: Database) {}

  apply(step: NeoProjectCleanup): void {
    const repo = new NeoRepository(this.db);
    if (step.action === 'delete') {
      repo.deleteEmptyProject(step.projectId);
      return;
    }
    const [source, target] = [step.projectId, step.targetId].map((id) => repo.getProject(id));
    if (!source || !target) throw new Error('a project is gone');
    const result = repo.projectMerges.merge({
      sourceId: source.id,
      targetId: target.id,
      sourceRevision: source.revision,
      targetRevision: target.revision,
      sourceIdentities: [],
      targetIdentities: [],
      humanApproved: true,
    });
    if (!result.ok) throw new Error(result.reason);
  }
}

export const neoProjectCleanupWrites = defineRepositoryOp(
  'neo.project.cleanup',
  'write',
  NeoProjectCleanupCommands,
  ['apply']
);
