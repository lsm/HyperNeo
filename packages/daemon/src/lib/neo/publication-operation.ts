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
import { NeoPublicationSchema } from './publication.ts';
import { CONSULTATION_TIMEOUT_MS } from './consultation-policy.ts';
import { isMainNeoBinding } from './binding-roles.ts';
import { requirePublicationNews } from './publication-news.ts';
import {
  NEO_HUMAN_TRIGGER_PREFIX,
  neoConsultationTrigger,
  neoInputTrigger,
  requirePublicationTrigger,
  requireUnpublishedTrigger,
} from './notification-triggers.ts';

const Draft = NeoPublicationSchema.omit({
  conversationId: true,
  askOrigin: true,
  producerInput: true,
  editedAt: true,
  editedBy: true,
  corrects: true,
  correctedBy: true,
});
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
type Triggered = Proof & { triggerId: string };
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
  append(input: NeoPublicationInput, consultationId?: string): Receipt;
  replay?(input: Draft, caller: OperationCaller): Receipt | null;
  isHumanInput(input: NeoAskOrigin): boolean;
  isTriggerPublished(conversationId: string, triggerId: string, publicationId: string): boolean;
  notify(): void;
}

export function neoPublicationTrigger(
  proof: Proof,
  consultation: NeoConsultation | null,
  isHumanInput: (input: NeoAskOrigin) => boolean
): string | null {
  if (proof.turn.consultationId) return neoConsultationTrigger(consultation, isHumanInput);
  if (
    CROSS_PROJECT_REPLY.test(proof.input.messageId) ||
    (CONSULTATION_REPLY.test(proof.input.messageId) && isHumanInput(proof.ask))
  )
    return `${NEO_HUMAN_TRIGGER_PREFIX}${proof.ask.messageId}`;
  return neoInputTrigger(proof.input.messageId, proof.turn.human);
}

const CROSS_PROJECT_REPLY = /^neo-cross-project:.+:reply$/;
const CONSULTATION_REPLY = /^neo-consult:.+:reply$/;

export function reusePublicationReceipt(
  draft: Draft,
  receipt: Receipt | null
): { value: Draft } | { reason: Receipt } {
  return receipt ? { reason: receipt } : { value: draft };
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

export function requirePublicationAsk(
  producer: Producer,
  ask: NeoAskOrigin | null
): { value: Proof } | { reason: Rejection } {
  return ask
    ? { value: { ...producer, ask } }
    : { reason: { accepted: false, reason: 'unknown_ask_origin' } };
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

export function requirePublicationLifetime(
  proof: Proof,
  caller: OperationCaller,
  binding: NeoBinding | null,
  root: NeoBinding | null,
  consultation: NeoConsultation | null = null,
  now?: number
): { value: Proof } | { reason: Rejection } {
  return caller.neoTurn === proof.turn &&
    caller.sessionId === proof.input.sessionId &&
    proof.turn.messageId === proof.input.messageId &&
    proof.turn.isLive() &&
    (!proof.turn.consultationId ||
      (consultation?.id === proof.turn.consultationId &&
        consultation.status !== 'failed' &&
        now !== undefined &&
        now < consultation.createdAt + CONSULTATION_TIMEOUT_MS &&
        consultation.sessionId === proof.input.sessionId &&
        consultation.projectId === proof.binding.projectId &&
        proof.input.messageId === `neo-consult:${consultation.id}:request`)) &&
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
      (draft: Draft, caller: OperationCaller) => runtime.replay?.(draft, caller) ?? null,
      ['draft', 'caller'],
      'receipt'
    )
    .pipe(reusePublicationReceipt, ['draft', 'receipt'], 'result:publication')
    .pipe(
      (caller: OperationCaller) => runtime.getBinding(caller.sessionId ?? ''),
      'caller',
      'binding'
    )
    .pipe(() => runtime.getRootBinding(), 'caller', 'root')
    .pipe(requirePublicationProducer, ['caller', 'binding', 'root'], 'result:publication')
    .pipe((producer: Producer) => runtime.resolveAskOrigin(producer.input), 'publication', 'ask')
    .pipe(requirePublicationAsk, ['publication', 'ask'], 'result:publication')
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
          runtime.getRootBinding(),
          proof.turn.consultationId ? runtime.getConsultation(proof.turn.consultationId) : null,
          Date.now()
        ),
      ['publication', 'caller'],
      'result:publication'
    )
    .pipe(
      (proof: Proof) =>
        neoPublicationTrigger(
          proof,
          proof.turn.consultationId ? runtime.getConsultation(proof.turn.consultationId) : null,
          (input) => runtime.isHumanInput(input)
        ),
      'publication',
      'trigger'
    )
    .pipe(requirePublicationTrigger, ['publication', 'draft', 'trigger'], 'result:publication')
    .pipe(
      (proof: Triggered, draft: Draft) =>
        requireUnpublishedTrigger(
          proof,
          proof.triggerId,
          runtime.isTriggerPublished(
            proof.root.sessionId.slice(4),
            proof.triggerId,
            draft.publicationId
          )
        ),
      ['publication', 'draft'],
      'result:publication'
    )
    .pipe(requirePublicationNews, ['publication', 'draft'], 'result:publication')
    .pipe(
      (draft: Draft, proof: Triggered) =>
        runtime.append(
          {
            ...draft,
            triggerId: proof.triggerId,
            conversationId: proof.root.sessionId.slice(4),
            askOrigin: proof.ask,
            producerInput: proof.input,
          },
          proof.turn.consultationId
        ),
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
    .end('publication') as (
    input: unknown,
    caller: OperationCaller
  ) => NeoPublicationAppendResult | Rejection;
}

export function createNeoPublicationOperation(publish: ReturnType<typeof createNeoPublisher>) {
  return defineOperation({
    name: 'neo.publication.publish',
    description:
      'Publish the one message a notification trigger allows: the reply to the human message this turn answers, or the sentence a daemon trigger note asks for (an ask outcome, what the human must do, or what broke). Write it in the language of the human\'s last message. Pass the note\'s triggerId, or omit it; the runtime derives the trigger from this turn and supplies the human ask and producer. Every other publication is refused with a reason: no trigger, a trigger already published, an interim status post, or a bare acknowledgement ("收到", "got it"). When refused, end the turn. Reuse publicationId only for identical retries. Scene refs must exist and work/consultation links must belong to this ask. No model summarization or execution is performed.',
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    inputSchema: Draft,
    resultSchema: z.union([
      z.object({ accepted: z.literal(false), reason: z.string(), detail: z.string().optional() }),
      z.object({
        accepted: z.literal(true),
        created: z.boolean(),
        publication: NeoPublicationSchema.extend({
          sequence: z.number().int().positive(),
          createdAt: z.string(),
        }),
      }),
    ]),
    execute: async (input, caller) => publish(input, caller),
  });
}
