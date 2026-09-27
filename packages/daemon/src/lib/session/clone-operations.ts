import type { Session, Space, ThinkingLevel } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { JobQueueRepository } from '../../storage/repositories/job-queue-repository.ts';
import { renderAddress } from '../mailbox/address.ts';
import { handoffPromptToMailbox } from '../mailbox/handoff.ts';
import {
  defineOperation,
  type OperationCaller,
  type OperationCallerRole,
} from '../operations/registry.ts';
import { stripRejectedSessionConfig } from './create-session-config.ts';
import { admitSpaceStage } from './ensure-agent-session.ts';
import type { CreateSessionParams } from './session-lifecycle.ts';

const THINKING_LEVELS = ['off', 'think8k', 'think16k', 'think24k', 'think32k'] as const;

const SpawnInputSchema = z
  .object({
    parentSessionId: z.string().min(1).optional(),
    brief: z.string().min(1).max(4000).optional(),
    title: z.string().min(1).max(200).optional(),
    model: z.string().min(1).optional(),
    thinkingLevel: z.enum(THINKING_LEVELS).optional(),
  })
  .strict();

const SPAWN_REJECTIONS = [
  'caller_denied',
  'parent_required',
  'parent_not_found',
  'nested_clone',
  'parent_unavailable',
] as const;

type SpawnInput = z.infer<typeof SpawnInputSchema>;
type SpawnRejectionReason = (typeof SPAWN_REJECTIONS)[number];
type SpawnRejection = { accepted: false; reason: SpawnRejectionReason; message: string };
type SpawnResult = { accepted: true; sessionId: string } | SpawnRejection;

const SpawnResultSchema = z.union([
  z.object({ accepted: z.literal(true), sessionId: z.string() }).strict(),
  z
    .object({
      accepted: z.literal(false),
      reason: z.enum(SPAWN_REJECTIONS),
      message: z.string(),
    })
    .strict(),
]);

export interface SpawnSessionCloneDependencies {
  readonly getSession: (sessionId: string) => Session | null;
  readonly getSpace: (spaceId: string) => Promise<Space | null>;
  readonly resolveRole: (session: Session) => OperationCallerRole;
  readonly isGitRepo: (workspacePath: string) => Promise<boolean>;
  readonly createSession: (params: CreateSessionParams) => Promise<string>;
  readonly addSpaceSession: (spaceId: string, sessionId: string) => Promise<unknown>;
  readonly attachSpaceTools: (sessionId: string) => Promise<void>;
  readonly jobQueue: JobQueueRepository;
}

function reject(reason: SpawnRejectionReason, message: string): SpawnRejection {
  return { accepted: false, reason, message };
}

export function resolveParentId(
  input: SpawnInput,
  caller: OperationCaller
): { value: string } | { reason: SpawnRejection } {
  if (caller.source === 'rpc') {
    return input.parentSessionId
      ? { value: input.parentSessionId }
      : { reason: reject('parent_required', 'parentSessionId is required') };
  }
  if (!caller.sessionId) {
    return { reason: reject('caller_denied', 'The caller has no session to spawn from') };
  }
  if (input.parentSessionId && input.parentSessionId !== caller.sessionId) {
    return { reason: reject('caller_denied', 'A session may only spawn a clone of itself') };
  }
  return { value: caller.sessionId };
}

export function loadParent(
  parentId: string,
  deps: SpawnSessionCloneDependencies
): { value: Session } | { reason: SpawnRejection } {
  const parent = deps.getSession(parentId);
  if (!parent) return { reason: reject('parent_not_found', `Session not found: ${parentId}`) };
  if (parent.parentSessionId) {
    return { reason: reject('nested_clone', 'A clone cannot spawn its own clone') };
  }
  const context = parent.context;
  if (
    parent.status !== 'active' ||
    (parent.type ?? 'worker') !== 'worker' ||
    context?.taskId ||
    context?.roomId ||
    context?.lobbyId
  ) {
    return { reason: reject('parent_unavailable', `Session cannot be cloned: ${parentId}`) };
  }
  return { value: parent };
}

export async function admitSpaceParent(
  parent: Session,
  deps: SpawnSessionCloneDependencies
): Promise<{ value: Session } | { reason: SpawnRejection }> {
  const spaceId = parent.context?.spaceId;
  if (!spaceId) return { value: parent };
  if (deps.resolveRole(parent) !== 'long_term_agent') {
    return { reason: reject('parent_unavailable', 'Only a Space agent session can be cloned') };
  }
  const space = admitSpaceStage(await deps.getSpace(spaceId));
  if ('reason' in space) {
    return { reason: reject('parent_unavailable', `Space is not active: ${spaceId}`) };
  }
  return { value: parent };
}

export async function buildCloneParams(
  parent: Session,
  input: SpawnInput,
  deps: SpawnSessionCloneDependencies
): Promise<CreateSessionParams> {
  const workspacePath = parent.worktree?.mainRepoPath ?? parent.workspacePath;
  const isGit = workspacePath ? await deps.isGitRepo(workspacePath) : false;
  const config = stripRejectedSessionConfig(parent.config);
  const parentBranch = parent.worktree?.branch ?? parent.gitBranch ?? undefined;
  return {
    workspacePath,
    worktreeMode: isGit ? 'worktree' : 'direct',
    ...(isGit && parentBranch ? { worktreeBaseBranch: parentBranch } : {}),
    title: input.title ?? `${parent.title} · 分身`,
    spaceId: parent.context?.spaceId,
    parentSessionId: parent.id,
    promptProvenance: parent.metadata.promptProvenance,
    config: {
      ...config,
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel as ThinkingLevel } : {}),
    },
  };
}

export function buildBrief(parent: Session, brief: string): string {
  return [
    '## 分身 brief',
    `You are a shadow clone of session "${parent.title}" (id ${parent.id}): same configuration and workspace, not its conversation.`,
    '',
    brief,
    '',
    'When finished, invoke the operation session.clone.return with a concise summary of what you learned; it is delivered to your parent.',
  ].join('\n');
}

export async function createClone(
  parent: Session,
  params: CreateSessionParams,
  input: SpawnInput,
  deps: SpawnSessionCloneDependencies
): Promise<SpawnResult> {
  const sessionId = await deps.createSession(params);
  const spaceId = parent.context?.spaceId;
  if (spaceId) {
    await deps.addSpaceSession(spaceId, sessionId);
    await deps.attachSpaceTools(sessionId);
  }
  if (input.brief) {
    const outcome = await handoffPromptToMailbox({
      to: renderAddress({ kind: 'session', sessionId }),
      message: {
        type: 'user',
        message: { role: 'user', content: buildBrief(parent, input.brief) },
        parent_tool_use_id: null,
        inputKind: 'system',
      },
      origin: renderAddress({ kind: 'session', sessionId: parent.id }),
      messageUuid: `clone-brief:${sessionId}`,
      jobQueue: deps.jobQueue,
    });
    if (outcome.kind === 'rejected') {
      throw new Error(`session.clone.spawn: brief handoff rejected: ${outcome.reason}`);
    }
  }
  return { accepted: true, sessionId };
}

const SPAWN_DESCRIPTION =
  'Spawn a 分身 (clone) of a session: a new session with the same configuration and workspace (its own git worktree when the workspace is a repository) but none of the conversation, optionally with a different model or thinking level. A brief, when given, becomes the first message and asks the clone to report back through session.clone.return. An agent or session calling through invoke clones itself; the RPC door names parentSessionId. A clone of a Space agent session acts as that agent. Rejects nested_clone (clones cannot clone), parent_unavailable (inactive session, task or workflow worker, or a paused, stopped or archived Space), parent_not_found and caller_denied.';

export function createSpawnSessionCloneOperation(deps: SpawnSessionCloneDependencies) {
  const spawn = (superpipe({ deps })('spawn-session-clone') as PipelineAPI)
    .input(['input', 'caller'])
    .pipe(resolveParentId, ['input', 'caller'], 'result:outcome')
    .pipe(loadParent, ['outcome', 'deps'], 'result:outcome')
    .pipe(admitSpaceParent, ['outcome', 'deps'], 'result:outcome')
    .pipe(buildCloneParams, ['outcome', 'input', 'deps'], 'params')
    .pipe(createClone, ['outcome', 'params', 'input', 'deps'], 'outcome')
    .endAsync('outcome') as (input: SpawnInput, caller: OperationCaller) => Promise<SpawnResult>;
  return defineOperation({
    name: 'session.clone.spawn',
    description: SPAWN_DESCRIPTION,
    inputSchema: SpawnInputSchema,
    resultSchema: SpawnResultSchema,
    execute: (input, caller) => spawn(input, caller),
  });
}
