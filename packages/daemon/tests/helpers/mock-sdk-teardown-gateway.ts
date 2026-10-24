import { expect } from 'bun:test';
import { cancelMailboxJobsStage } from '../../src/lib/mailbox/cancellation';
import { sdkDeliveryTeardown } from '../../src/storage/repositories/sdk-message-transactions';
import { bindGateway, type DbGateway } from '../../src/storage/db-gateway/db-gateway';
import type { Database } from '../../src/storage/sqlite-compat';
import type { Database as FacadeDatabase } from '../../src/storage/index';

export function withSdkTeardownGateway<T extends object>(db: T): T {
  const connection = {} as Database;
  const facade = Object.assign(db, { getDatabase: () => connection }) as unknown as FacadeDatabase;
  bindGateway(connection, {
    run: async (
      op: typeof sdkDeliveryTeardown,
      args: Parameters<typeof sdkDeliveryTeardown.run>[1]
    ) => {
      expect(op).toBe(sdkDeliveryTeardown);
      const result = cancelMailboxJobsStage(
        {
          sessionId: args.sessionId,
          jobQueue: facade.getJobQueueRepo(),
          sdkMessageRepo: facade.getSDKMessageRepo(),
          deleted: [],
          failedDbIds: [],
          deps: { ...args.options, db: facade },
        },
        true
      );
      return { deleted: result.deleted, failedDbIds: result.failedDbIds };
    },
  } as unknown as DbGateway);
  return db;
}
