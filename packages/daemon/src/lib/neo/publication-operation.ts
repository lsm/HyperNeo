import { neoToolDescription } from '@hyperneo/prompts';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type { NeoPublicationInput, NeoPublication } from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { readCardArtifactFacts, unverifiedCardArtifact } from './card-artifact-admission.ts';
import type { ArtifactRefReader } from '../artifacts/read-operations.ts';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import { voiceDiagnostic } from '../voice/diagnostics.ts';
import type { NeoPublicationWriteResult } from '../../storage/repositories/neo-publication-repository.ts';
import { isMainNeoBinding } from './binding-roles.ts';
import { neoDerivedId } from './derived-id.ts';
import {
  NeoPublicationObject,
  NeoPublicationResultSchema,
  publicationTextRule,
  workerSession,
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
    spoken: z.string().trim().min(1).max(500).optional(),
    session: NeoPublicationObject.shape.session.nullable(),
    links: z
      .array(
        NeoPublicationObject.shape.links.unwrap().element.extend({ kind: z.literal('project') })
      )
      .max(16)
      .default([]),
  })
  .superRefine(publicationTextRule);
type Draft = z.infer<typeof Draft>;
const Result = NeoPublicationResultSchema.and(
  z.object({
    guidance: z.string().optional(),
    listening: z.enum(['yes', 'no']).optional(),
    spokenDelivered: z.boolean().optional(),
  })
);
type Rejection = { accepted: false; reason: string; detail?: string };
type Receipt = NeoPublicationWriteResult | Rejection;
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
  speech(
    sessionId: string,
    version: string,
    text?: string
  ): Promise<{
    listening: 'yes' | 'no';
    spokenDelivered: boolean;
  }>;
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
      (draft: Draft, caller: OperationCaller) =>
        readCardArtifactFacts(draft.artifacts ?? [], caller, runtime.artifact),
      ['submitted', 'caller'],
      'registeredArtifacts'
    )
    .pipe(
      (
        draft: Draft,
        proof: Proof,
        registered: Awaited<ReturnType<typeof readCardArtifactFacts>>
      ) => {
        const unknown = unverifiedCardArtifact(draft.artifacts ?? [], registered);
        return unknown
          ? {
              reason: {
                accepted: false as const,
                reason: 'invalid_artifact_reference',
                detail: `Artifact "${unknown.artifactId}" is not one you can attach as given.`,
              },
            }
          : { value: proof };
      },
      ['submitted', 'publication', 'registeredArtifacts'],
      'result:publication'
    )
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
        const worker = workerSession(draft.session);
        const prior =
          worker === undefined
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
        const session = worker ?? workerSession(runtime.sourceSession(caller.sessionId!));
        const status = session ? await runtime.lookupSession(session) : 'not_found';
        return worker && status !== 'found'
          ? {
              reason: {
                accepted: false,
                reason: status === 'not_found' ? 'unknown_session' : 'session_lookup_failed',
                detail:
                  status === 'not_found'
                    ? `Unknown session: ${worker}`
                    : `Session lookup failed: ${worker}. Retry the same requestId without changing the session id.`,
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
        const { requestId, spoken: _spoken, ...message } = draft;
        return runtime.append({
          ...message,
          session: message.session ?? undefined,
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
      async (receipt: Receipt, draft: Draft, caller: OperationCaller) => {
        if (receipt.accepted && receipt.created)
          voiceDiagnostic('voice.publication.persisted', {
            sessionId: caller.sessionId,
            requestId: draft.requestId,
            publicationId: receipt.publication.publicationId,
            atMs: Date.now(),
          });
        if (!receipt.accepted) return receipt;
        const { versionCreated, ...saved } = receipt;
        const fresh = receipt.created || versionCreated === true;
        const version = receipt.publication.revisionId ?? receipt.publication.publicationId;
        const speech = await runtime.speech(
          caller.sessionId!,
          version,
          fresh ? draft.spoken : undefined
        );
        runtime.notify();
        return {
          ...saved,
          ...speech,
          guidance:
            fresh && !draft.spoken && speech.listening === 'yes'
              ? `Already shown to the user. The human is now listening: call neo.speech.say once with a short spoken version and requestId "publication:${version}"; never re-publish the text.`
              : 'Already shown to the user; no assistant text this turn except a requested transcript/record or required scheduled-wake summary.',
        };
      },
      ['publication', 'draft', 'caller'],
      'publication'
    )
    .endAsync('publication') as (input: unknown, caller: OperationCaller) => Promise<Receipt>;
}

export function createNeoPublicationOperation(
  publish: ReturnType<typeof createNeoPublisher>,
  present?: (items: NeoPublication[]) => Promise<NeoPublication[]>
) {
  return defineOperation({
    name: 'neo.publication.publish',
    description: neoToolDescription('neo.publication.publish'),
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    inputSchema: Draft,
    resultSchema: Result,
    execute: async (input, caller) => {
      const result = await publish(input, caller);
      return Result.parse(
        result.accepted && present
          ? { ...result, publication: (await present([result.publication]))[0] }
          : result
      );
    },
  });
}
