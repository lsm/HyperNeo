import { describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { GitHubService } from '../../../../src/lib/github/github-service';
import { GITHUB_POLL } from '../../../../src/lib/job-queue-constants';
import { bindGateway, DbGateway } from '../../../../src/storage/db-gateway/db-gateway';
import { createMailboxTestDb } from '../../../helpers/mailbox-test-db';

vi.mock('../../../../src/lib/job-queue-constants.ts', async () => ({
  ...(await vi.importActual('../../../../src/lib/job-queue-constants.ts')),
  GITHUB_POLL: 'synthetic.renamed.github.poll',
}));

describe('GitHubService queue identity', () => {
  test('refresh admission and deletion follow the processor queue after an identity change', async () => {
    const fixture = createMailboxTestDb();
    bindGateway(fixture.db, new DbGateway(':memory:', fixture.db));
    const legacy = fixture.jobQueue.enqueue({ queue: 'github.poll', payload: {} });
    const registered: string[] = [];
    let interval = 60;
    const service = new GitHubService({
      db: { getDatabase: () => fixture.db } as ConstructorParameters<typeof GitHubService>[0]['db'],
      internalEventBus: {} as ConstructorParameters<typeof GitHubService>[0]['internalEventBus'],
      config: {} as ConstructorParameters<typeof GitHubService>[0]['config'],
      apiKey: '',
      githubToken: 'synthetic-transport-only',
      jobQueue: fixture.jobQueue,
      jobProcessor: {
        register: (queue: string) => registered.push(queue),
      } as unknown as ConstructorParameters<typeof GitHubService>[0]['jobProcessor'],
      getPollingIntervalSeconds: () => interval,
    });
    try {
      await service.start();
      expect(registered).toEqual([GITHUB_POLL]);
      expect(fixture.jobQueue.listJobs({ queue: GITHUB_POLL, status: 'pending' })).toHaveLength(1);
      expect(fixture.jobQueue.getJob(legacy.id)).toEqual(legacy);
      interval = 0;
      await service.refreshPolling();
      expect(fixture.jobQueue.listJobs({ queue: GITHUB_POLL, status: 'pending' })).toEqual([]);
      expect(fixture.jobQueue.getJob(legacy.id)).toEqual(legacy);
    } finally {
      service.stop();
      fixture.close();
    }
  });
});
