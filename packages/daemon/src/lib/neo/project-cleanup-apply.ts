import type { NeoProjectCleanup } from './project-cleanup.ts';
import type { NeoService } from './service.ts';

type Step<A extends NeoProjectCleanup['action']> = Extract<NeoProjectCleanup, { action: A }>;

export function createNeoProjectCleanupApply(
  service: Pick<NeoService, 'repo'>
): (step: NeoProjectCleanup) => Promise<void> {
  const apply = {
    delete: async (step: Step<'delete'>) => {
      service.repo.deleteEmptyProject(step.projectId);
    },
    merge: async (step: Step<'merge'>) => {
      const [source, target] = [step.projectId, step.targetId].map((id) =>
        service.repo.getProject(id)
      );
      if (!source || !target) throw new Error('a project is gone');
      const result = service.repo.projectMerges.merge({
        sourceId: source.id,
        targetId: target.id,
        sourceRevision: source.revision,
        targetRevision: target.revision,
        sourceIdentities: [],
        targetIdentities: [],
        humanApproved: true,
      });
      if (!result.ok) throw new Error(result.reason);
    },
  };
  return (step) => (apply[step.action] as (step: NeoProjectCleanup) => Promise<void>)(step);
}
