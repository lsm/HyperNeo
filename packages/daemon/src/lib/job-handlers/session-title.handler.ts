import type { Job } from '../../storage/repositories/job-queue-repository';
import type { SessionLifecycle } from '../session/session-lifecycle';

/**
 * Job handler for session.title_generation queue.
 *
 * Calls SessionLifecycle.generateTitleAndRenameBranch() with the sessionId and
 * userMessageText from the job payload. Errors propagate so the job queue can
 * retry the job automatically.
 */
export async function handleSessionTitleGeneration(
  job: Job,
  sessionLifecycle: SessionLifecycle
): Promise<{ generated: true }> {
  const { sessionId, userMessageText } = job.payload;

  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('Job payload missing required field: sessionId');
  }
  if (!userMessageText || typeof userMessageText !== 'string') {
    throw new Error('Job payload missing required field: userMessageText');
  }

  await sessionLifecycle.generateTitleAndRenameBranch(sessionId, userMessageText);

  return { generated: true };
}
