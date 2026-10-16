import type { NeoBinding, NeoConsultation, NeoWork } from '@hyperneo/shared/types/neo-context';
import type {
  NeoPublicationAppendResult,
  NeoPublicationInput,
  NeoPublicationLink,
} from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { NeoAskOrigin } from './ask-origin.ts';
import {
  NeoPublicationSchema,
  NeoPublicationResultSchema,
  withNeoPublicationAnswer,
} from './publication.ts';
import { isMainNeoBinding } from './binding-roles.ts';
import { requirePublicationTrigger } from './notification-triggers.ts';
import { neoDerivedId } from './derived-id.ts';

const Draft = NeoPublicationSchema.omit({
  conversationId: true,
  publicationId: true,
  askOrigin: true,
  producerInput: true,
  editedAt: true,
  editedBy: true,
  answerInput: true,
  answerOrigin: true,
  languageMismatch: true,
  revisionId: true,
  revisions: true,
}).extend({ requestId: z.string().min(1).max(160) });
type Draft = z.infer<typeof Draft>;
type Rejection = { accepted: false; reason: string; detail?: string };
type Receipt = NeoPublicationAppendResult | Rejection;
type Producer = {
  binding: NeoBinding;
  root: NeoBinding;
  input: NeoAskOrigin;
  turn: NonNullable<OperationCaller['neoTurn']>;
};
type Proof = Producer & { ask: NeoAskOrigin };
type Triggered = Proof & { triggerId?: string };
type LinkEvidence = {
  link: NeoPublicationLink;
  exists: boolean;
  projectId: string | null;
  origin: NeoAskOrigin | null;
};

interface NeoPublicationRuntime {
  getBinding(id: string): NeoBinding | null;
  getRootBinding(): NeoBinding | null;
  hasProject(id: string): boolean;
  getWork(id: string): NeoWork | null;
  getConsultation(id: string): NeoConsultation | null;
  resolveAskOrigin(input: NeoAskOrigin): NeoAskOrigin | null;
  append(input: NeoPublicationInput): Receipt;
  inputTrigger(input: NeoAskOrigin): string | null;
  notify(): void;
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
  const turn = caller.neoTurn;
  return caller.source === 'mcp' &&
    binding &&
    binding.sessionId === caller.sessionId &&
    isMainNeoBinding(root) &&
    root.sessionId.startsWith('neo:') &&
    ((isMainNeoBinding(binding) && binding.sessionId === root.sessionId) ||
      (binding.kind === 'project' && binding.projectId !== null)) &&
    turn?.messageId &&
    turn.isLive()
    ? {
        value: {
          binding,
          root,
          input: { sessionId: binding.sessionId, messageId: turn.messageId },
          turn,
        },
      }
    : { reason: { accepted: false, reason: 'live_avatar_required' } };
}

function publicationLinkProblem(
  proof: Proof,
  { link, exists, projectId, origin }: LinkEvidence
): string | null {
  const ref = `${link.kind} link "${link.id}"`;
  if (!exists)
    return `${ref} does not exist; link only Neo project, work or consultation ids, never work.find refs or session ids`;
  if (proof.binding.kind !== 'neo' && projectId !== proof.binding.projectId)
    return `${ref} belongs to another project`;
  if (
    link.kind !== 'project' &&
    (origin?.sessionId !== proof.ask.sessionId || origin.messageId !== proof.ask.messageId)
  )
    return `${ref} was not started for this ask; link only work or consultations this ask created`;
  return null;
}

export function requirePublicationLinks(
  proof: Proof,
  evidence: readonly LinkEvidence[]
): { value: Proof } | { reason: Rejection } {
  const problem = evidence.map((item) => publicationLinkProblem(proof, item)).find(Boolean);
  return problem
    ? { reason: { accepted: false, reason: 'invalid_scene_reference', detail: problem } }
    : { value: proof };
}

export function requirePublicationNotConsulted(
  producer: Producer
): { value: Producer } | { reason: Rejection } {
  return producer.turn.consultationId
    ? {
        reason: {
          accepted: false,
          reason: 'consultation_answer',
          detail:
            'A consultation informs Neo; it never answers the human. Return your answer with neo.project.respond {id, answer}; Neo answers the human.',
        },
      }
    : { value: producer };
}

export function requirePublicationLifetime(
  proof: Proof,
  caller: OperationCaller,
  binding: NeoBinding | null,
  root: NeoBinding | null
): { value: Proof } | { reason: Rejection } {
  return caller.neoTurn === proof.turn &&
    caller.sessionId === proof.input.sessionId &&
    proof.turn.messageId === proof.input.messageId &&
    proof.turn.isLive() &&
    binding?.kind === proof.binding.kind &&
    binding.projectId === proof.binding.projectId &&
    binding.sessionId === proof.binding.sessionId &&
    isMainNeoBinding(root) &&
    root.sessionId === proof.root.sessionId
    ? { value: proof }
    : { reason: { accepted: false, reason: 'publication_superseded' } };
}

function readLinkEvidence(link: NeoPublicationLink, runtime: NeoPublicationRuntime): LinkEvidence {
  if (link.kind === 'project')
    return { link, exists: runtime.hasProject(link.id), projectId: link.id, origin: null };
  const item = link.kind === 'work' ? runtime.getWork(link.id) : runtime.getConsultation(link.id);
  const input = item?.originMessageId
    ? { sessionId: item.originSessionId, messageId: item.originMessageId }
    : link.kind === 'consultation' && item?.sessionId
      ? { sessionId: item.sessionId, messageId: `neo-consult:${item.id}:request` }
      : null;
  return {
    link,
    exists: !!item,
    projectId: item?.projectId ?? null,
    origin: input ? runtime.resolveAskOrigin(input) : null,
  };
}

export function createNeoPublisher(runtime: NeoPublicationRuntime) {
  return (superpipe({})('neo-publication-publish') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitPublicationDraft, 'input', 'result:publication')
    .pipe((draft: Draft) => draft, 'publication', 'draft')
    .pipe(
      (caller: OperationCaller) => runtime.getBinding(caller.sessionId ?? ''),
      'caller',
      'binding'
    )
    .pipe(() => runtime.getRootBinding(), 'caller', 'root')
    .pipe(requirePublicationProducer, ['caller', 'binding', 'root'], 'result:publication')
    .pipe(requirePublicationNotConsulted, 'publication', 'result:publication')
    .pipe(
      (producer: Producer): Proof => ({
        ...producer,
        ask: runtime.resolveAskOrigin(producer.input) ?? producer.input,
      }),
      'publication',
      'publication'
    )
    .pipe(
      (draft: Draft) => draft.links.map((link) => readLinkEvidence(link, runtime)),
      'draft',
      'links'
    )
    .pipe(requirePublicationLinks, ['publication', 'links'], 'result:publication')
    .pipe(
      (proof: Proof, caller: OperationCaller) =>
        requirePublicationLifetime(
          proof,
          caller,
          runtime.getBinding(proof.input.sessionId),
          runtime.getRootBinding()
        ),
      ['publication', 'caller'],
      'result:publication'
    )
    .pipe((proof: Proof) => runtime.inputTrigger(proof.input), 'publication', 'trigger')
    .pipe(requirePublicationTrigger, ['publication', 'draft', 'trigger'], 'result:publication')
    .pipe(
      (draft: Draft, proof: Triggered) => {
        const { requestId, ...message } = draft;
        return runtime.append({
          ...message,
          publicationId: neoDerivedId(
            JSON.stringify([
              'neo.publication.publish',
              proof.input.sessionId,
              proof.input.messageId,
              requestId,
            ])
          ),
          triggerId: proof.triggerId,
          conversationId: proof.root.sessionId.slice(4),
          askOrigin: proof.ask,
          producerInput: proof.input,
        });
      },
      ['draft', 'publication'],
      'publication'
    )
    .pipe(
      (receipt: Receipt) => {
        if (receipt.accepted) runtime.notify();
        return withNeoPublicationAnswer(
          receipt,
          receipt.accepted ? runtime.resolveAskOrigin(receipt.publication.askOrigin) : null
        );
      },
      'publication',
      'publication'
    )
    .end('publication') as (
    input: unknown,
    caller: OperationCaller
  ) => ReturnType<typeof withNeoPublicationAnswer>;
}

export function createNeoPublicationOperation(publish: ReturnType<typeof createNeoPublisher>) {
  return defineOperation({
    name: 'neo.publication.publish',
    description:
      'Deliver a message in this conversation. Use a new requestId per message and reuse it only when retrying that send. The runtime derives publication identity, original request and producer. Scene references must exist and belong to the request. The answered field identifies the human message answered by this delivery and its publication/revision; null means no human message was resolved. It does not complete background work or require another post.',
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    inputSchema: Draft,
    resultSchema: NeoPublicationResultSchema,
    execute: async (input, caller) => publish(input, caller),
  });
}
