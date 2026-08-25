import type { Job } from '../../storage/repositories/job-queue-repository.ts';
import type { EvolutionConversationAnalysisService } from '../space/evolution-conversation-analysis-service.ts';

export interface ConversationFrictionEvidenceJobPayload {
  scopeId: string;
  taskId: string;
}

export function createConversationFrictionEvidenceHandler(
  service: EvolutionConversationAnalysisService
): (job: Job) => Promise<Record<string, unknown>> {
  return async (job) => {
    const payload = job.payload as Partial<ConversationFrictionEvidenceJobPayload>;
    if (typeof payload.scopeId !== 'string' || typeof payload.taskId !== 'string') {
      throw new Error('Invalid conversation friction evidence job payload');
    }
    const evidence = await service.captureForTask({
      scopeId: payload.scopeId,
      taskId: payload.taskId,
    });
    return { evidenceCount: evidence.length };
  };
}
