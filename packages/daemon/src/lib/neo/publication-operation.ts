import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type {
  NeoPublicationAppendResult,
  NeoPublicationInput,
} from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { unregisteredArtifact } from '../artifacts/file-contracts.ts';
import type { ArtifactRefReader } from '../artifacts/read-operations.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { voiceDiagnostic } from '../voice/diagnostics.ts';
import { isMainNeoBinding } from './binding-roles.ts';
import { neoDerivedId } from './derived-id.ts';
import {
  NeoPublicationObject,
  NeoPublicationResultSchema,
  publicationTextRule,
} from './publication.ts';

const Draft = NeoPublicationObject.omit({
  conversationId: true,
  publicationId: true,
  askOrigin: true,
  producerInput: true,
  triggerId: true,
  editedAt: true,
  editedBy: true,
  answerInput: true,
  answerOrigin: true,
  languageMismatch: true,
  revisionId: true,
  revisions: true,
})
  .extend({
    requestId: z.string().min(1).max(160),
    links: z
      .array(
        NeoPublicationObject.shape.links.unwrap().element.extend({ kind: z.literal('project') })
      )
      .max(16)
      .default([]),
  })
  .superRefine(publicationTextRule);
type Draft = z.infer<typeof Draft>;
type Rejection = { accepted: false; reason: string; detail?: string };
type Receipt = NeoPublicationAppendResult | Rejection;
type Producer = {
  binding: NeoBinding;
  root: NeoBinding;
};
type Proof = Producer & { session?: string };
interface NeoPublicationRuntime {
  receivedHumanInput(sessionId: string, messageId: string): boolean;
  currentHumanInputs(sessionId: string): string[];
  getBinding(id: string): NeoBinding | null;
  getRootBinding(): NeoBinding | null;
  hasProject(id: string): boolean;
  lookupSession(
    id: string
  ): 'found' | 'not_found' | 'unavailable' | Promise<'found' | 'not_found' | 'unavailable'>;
  publication(
    conversationId: string,
    publicationId: string
  ): Pick<NeoPublicationInput, 'session'> | null;
  sourceSession(sessionId: string): string | undefined;
  append(input: NeoPublicationInput): Receipt | Promise<Receipt>;
  notify(): void;
  artifact: ArtifactRefReader;
}

export function admitPublicationDraft(input: unknown): { value: Draft } | { reason: Rejection } {
  const parsed = Draft.safeParse(input);
  return parsed.success
    ? { value: parsed.data }
    : { reason: { accepted: false, reason: 'invalid_publication' } };
}

export function requirePublicationProducer(
  caller: OperationCaller,
  binding: NeoBinding | null,
  root: NeoBinding | null
): { value: Producer } | { reason: Rejection } {
  return caller.source === 'mcp' &&
    binding &&
    binding.sessionId === caller.sessionId &&
    isMainNeoBinding(root) &&
    isMainNeoBinding(binding) &&
    binding.sessionId === root.sessionId
    ? {
        value: {
          binding,
          root,
        },
      }
    : { reason: { accepted: false, reason: 'avatar_required' } };
}

export function requirePublicationLifetime(
  proof: Proof,
  caller: OperationCaller,
  binding: NeoBinding | null,
  root: NeoBinding | null
): { value: Proof } | { reason: Rejection } {
  return caller.sessionId === proof.binding.sessionId &&
    binding?.kind === proof.binding.kind &&
    binding.projectId === proof.binding.projectId &&
    binding.sessionId === proof.binding.sessionId &&
    isMainNeoBinding(root) &&
    root.sessionId === proof.root.sessionId
    ? { value: proof }
    : { reason: { accepted: false, reason: 'publication_superseded' } };
}

export function createNeoPublisher(runtime: NeoPublicationRuntime) {
  return (superpipe({})('neo-publication-publish') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitPublicationDraft, 'input', 'result:publication')
    .pipe((draft: Draft) => draft, 'publication', 'submitted')
    .pipe(
      (caller: OperationCaller) => runtime.getBinding(caller.sessionId ?? ''),
      'caller',
      'binding'
    )
    .pipe(() => runtime.getRootBinding(), 'caller', 'root')
    .pipe(requirePublicationProducer, ['caller', 'binding', 'root'], 'result:publication')
    .pipe(
      (draft: Draft, proof: Proof) => {
        const unknown = draft.links.find((link) => !runtime.hasProject(link.id));
        return unknown
          ? {
              reason: {
                accepted: false,
                reason: 'unknown_project',
                detail: `Unknown project link: ${unknown.id} (${unknown.label})`,
              },
            }
          : { value: proof };
      },
      ['submitted', 'publication'],
      'result:publication'
    )
    .pipe(
      async (draft: Draft, proof: Proof, caller: OperationCaller) => {
        const prior =
          draft.session === undefined
            ? runtime.publication(
                proof.root.sessionId.slice(4),
                neoDerivedId(
                  JSON.stringify([
                    'neo.publication.publish',
                    proof.binding.sessionId,
                    draft.requestId,
                  ])
                )
              )
            : null;
        if (prior) return { value: { ...proof, session: prior.session } };
        const session = draft.session ?? runtime.sourceSession(caller.sessionId!);
        const status = session ? await runtime.lookupSession(session) : 'not_found';
        return draft.session && status !== 'found'
          ? {
              reason: {
                accepted: false,
                reason: status === 'not_found' ? 'unknown_session' : 'session_lookup_failed',
                detail:
                  status === 'not_found'
                    ? `Unknown session: ${draft.session}`
                    : `Session lookup failed: ${draft.session}. Retry the same requestId without changing the session id.`,
              },
            }
          : { value: { ...proof, session: status === 'found' ? session : undefined } };
      },
      ['submitted', 'publication', 'caller'],
      'result:publication'
    )
    .pipe(
      (draft: Draft, caller: OperationCaller, proof: Proof) => {
        const sessionId = caller.sessionId!;
        const explicit = draft.replyTo?.filter((id) => runtime.receivedHumanInput(sessionId, id));
        const inferred = draft.cardReply
          ? []
          : runtime
              .currentHumanInputs(sessionId)
              .filter((id) => runtime.receivedHumanInput(sessionId, id));
        return {
          ...draft,
          session: proof.session,
          replyTo: explicit ?? (inferred.length ? [...new Set(inferred)] : undefined),
          cardReply: draft.cardReply?.sourceMessageIds.every((id) =>
            runtime.receivedHumanInput(sessionId, id)
          )
            ? draft.cardReply
            : undefined,
          artifacts: draft.artifacts?.filter(
            (ref) => !unregisteredArtifact([ref], [runtime.artifact(ref.artifactId, caller)])
          ),
        };
      },
      ['submitted', 'caller', 'publication'],
      'draft'
    )
    .pipe(
      (proof: Proof, caller: OperationCaller) =>
        requirePublicationLifetime(
          proof,
          caller,
          runtime.getBinding(proof.binding.sessionId),
          runtime.getRootBinding()
        ),
      ['publication', 'caller'],
      'result:publication'
    )
    .pipe(
      (draft: Draft, proof: Proof) => {
        const { requestId, ...message } = draft;
        return runtime.append({
          ...message,
          publicationId: neoDerivedId(
            JSON.stringify(['neo.publication.publish', proof.binding.sessionId, requestId])
          ),
          conversationId: proof.root.sessionId.slice(4),
        });
      },
      ['draft', 'publication'],
      'publication'
    )
    .pipe(
      (receipt: Receipt, draft: Draft, caller: OperationCaller) => {
        if (receipt.accepted && receipt.created)
          voiceDiagnostic('voice.publication.persisted', {
            sessionId: caller.sessionId,
            requestId: draft.requestId,
            publicationId: receipt.publication.publicationId,
            atMs: Date.now(),
          });
        if (receipt.accepted) runtime.notify();
        return receipt.accepted
          ? {
              ...receipt,
              guidance:
                'Already shown to the user; no assistant text this turn except a requested transcript/record or required scheduled-wake summary.',
            }
          : receipt;
      },
      ['publication', 'draft', 'caller'],
      'publication'
    )
    .endAsync('publication') as (input: unknown, caller: OperationCaller) => Promise<Receipt>;
}

export function createNeoPublicationOperation(publish: ReturnType<typeof createNeoPublisher>) {
  return defineOperation({
    name: 'neo.publication.publish',
    description:
      'Deliver a message in this conversation. Use a new requestId per message and reuse it only when retrying that send. Pass verbatim: true to send the message as one field: the full content in fullText with no shortText; a request with both verbatim and shortText is rejected. Optional replyTo lists the received human message ids this publication answers; when omitted, the human inputs whose turn produced this publication are recorded as answered when they are known. Unknown, foreign, queued and non-human reply ids are omitted. When a reply is about one session the human may want to open, pass session: its exact session id rather than promising a link in text. Unknown session ids reject the publication without saving; correct the id and retry the same requestId. session_lookup_failed means the lookup is unavailable: retry the same requestId and session id. If session is omitted, the daemon fills it only for an unambiguous recorded sender of the current inputs. Only project links are accepted; an unknown project id rejects the entire publication without saving. Correct the link and retry with the same requestId. Unavailable artifact references are omitted. For a working document or evidence file, put its absolute path on the owning daemon in the text and say in one sentence what it is. The preview reads the current file. Existing saved attachments and fixed-head Git references remain supported in artifacts.',
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    inputSchema: Draft,
    resultSchema: NeoPublicationResultSchema.and(z.object({ guidance: z.string().optional() })),
    execute: async (input, caller) => publish(input, caller),
  });
}
