import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import { defineOperation } from '../operations/registry.ts';
import { admit, id, policy } from './google-read-operations.ts';
import { draftInput, makeDraftMime } from './gmail-mime.ts';
import type { createConnectionLifecycle } from './lifecycle.ts';
import type { Database } from '../../storage/sqlite-compat.ts';
import { gatewayFor } from '../../storage/db-gateway/db-gateway.ts';
import { googleConnectionReads } from '../../storage/repositories/google-connections-worker.ts';
import type { ConnectionStatus } from './status.ts';
const failure = z.object({ ok: z.literal(false), reason: z.string() });
const replySchema = z.object({ id, message: z.object({ id, threadId: id.optional() }) });
type Input = z.infer<typeof draftInput>;
type Service = ReturnType<typeof createConnectionLifecycle>;
export function createGoogleDraftOperations(db: () => Database, service: () => Promise<Service>) {
  const draft = (superpipe({})('gmail-prepare-draft') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admit, 'caller', 'result:result')
    .pipe(() => gatewayFor(db()).call(googleConnectionReads, 'list'), 'result', 'connections')
    .pipe(
      (connections: ConnectionStatus[], input: Input) => {
        const connection = connections.find((row) => row.id === input.connectionId);
        return connection
          ? { value: connection }
          : { reason: { ok: false as const, reason: 'unknown_connection' } };
      },
      ['connections', 'input'],
      'result:result'
    )
    .pipe(
      (input: Input, connection: ConnectionStatus) => makeDraftMime(input, connection.email),
      ['input', 'result'],
      'result:result'
    )
    .pipe((body: string) => body, 'result', 'body')
    .pipe(() => service(), 'body', 'api')
    .pipe(
      async (input: Input, body: string, api: Service) => {
        const url = `https://gmail.googleapis.com/gmail/v1/users/me/drafts${input.draftId ? `/${encodeURIComponent(input.draftId)}` : ''}?fields=id,message(id,threadId)`;
        const reply = await api.http.write(
          input.connectionId,
          url,
          'https://www.googleapis.com/auth/gmail.compose',
          input.draftId ? 'PUT' : 'POST',
          body
        );
        if (!reply.ok)
          return ['timeout', 'request_failed', 'invalid_response'].includes(reply.reason)
            ? { ok: false as const, reason: 'draft_outcome_unknown' }
            : reply;
        const parsed = replySchema.safeParse(reply.data);
        if (!parsed.success || (input.draftId && input.draftId !== parsed.data.id))
          return { ok: false as const, reason: 'draft_outcome_unknown' };
        return {
          ok: true as const,
          draftId: parsed.data.id,
          messageId: parsed.data.message.id,
          threadId: parsed.data.message.threadId,
        };
      },
      ['input', 'body', 'api'],
      'result'
    )
    .endAsync('result');
  return [
    defineOperation({
      name: 'gmail.draft',
      description:
        'Create or replace a bounded MIME draft in the named account. Returns its stable draft id; the human reviews and sends in Gmail. There is no send action. If the outcome is unknown, check Gmail drafts before retrying.',
      policy: { ...policy, safetyClass: 'mutate' },
      inputSchema: draftInput,
      resultSchema: z.union([
        failure,
        z.object({ ok: z.literal(true), draftId: id, messageId: id, threadId: id.optional() }),
      ]),
      execute: async (input, caller) => {
        try {
          return await draft(input, caller);
        } catch {
          return { ok: false, reason: 'request_failed' };
        }
      },
    }),
  ];
}
