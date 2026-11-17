import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { googleConnectionReads } from '../../storage/repositories/google-connections-worker.ts';
import { defineOperation } from '../operations/registry.ts';
import { connectionStatus } from './status.ts';

export function createConnectionList(db: () => Database) {
  const list = (superpipe({})('connections.list') as PipelineAPI)
    .input('input')
    .pipe(
      async () => ({ connections: await gatewayFor(db()).call(googleConnectionReads, 'list') }),
      'input',
      'connections'
    )
    .endAsync('connections') as () => Promise<{ connections: z.infer<typeof connectionStatus>[] }>;
  return defineOperation({
    name: 'connections.list',
    description: 'List this instance’s connected accounts and health. Never returns credentials.',
    policy: { safetyClass: 'human_only', caller: 'local_user' },
    inputSchema: z.object({}).strict(),
    resultSchema: z.object({ connections: z.array(connectionStatus) }),
    execute: list,
  });
}
