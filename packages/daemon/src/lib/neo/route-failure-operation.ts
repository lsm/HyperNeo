import type { NeoRouteFailure } from '@hyperneo/shared/types/neo-snapshot';
import { z } from 'zod';
import type { Database } from '../../storage/database.ts';
import { NeoRoutingLogRepository } from '../../storage/repositories/neo-routing-log-repository.ts';
import { defineOperation } from '../operations/registry.ts';

export const NeoRouteFailureSchema = z.object({
  at: z.number(),
  signal: z.string(),
  cause: z.string(),
}) satisfies z.ZodType<NeoRouteFailure>;

export function createNeoRouteFailureOperation(db: Database) {
  return defineOperation({
    name: 'neo.route.failure',
    description:
      'Read the latest Neo routing failure: when it happened (ms epoch), its fallback signal and its cause. failure is null when routing has never failed.',
    inputSchema: z.object({}),
    resultSchema: z.object({ failure: NeoRouteFailureSchema.nullable() }),
    policy: { safetyClass: 'read', roles: ['neo'] },
    execute: async () => ({
      failure: new NeoRoutingLogRepository(db.getDatabase()).latestFailure(),
    }),
  });
}
