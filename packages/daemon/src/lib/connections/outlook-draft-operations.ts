import { z } from 'zod';
import superpipe, { type PipelineAPI } from 'superpipe';
import { defineOperation } from '../operations/registry.ts';
import { admit, policy } from './google-read-operations.ts';
import { draftInput } from './gmail-mime.ts';
import type { createConnectionLifecycle } from './lifecycle.ts';

type Service = ReturnType<typeof createConnectionLifecycle>;
const failure = z.object({ ok: z.literal(false), reason: z.string() });
const draftId = z.string().min(1).max(512);
const messages = 'https://graph.microsoft.com/v1.0/me/messages';
const scope = 'Mail.ReadWrite';
const outlookDraftInput = draftInput
  .omit({ attachments: true })
  .extend({ draftId: draftId.optional() });
type Input = z.infer<typeof outlookDraftInput>;
const unknown = { ok: false as const, reason: 'draft_outcome_unknown' };
const recipients = (addresses: string[]) =>
  addresses.map((address) => ({ emailAddress: { address } }));

export function createOutlookDraftOperations(service: () => Promise<Service>) {
  const draft = (superpipe({})('outlook.draft') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admit, 'caller', 'result:result')
    .pipe(() => service(), 'result', 'api')
    .pipe(
      async (input: Input, api: Service) => {
        if (!input.draftId) return { value: null };
        const reply = await api.http.get(
          input.connectionId,
          `${messages}/${encodeURIComponent(input.draftId)}?$select=id,isDraft`,
          scope
        );
        if (!reply.ok) return { reason: reply };
        const found = z.object({ id: draftId, isDraft: z.boolean() }).safeParse(reply.data);
        return !found.success || found.data.id !== input.draftId
          ? { reason: { ok: false as const, reason: 'invalid_response' } }
          : found.data.isDraft
            ? { value: input.draftId }
            : { reason: { ok: false as const, reason: 'not_a_draft' } };
      },
      ['input', 'api'],
      'result:result'
    )
    .pipe(
      async (input: Input, existing: string | null, api: Service) => {
        const reply = await api.http.write(
          input.connectionId,
          existing ? `${messages}/${encodeURIComponent(existing)}` : messages,
          scope,
          existing ? 'PATCH' : 'POST',
          JSON.stringify({
            subject: input.subject,
            body: { contentType: 'Text', content: input.text },
            toRecipients: recipients(input.to),
            ccRecipients: recipients(input.cc),
            bccRecipients: recipients(input.bcc),
          })
        );
        if (!reply.ok)
          return ['timeout', 'cancelled', 'request_failed', 'invalid_response'].includes(
            reply.reason
          )
            ? unknown
            : reply;
        const saved = z.object({ id: draftId, isDraft: z.literal(true) }).safeParse(reply.data);
        return saved.success && (!existing || saved.data.id === existing)
          ? { ok: true as const, draftId: saved.data.id }
          : unknown;
      },
      ['input', 'result', 'api'],
      'result'
    )
    .endAsync('result');
  return [
    defineOperation({
      name: 'outlook.draft',
      description:
        'Create a text draft in Outlook Drafts, or update one named by draftId. Returns its id; the human reviews and sends in Outlook. Any message that is not a draft is refused, and there is no send action. If the outcome is unknown, check Outlook drafts before retrying.',
      policy: { ...policy, safetyClass: 'mutate' },
      inputSchema: outlookDraftInput,
      resultSchema: z.union([failure, z.object({ ok: z.literal(true), draftId })]),
      execute: async (value, caller) => {
        try {
          return await draft(value, caller);
        } catch {
          return { ok: false, reason: 'request_failed' };
        }
      },
    }),
  ];
}
