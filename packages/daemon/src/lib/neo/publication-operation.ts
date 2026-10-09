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

const Draft = NeoPublicationSchema.omit({
  conversationId: true,
  askOrigin: true,
  producerInput: true,
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
type LinkEvidence = {
  link: NeoPublicationLink;
  exists: boolean;
  concernId: string | null;
  origin: NeoAskOrigin | null;
};

export interface NeoPublicationRuntime {
  getBinding(id: string): NeoBinding | null;
  getRootBinding(): NeoBinding | null;
  hasConcern(id: string): boolean;
  getWork(id: string): NeoWork | null;
  getConsultation(id: string): NeoConsultation | null;
  resolveAskOrigin(input: NeoAskOrigin): NeoAskOrigin | null;
  append(input: NeoPublicationInput, consultationId?: string): Receipt;
  replay?(input: Draft, caller: OperationCaller): Receipt | null;
  notify(): void;
}

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
      (binding.kind === 'concern' && binding.concernId !== null)) &&
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

export function publicationLinkProblem(
  proof: Proof,
  { link, exists, concernId, origin }: LinkEvidence
): string | null {
  const ref = `${link.kind} link "${link.id}"`;
  if (!exists)
    return `${ref} does not exist; link only Neo concern, work or consultation ids, never work.find refs or session ids`;
  if (proof.binding.kind !== 'neo' && concernId !== proof.binding.concernId)
    return `${ref} belongs to another concern`;
  if (
    link.kind !== 'concern' &&
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
        consultation.concernId === proof.binding.concernId &&
        proof.input.messageId === `neo-consult:${consultation.id}:request`)) &&
    binding?.kind === proof.binding.kind &&
    binding.concernId === proof.binding.concernId &&
    binding.sessionId === proof.binding.sessionId &&
    isMainNeoBinding(root) &&
    root.sessionId === proof.root.sessionId
    ? { value: proof }
    : { reason: { accepted: false, reason: 'publication_superseded' } };
}

function readLinkEvidence(link: NeoPublicationLink, runtime: NeoPublicationRuntime): LinkEvidence {
  if (link.kind === 'concern')
    return { link, exists: runtime.hasConcern(link.id), concernId: link.id, origin: null };
  const item = link.kind === 'work' ? runtime.getWork(link.id) : runtime.getConsultation(link.id);
  const input = item?.originMessageId
    ? { sessionId: item.originSessionId, messageId: item.originMessageId }
    : link.kind === 'consultation' && item?.sessionId
      ? { sessionId: item.sessionId, messageId: `neo-consult:${item.id}:request` }
      : null;
  return {
    link,
    exists: !!item,
    concernId: item?.concernId ?? null,
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
      (draft: Draft, proof: Proof) => {
        const input = {
          ...draft,
          conversationId: proof.root.sessionId.slice(4),
          askOrigin: proof.ask,
          producerInput: proof.input,
        };
        return runtime.append(input, draft.interim ? undefined : proof.turn.consultationId);
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
    .end('publication') as (
    input: unknown,
    caller: OperationCaller
  ) => NeoPublicationAppendResult | Rejection;
}

export function createNeoPublicationOperation(publish: ReturnType<typeof createNeoPublisher>) {
  return defineOperation({
    name: 'neo.publication.publish',
    description:
      'Publish an explicitly authored short reply, full details and labelled Neo scene references from this live avatar input. Runtime supplies original human ask and producer attribution. Reuse publicationId only for identical retries; do not publish internal compaction or tool chatter. Set interim:true on a message sent before the answer while you are still working on it; the answer itself omits interim. Scene refs must exist and work/consultation links must belong to this ask. No model summarization or execution is performed.',
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
