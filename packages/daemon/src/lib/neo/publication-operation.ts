import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
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
import {
  NEO_HUMAN_TRIGGER_PREFIX,
  neoHumanTrigger,
  requirePublicationTrigger,
} from './notification-triggers.ts';
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
type Proof = Producer & { ask: NeoAskOrigin; answer?: NeoAskOrigin };
type Triggered = Proof & { triggerId?: string };
type LinkEvidence = {
  link: NeoPublicationLink;
  exists: boolean;
};

interface NeoPublicationRuntime {
  getBinding(id: string): NeoBinding | null;
  getRootBinding(): NeoBinding | null;
  hasProject(id: string): boolean;
  resolveAskOrigin(input: NeoAskOrigin): NeoAskOrigin | null;
  resolveHumanAskOrigin(input: NeoAskOrigin): NeoAskOrigin | null;
  append(input: NeoPublicationInput): Receipt;
  inputTrigger(input: NeoAskOrigin): string | null;
  isDeliveredHumanInput(input: NeoAskOrigin): boolean;
  notify(): void;
}

export function admitPublicationDraft(input: unknown): { value: Draft } | { reason: Rejection } {
  const parsed = Draft.safeParse(input);
  return parsed.success
    ? { value: parsed.data }
    : { reason: { accepted: false, reason: 'invalid_publication' } };
}

const TOPIC_LABEL =
  /^(?:#{1,6}\s+(.+?)\s*#*|\*\*([^*\n]+?)\*\*\s*(?:[:：].*)?|\*\*([^*\n]+?[:：])\*\*.*)\s*$/;

function publicationTopics(fullText: string): string[] {
  const labels: string[] = [];
  let fenced = false;
  for (const line of fullText.split('\n')) {
    if (line.trimStart().startsWith('```')) fenced = !fenced;
    const match = fenced ? null : TOPIC_LABEL.exec(line);
    const label = (match?.[1] ?? match?.[2] ?? match?.[3])?.replace(/[:：]\s*$/, '').trim();
    if (label && !labels.includes(label)) labels.push(label);
  }
  return labels;
}

export function requireShortTextCoversTopics(
  draft: Draft
): { value: Draft } | { reason: Rejection } {
  const topics = publicationTopics(draft.fullText);
  const short = draft.shortText.toLocaleLowerCase();
  const missing = topics.filter((topic) => !short.includes(topic.toLocaleLowerCase()));
  return topics.length < 2 || !missing.length
    ? { value: draft }
    : {
        reason: {
          accepted: false,
          reason: 'multiple_topics',
          detail: `fullText has ${topics.length} topic labels (${topics.join('; ')}) but shortText does not name ${missing.join('; ')}. publish each topic separately, each with its own shortText; or, if they are sections of one topic, name every label in shortText.`,
        },
      };
}

function publicationIdFor(input: NeoAskOrigin, requestId: string): string {
  return neoDerivedId(
    JSON.stringify(['neo.publication.publish', input.sessionId, input.messageId, requestId])
  );
}

function readAnswer(
  draft: Draft,
  proof: Proof,
  runtime: NeoPublicationRuntime
): NeoAskOrigin | null {
  const triggerId = draft.triggerId;
  if (
    !triggerId?.startsWith(NEO_HUMAN_TRIGGER_PREFIX) ||
    !isMainNeoBinding(proof.binding) ||
    proof.binding.sessionId !== proof.root.sessionId ||
    runtime.inputTrigger(proof.input) === triggerId
  )
    return null;
  const answer = {
    sessionId: proof.root.sessionId,
    messageId: triggerId.slice(NEO_HUMAN_TRIGGER_PREFIX.length),
  };
  return proof.turn.hasInput?.(answer.messageId) && runtime.isDeliveredHumanInput(answer)
    ? answer
    : null;
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
    isMainNeoBinding(binding) &&
    binding.sessionId === root.sessionId &&
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

function publicationLinkProblem({ link, exists }: LinkEvidence): string | null {
  if (link.kind !== 'project')
    return `${link.kind} links are no longer supported; link only Neo project ids`;
  return exists
    ? null
    : `project link "${link.id}" does not exist; link only Neo project ids, never work.find refs or session ids`;
}

export function requirePublicationLinks(
  proof: Proof,
  evidence: readonly LinkEvidence[]
): { value: Proof } | { reason: Rejection } {
  const problem = evidence.map(publicationLinkProblem).find(Boolean);
  return problem
    ? { reason: { accepted: false, reason: 'invalid_scene_reference', detail: problem } }
    : { value: proof };
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
  return { link, exists: link.kind === 'project' && runtime.hasProject(link.id) };
}

export function createNeoPublisher(runtime: NeoPublicationRuntime) {
  return (superpipe({})('neo-publication-publish') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(admitPublicationDraft, 'input', 'result:publication')
    .pipe(requireShortTextCoversTopics, 'publication', 'result:publication')
    .pipe((draft: Draft) => draft, 'publication', 'draft')
    .pipe(
      (caller: OperationCaller) => runtime.getBinding(caller.sessionId ?? ''),
      'caller',
      'binding'
    )
    .pipe(() => runtime.getRootBinding(), 'caller', 'root')
    .pipe(requirePublicationProducer, ['caller', 'binding', 'root'], 'result:publication')
    .pipe(
      (producer: Producer): Proof => ({
        ...producer,
        ask: runtime.resolveAskOrigin(producer.input) ?? producer.input,
      }),
      'publication',
      'publication'
    )
    .pipe(
      (draft: Draft, proof: Proof) => readAnswer(draft, proof, runtime),
      ['draft', 'publication'],
      'answer'
    )
    .pipe(
      (proof: Proof, answer: NeoAskOrigin | null): Proof =>
        answer ? { ...proof, ask: runtime.resolveAskOrigin(answer) ?? answer, answer } : proof,
      ['publication', 'answer'],
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
    .pipe(
      (proof: Proof) =>
        proof.answer ? neoHumanTrigger(proof.answer.messageId) : runtime.inputTrigger(proof.input),
      'publication',
      'trigger'
    )
    .pipe(requirePublicationTrigger, ['publication', 'draft', 'trigger'], 'result:publication')
    .pipe(
      (draft: Draft, proof: Triggered) => {
        const { requestId, ...message } = draft;
        return runtime.append({
          ...message,
          publicationId: publicationIdFor(proof.answer ?? proof.input, requestId),
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
          receipt.accepted ? runtime.resolveHumanAskOrigin(receipt.publication.askOrigin) : null
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
      'Deliver a message in this conversation. Use a new requestId per message and reuse it only when retrying that send. To answer a human input, copy its triggerId from the daemon human-input envelope, including messages arriving mid-turn. Choose the input this message answers; one publication does not answer every delivered input. The runtime validates this turn and derives publication identity, original request and producer. Scene references must exist and belong to the request. The answered field identifies the human message answered by this delivery and its publication/revision; null means no human message was resolved. It does not complete background work or require another post.',
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    inputSchema: Draft,
    resultSchema: NeoPublicationResultSchema,
    execute: async (input, caller) => publish(input, caller),
  });
}
