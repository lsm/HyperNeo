import { z } from 'zod';
import type { Database } from '../../storage/sqlite-compat.ts';
import { defineOperation } from '../operations/registry.ts';
import { googleConnectionAttempt as connectionAttempt } from './status.ts';
import { getConnectionService, type GoogleConnectionDependencies } from './operations.ts';

const policy = { safetyClass: 'human_only' as const, caller: 'local_user' as const };
const id = z.string().min(1).max(200);

export function createMicrosoftConnectionOperations(
  db: () => Database,
  deps: GoogleConnectionDependencies = {}
) {
  const service = () => getConnectionService(db(), 'microsoft', deps);
  return [
    defineOperation({
      name: 'connections.microsoft.connect',
      description:
        'Connect Microsoft or reconnect the named account. Returns a one-use consent URL, never credentials.',
      policy,
      inputSchema: z
        .object({
          clientId: z.string().trim().min(1).max(500).optional(),
          connectionId: id.optional(),
        })
        .strict()
        .refine(
          (input) => input.clientId || input.connectionId,
          'Provide clientId, or connectionId to reuse saved client details.'
        ),
      resultSchema: connectionAttempt,
      execute: async (input) => (await service()).connect(input),
    }),
    defineOperation({
      name: 'connections.microsoft.login',
      description: 'Read the status of this instance’s current Microsoft consent attempt.',
      policy,
      inputSchema: z.object({ loginId: id.optional() }).strict(),
      resultSchema: connectionAttempt,
      execute: async ({ loginId }) => (await service()).status(loginId),
    }),
    defineOperation({
      name: 'connections.microsoft.disconnect',
      description:
        'Disable a Microsoft connection and erase only this instance’s credential bundle. Does not revoke the grant in the account.',
      policy,
      inputSchema: z.object({ connectionId: id }).strict(),
      resultSchema: z.object({ ok: z.boolean(), reason: z.string().optional() }),
      execute: async ({ connectionId }) => (await service()).disconnect(connectionId),
    }),
  ];
}
