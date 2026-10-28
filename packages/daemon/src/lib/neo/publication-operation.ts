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
  .extend({ requestId: z.string().min(1).max(160) })
  .superRefine(publicationTextRule);
type Draft = z.infer<typeof Draft>;
type Rejection = { accepted: false; reason: string; detail?: string };
type Receipt = NeoPublicationAppendResult | Rejection;
type Producer = {
  binding: NeoBinding;
  root: NeoBinding;
};
type Proof = Producer;
interface NeoPublicationRuntime {
  receivedHumanInput(sessionId: string, messageId: string): boolean;
  currentHumanInputs(sessionId: string): string[];
  getBinding(id: string): NeoBinding | null;
  getRootBinding(): NeoBinding | null;
  hasProject(id: string): boolean;
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
      (draft: Draft, caller: OperationCaller) => {
        const sessionId = caller.sessionId!;
        const explicit = draft.replyTo?.filter((id) => runtime.receivedHumanInput(sessionId, id));
        const inferred = draft.cardReply
          ? []
          : runtime
              .currentHumanInputs(sessionId)
              .filter((id) => runtime.receivedHumanInput(sessionId, id));
        return {
          ...draft,
          replyTo: explicit ?? (inferred.length ? [...new Set(inferred)] : undefined),
          cardReply: draft.cardReply?.sourceMessageIds.every((id) =>
            runtime.receivedHumanInput(sessionId, id)
          )
            ? draft.cardReply
            : undefined,
          links: draft.links.filter(
            (link) => link.kind === 'project' && runtime.hasProject(link.id)
          ),
          artifacts: draft.artifacts?.filter(
            (ref) => !unregisteredArtifact([ref], [runtime.artifact(ref.artifactId, caller)])
          ),
        };
      },
      ['submitted', 'caller'],
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
      (receipt: Receipt) => {
        if (receipt.accepted) runtime.notify();
        return receipt;
      },
      'publication',
      'publication'
    )
    .endAsync('publication') as (input: unknown, caller: OperationCaller) => Promise<Receipt>;
}

export function createNeoPublicationOperation(publish: ReturnType<typeof createNeoPublisher>) {
  return defineOperation({
    name: 'neo.publication.publish',
    description:
      'Deliver a message in this conversation. Use a new requestId per message and reuse it only when retrying that send. Pass verbatim: true to send the message as one field: the full content in fullText with no shortText; a request with both verbatim and shortText is rejected. Optional replyTo lists the received human message ids this publication answers; when omitted, the human inputs whose turn produced this publication are recorded as answered when they are known. Unknown, foreign, queued and non-human reply ids are omitted. Non-project and unavailable links are omitted, including work and consultation links. Unavailable artifact references are omitted. For a document or evidence file, pass the reference artifact.file.register returned in artifacts and say in one sentence what it is.',
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    inputSchema: Draft,
    resultSchema: NeoPublicationResultSchema,
    execute: async (input, caller) => publish(input, caller),
  });
}
