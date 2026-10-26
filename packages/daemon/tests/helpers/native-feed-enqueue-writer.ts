import { bindGateway, type DbGateway } from '../../src/storage/db-gateway/db-gateway';
import { nativeFeedEnqueueWrites } from '../../src/storage/repositories/native-feed-enqueue-write';
import type { Database } from '../../src/storage/sqlite-compat';

export function attachNativeFeedWriter<T>(queue: T): T {
  const wired = queue as T & { db?: Database; enqueueUniquePending: (input: unknown) => unknown };
  if (wired.db) return queue;
  const raw = {} as Database;
  wired.db = raw;
  bindGateway(raw, {
    call: async (op, method, input) => {
      if (op !== nativeFeedEnqueueWrites || method !== 'enqueueUniquePending') {
        throw new Error('Unexpected native-feed command');
      }
      return wired.enqueueUniquePending(input);
    },
  } as unknown as DbGateway);
  return queue;
}
