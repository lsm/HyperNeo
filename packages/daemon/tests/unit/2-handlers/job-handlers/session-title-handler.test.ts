import { describe, it, expect, mock } from 'bun:test';
import { handleSessionTitleGeneration } from '../../../../src/lib/job-handlers/session-title.handler';
import { SESSION_TITLE_GENERATION } from '../../../../src/lib/job-queue-constants';
import type { Job } from '../../../../src/storage/repositories/job-queue-repository';
import type { SessionLifecycle } from '../../../../src/lib/session/session-lifecycle';

function makeJob(payload: Record<string, unknown>): Job {
  return {
    id: 'test-job-id',
    queue: SESSION_TITLE_GENERATION,
    status: 'processing',
    payload,
    result: null,
    error: null,
    priority: 0,
    maxRetries: 3,
    retryCount: 0,
    runAt: Date.now(),
    createdAt: Date.now(),
    startedAt: Date.now(),
    completedAt: null,
  };
}

function makeSessionLifecycle(
  impl?: Partial<Pick<SessionLifecycle, 'generateTitleAndRenameBranch'>>
): SessionLifecycle {
  return {
    generateTitleAndRenameBranch:
      impl?.generateTitleAndRenameBranch ??
      mock(() => Promise.resolve({ title: 'Generated Title', isFallback: false })),
  } as unknown as SessionLifecycle;
}

describe('handleSessionTitleGeneration', () => {
  it('calls generateTitleAndRenameBranch with correct params and returns { generated: true }', async () => {
    const stub = mock(() => Promise.resolve({ title: 'My Title', isFallback: false }));
    const lifecycle = makeSessionLifecycle({ generateTitleAndRenameBranch: stub });

    const job = makeJob({ sessionId: 'session-123', userMessageText: 'hello world' });
    const result = await handleSessionTitleGeneration(job, lifecycle);

    expect(result).toEqual({ generated: true });
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub).toHaveBeenCalledWith('session-123', 'hello world');
  });

  it('propagates errors from generateTitleAndRenameBranch for job queue retry', async () => {
    const error = new Error('API failure');
    const stub = mock(() => Promise.reject(error));
    const lifecycle = makeSessionLifecycle({ generateTitleAndRenameBranch: stub });

    const job = makeJob({ sessionId: 'session-abc', userMessageText: 'some text' });

    await expect(handleSessionTitleGeneration(job, lifecycle)).rejects.toThrow('API failure');
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it('propagates "session not found" error when session is missing', async () => {
    const stub = mock(() => Promise.reject(new Error('Session session-missing not found')));
    const lifecycle = makeSessionLifecycle({ generateTitleAndRenameBranch: stub });

    const job = makeJob({ sessionId: 'session-missing', userMessageText: 'hi' });

    await expect(handleSessionTitleGeneration(job, lifecycle)).rejects.toThrow(
      'Session session-missing not found'
    );
  });

  it('throws when sessionId is missing from payload', async () => {
    const lifecycle = makeSessionLifecycle();
    const job = makeJob({ userMessageText: 'hello' });

    await expect(handleSessionTitleGeneration(job, lifecycle)).rejects.toThrow(
      'Job payload missing required field: sessionId'
    );
  });

  it('throws when sessionId is not a string', async () => {
    const lifecycle = makeSessionLifecycle();
    const job = makeJob({ sessionId: 42, userMessageText: 'hello' });

    await expect(handleSessionTitleGeneration(job, lifecycle)).rejects.toThrow(
      'Job payload missing required field: sessionId'
    );
  });

  it('throws when userMessageText is missing from payload', async () => {
    const lifecycle = makeSessionLifecycle();
    const job = makeJob({ sessionId: 'session-123' });

    await expect(handleSessionTitleGeneration(job, lifecycle)).rejects.toThrow(
      'Job payload missing required field: userMessageText'
    );
  });

  it('throws when userMessageText is an empty string', async () => {
    const lifecycle = makeSessionLifecycle();
    const job = makeJob({ sessionId: 'session-123', userMessageText: '' });

    await expect(handleSessionTitleGeneration(job, lifecycle)).rejects.toThrow(
      'Job payload missing required field: userMessageText'
    );
  });
});
