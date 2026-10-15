import type { NeoProjectCleanup } from './project-cleanup.ts';
import type { NeoService } from './service.ts';

type Step<A extends NeoProjectCleanup['action']> = Extract<NeoProjectCleanup, { action: A }>;

export function createNeoProjectCleanupApply(
  service: Pick<NeoService, 'repo' | 'sessions'>
): (step: NeoProjectCleanup) => Promise<void> {
  const apply = {
    delete: async (step: Step<'delete'>) => {
      const session = service.repo.deleteEmptyProject(step.projectId);
      if (session) await service.sessions.deleteSessionResources(session, 'ui_session_delete');
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
    drop: async (step: Step<'drop'>) => {
      if (service.repo.sessionSpoke(step.sessionId)) throw new Error('the holder has spoken');
      await service.sessions.deleteSessionResources(step.sessionId, 'ui_session_delete');
    },
    archive: async (step: Step<'archive'>) => {
      const turn = service.sessions.getCachedSession(step.sessionId)?.getProcessingState().status;
      if (turn && !['idle', 'interrupted'].includes(turn))
        throw new Error('the holder is mid-turn');
      await service.sessions.archiveSessionResources(step.sessionId, 'ui_session_archive');
    },
  };
  return (step) => (apply[step.action] as (step: NeoProjectCleanup) => Promise<void>)(step);
}
