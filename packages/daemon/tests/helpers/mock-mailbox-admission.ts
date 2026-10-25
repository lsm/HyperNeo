import { enqueueMailboxEntry } from '../../src/lib/mailbox/enqueue';
import type { MailboxEntry } from '../../src/lib/mailbox/entry';
import { bindGateway, type DbGateway } from '../../src/storage/db-gateway/db-gateway';
import type { JobQueueRepository } from '../../src/storage/repositories/job-queue-repository';
import type { Database } from '../../src/storage/sqlite-compat';

export function mockMailboxAdmission<T extends object>(queue: T): T {
  const connection = ('db' in queue ? queue.db : {}) as Database;
  Object.assign(queue, { db: connection });
  bindGateway(connection, {
    call: async (_op: unknown, method: string, entry: MailboxEntry) => {
      if (method !== 'enqueue') throw new Error(`Unexpected mock mailbox command: ${method}`);
      return enqueueMailboxEntry(queue as unknown as JobQueueRepository, entry);
    },
  } as unknown as DbGateway);
  return queue;
}
