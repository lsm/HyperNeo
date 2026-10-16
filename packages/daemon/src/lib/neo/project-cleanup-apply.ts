import type { NeoProjectCleanup } from './project-cleanup.ts';
import type { NeoService } from './service.ts';

type Step<A extends NeoProjectCleanup['action']> = Extract<NeoProjectCleanup, { action: A }>;

export function createNeoProjectCleanupApply(
  service: Pick<NeoService, 'repo' | 'sessions'>
): (step: NeoProjectCleanup) => Promise<void> {
  const requireIdle = (sessionId: string) => {
    const turn = service.sessions.getCachedSession(sessionId)?.getProcessingState().status;
    if (turn && !['idle', 'interrupted'].includes(turn)) throw new Error('the holder is mid-turn');
  };
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
      requireIdle(step.sessionId);
      if (service.repo.sessionSpoke(step.sessionId)) throw new Error('the holder has spoken');
      await service.sessions.deleteSessionResources(step.sessionId, 'ui_session_delete');
      service.repo.unbindHolder(step.sessionId);
    },
    archive: async (step: Step<'archive'>) => {
      requireIdle(step.sessionId);
      await service.sessions.archiveSessionResources(step.sessionId, 'ui_session_archive');
    },
  };
  return (step) => (apply[step.action] as (step: NeoProjectCleanup) => Promise<void>)(step);
}
