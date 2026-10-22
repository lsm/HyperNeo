import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import type {
  NeoPublicationAppendResult,
  NeoPublicationInput,
  NeoPublicationLink,
} from '@hyperneo/shared/types/neo-publication';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import { defineOperation, type OperationCaller } from '../operations/registry.ts';
import type { ArtifactRefReader } from '../artifacts/read-operations.ts';
import { unregisteredArtifact } from '../artifacts/file-contracts.ts';
import type { ArtifactRef } from '@hyperneo/shared/types/artifact-file';
import { NeoPublicationSchema, NeoPublicationResultSchema } from './publication.ts';
import { isMainNeoBinding } from './binding-roles.ts';
import { neoDerivedId } from './derived-id.ts';

const Draft = NeoPublicationSchema.omit({
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
}).extend({ requestId: z.string().min(1).max(160) });
type Draft = z.infer<typeof Draft>;
type Rejection = { accepted: false; reason: string; detail?: string };
type Receipt = NeoPublicationAppendResult | Rejection;
type Producer = {
  binding: NeoBinding;
  root: NeoBinding;
};
type Proof = Producer;
type LinkEvidence = {
  link: NeoPublicationLink;
  exists: boolean;
};

interface NeoPublicationRuntime {
  receivedHumanInput(sessionId: string, messageId: string): boolean;
  getBinding(id: string): NeoBinding | null;
  getRootBinding(): NeoBinding | null;
  hasProject(id: string): boolean;
  append(input: NeoPublicationInput): Receipt;
  notify(): void;
  artifact: ArtifactRefReader;
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

export function requirePublicationArtifacts(
  proof: Proof,
  draft: Draft,
  registered: readonly (ArtifactRef | null)[]
): { value: Proof } | { reason: Rejection } {
  const unknown = unregisteredArtifact(draft.artifacts ?? [], registered);
  return unknown
    ? {
        reason: {
          accepted: false,
          reason: 'invalid_artifact_reference',
          detail: `artifact "${unknown.artifactId}" is not one you can publish as given; pass the reference artifact.file.register or artifact.file.get returned`,
        },
      }
    : { value: proof };
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
      (proof: Proof, draft: Draft) =>
        (draft.replyTo ?? []).every((id) => runtime.receivedHumanInput(proof.binding.sessionId, id))
          ? { value: proof }
          : { reason: { accepted: false, reason: 'invalid_reply_to' } },
      ['publication', 'draft'],
      'result:publication'
    )
    .pipe(
      (draft: Draft) => draft.links.map((link) => readLinkEvidence(link, runtime)),
      'draft',
      'links'
    )
    .pipe(requirePublicationLinks, ['publication', 'links'], 'result:publication')
    .pipe(
      (draft: Draft, caller: OperationCaller) =>
        (draft.artifacts ?? []).map((ref) => runtime.artifact(ref.artifactId, caller)),
      ['draft', 'caller'],
      'registered'
    )
    .pipe(requirePublicationArtifacts, ['publication', 'draft', 'registered'], 'result:publication')
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
    .end('publication') as (input: unknown, caller: OperationCaller) => Receipt;
}

export function createNeoPublicationOperation(publish: ReturnType<typeof createNeoPublisher>) {
  return defineOperation({
    name: 'neo.publication.publish',
    description:
      'Deliver a message in this conversation. Use a new requestId per message and reuse it only when retrying that send. Optional replyTo lists the received human message ids this publication answers; omit it to leave inputs unanswered. Unknown, foreign, queued and non-human ids are refused. Project links must exist. For a document or evidence file, pass the reference artifact.file.register returned in artifacts and say in one sentence what it is.',
    policy: { safetyClass: 'mutate', roles: ['neo'] },
    inputSchema: Draft,
    resultSchema: NeoPublicationResultSchema,
    execute: async (input, caller) => publish(input, caller),
  });
}
