import { bindGateway, type DbGateway } from '../../src/storage/db-gateway/db-gateway';
import {
  DELIVERY_ENQUEUE_REJECTION,
  enqueueSessionDelivery,
} from '../../src/storage/repositories/session-delivery-enqueue-write';
import type { Database } from '../../src/storage/sqlite-compat';

export function attachDeliveryEnqueueWriter<T>(queue: T): T {
  if (!queue) return queue;
  const wired = queue as T & { db?: Database; enqueue?: (input: unknown) => unknown };
  if (wired.db) return queue;
  const raw = {} as Database;
  wired.db = raw;
  bindGateway(raw, {
    call: async (op, method, input) => {
      if (op !== enqueueSessionDelivery || method !== 'enqueue') {
        throw new Error('Unexpected delivery enqueue command');
      }
      if (!wired.enqueue) throw new Error('Fixture has no enqueue implementation');
      try {
        return await Reflect.apply(wired.enqueue, queue, [input]);
      } catch (error) {
        throw new Error(
          DELIVERY_ENQUEUE_REJECTION + (error instanceof Error ? error.message : String(error))
        );
      }
    },
  } as unknown as DbGateway);
  return queue;
}
