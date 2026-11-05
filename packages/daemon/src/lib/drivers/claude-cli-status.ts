import superpipe, { type PipelineAPI } from 'superpipe';
import {
  probeLiveClaudeSessions,
  readClaudeInputEvidence,
  readClaudeTranscript,
  type ClaudeLiveSession,
  type ClaudeTranscriptState,
} from './claude-desktop-adapter.ts';
import { withClaudeIdentity } from './claude-runtime-identity.ts';
import { requireClaudeCliOwner } from './claude-session-owner.ts';
import type { Rejected, Result, WorkDelivery, WorkDetail, WorkRef, WorkStatus } from './types.ts';
import { reject } from './work-operations.ts';
import { withExchange } from './work-messages.ts';

interface ClaudeCliStatusDeps {
  machine: string;
  projectsDir: string;
  liveSessions(): Promise<readonly ClaudeLiveSession[]>;
  folder(sessionId: string): Promise<string | null>;
}

type LiveWork = { session: ClaudeLiveSession; status: WorkStatus };
type Source = {
  folder: string | null;
  transcript: ClaudeTranscriptState | null;
  evidence: WorkDetail['inputEvidence'] | null;
};

export function requireClaudeCliStatus(
  ref: WorkRef,
  live: readonly ClaudeLiveSession[]
): { value: LiveWork } | { reason: Rejected } {
  const owner = requireClaudeCliOwner(ref.id, live);
  if ('reason' in owner) return owner;
  const session = live.find((candidate) => candidate.sessionId === ref.id)!;
  const status =
    session.status === 'busy'
      ? 'running'
      : session.status === 'waiting'
        ? 'needs_you'
        : ['idle', 'done', 'completed'].includes(session.status)
          ? 'done'
          : null;
  return status
    ? { value: { session, status } }
    : { reason: reject('unreachable', `Unknown Claude CLI status: ${session.status}.`) };
}

async function readCliSource(
  ref: WorkRef,
  since: number | undefined,
  receipt: WorkDelivery['receipt'],
  deps: ClaudeCliStatusDeps
): Promise<Source> {
  const folder = await deps.folder(ref.id);
  const location = { cliSessionId: ref.id, ...(folder ? { cwd: folder } : {}) };
  const [transcript, evidence] = await Promise.all([
    readClaudeTranscript(location, deps, since),
    readClaudeInputEvidence(location, deps, receipt),
  ]);
  return { folder, transcript, evidence };
}

function describeCliWork(
  ref: WorkRef,
  live: LiveWork,
  source: Source,
  deps: ClaudeCliStatusDeps
): Result<WorkDetail> {
  const { transcript, evidence, folder } = source;
  return {
    ok: true,
    value: {
      ref,
      ...withClaudeIdentity(transcript),
      title: live.session.name || 'Claude Code session',
      place: { machine: deps.machine, name: 'Claude Code', ...(folder ? { folder } : {}) },
      status: live.status,
      lastActivityAt: transcript?.lastAt ?? 0,
      ...(transcript?.turnEnds?.length ? { turnEnds: transcript.turnEnds } : {}),
      ...(transcript?.reply ? { lastReply: transcript.reply } : {}),
      ...(transcript?.replyAt !== undefined ? { lastReplyAt: transcript.replyAt } : {}),
      ...(transcript
        ? { recentInputs: transcript.inputs, ...withExchange(transcript.exchange) }
        : {}),
      ...(transcript?.openedPrs ? { openedPrs: transcript.openedPrs } : {}),
      ...(evidence ? { inputEvidence: evidence } : {}),
    },
  };
}

export const readClaudeCliStatus = (superpipe({})('read-claude-cli-status') as PipelineAPI)
  .input(['ref', 'since', 'receipt', 'deps'])
  .pipe(probeLiveClaudeSessions, 'deps', 'result:outcome')
  .pipe(requireClaudeCliStatus, ['ref', 'outcome'], 'result:outcome')
  .pipe((live: LiveWork) => live, 'outcome', 'live')
  .pipe(readCliSource, ['ref', 'since', 'receipt', 'deps'], 'source')
  .pipe(describeCliWork, ['ref', 'live', 'source', 'deps'], 'outcome')
  .endAsync('outcome') as (
  ref: WorkRef,
  since: number | undefined,
  receipt: WorkDelivery['receipt'],
  deps: ClaudeCliStatusDeps
) => Promise<Result<WorkDetail>>;
