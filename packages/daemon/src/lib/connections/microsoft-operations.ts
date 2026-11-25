import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { Database } from '../../storage/sqlite-compat.ts';
import { defineOperation } from '../operations/registry.ts';
import { googleConnectionAttempt as connectionAttempt } from './status.ts';
import { getConnectionService, type GoogleConnectionDependencies } from './operations.ts';
import { createOutlookMailOperations } from './outlook-mail-operations.ts';
import { createOutlookDraftOperations } from './outlook-draft-operations.ts';
import { createOutlookCalendarOperations } from './outlook-calendar-operations.ts';

const policy = { safetyClass: 'human_only' as const, caller: 'local_user' as const };
const id = z.string().min(1).max(200);

export function createMicrosoftConnectionOperations(
  db: () => Database,
  deps: GoogleConnectionDependencies = {}
) {
  const service = () => getConnectionService(db(), 'microsoft', deps);
  type Service = Awaited<ReturnType<typeof service>>;
  const connect = (superpipe({})('connections.microsoft.connect') as PipelineAPI)
    .input('input')
    .pipe(
      async (input: Parameters<Service['connect']>[0]) => (await service()).connect(input),
      'input',
      'result'
    )
    .endAsync('result') as Service['connect'];
  const login = (superpipe({})('connections.microsoft.login') as PipelineAPI)
    .input('input')
    .pipe(
      async (input: { loginId?: string }) => (await service()).status(input.loginId),
      'input',
      'result'
    )
    .endAsync('result') as (input: { loginId?: string }) => Promise<ReturnType<Service['status']>>;
  const disconnect = (superpipe({})('connections.microsoft.disconnect') as PipelineAPI)
    .input('input')
    .pipe(
      async (input: { connectionId: string }) => (await service()).disconnect(input.connectionId),
      'input',
      'result'
    )
    .endAsync('result') as (input: { connectionId: string }) => ReturnType<Service['disconnect']>;
  return [
    ...createOutlookMailOperations(db, service),
    ...createOutlookDraftOperations(service),
    ...createOutlookCalendarOperations(service),
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
      execute: connect,
    }),
    defineOperation({
      name: 'connections.microsoft.login',
      description: 'Read the status of this instance’s current Microsoft consent attempt.',
      policy,
      inputSchema: z.object({ loginId: id.optional() }).strict(),
      resultSchema: connectionAttempt,
      execute: login,
    }),
    defineOperation({
      name: 'connections.microsoft.disconnect',
      description:
        'Disable a Microsoft connection and erase only this instance’s credential bundle. Does not revoke the grant in the account.',
      policy,
      inputSchema: z.object({ connectionId: id }).strict(),
      resultSchema: z.object({ ok: z.boolean(), reason: z.string().optional() }),
      execute: disconnect,
    }),
  ];
}
