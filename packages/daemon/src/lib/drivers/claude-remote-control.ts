import { CLAUDE_RC_TOGGLE_BRIEF, CLAUDE_RC_TOGGLE_REQUEST, fillPrompt } from '@hyperneo/prompts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { Logger } from '../logger.ts';
import {
  type ClaudeDesktopAdapterDeps,
  type ClaudeDesktopRecord,
  type ClaudeLiveSession,
  type ClaudeRecordCache,
  claudeRemoteLink,
  launchInClaudeDesktop,
  loadClaudeDesktopRecords,
  probeLiveClaudeSessions,
  runToExit,
  sendClaudeMessage,
  waitUntilLive,
} from './claude-desktop-adapter.ts';
import type { Result, WorkAdapter } from './types.ts';
import { reject } from './work-operations.ts';

export const RC_TOGGLE_TITLE = 'rc-toggle';

export interface RemoteControlTarget {
  sessionId: string;
  title: string;
}

const log = new Logger('claude-remote-control');

type RemoteControlOutcome = Result<{ delivered: boolean }>;
type Gate<Value> = { value: Value } | { reason: RemoteControlOutcome };
const alreadySet: { reason: RemoteControlOutcome } = {
  reason: { ok: true, value: { delivered: false } },
};
type RcToggle = { record: ClaudeDesktopRecord & { cliSessionId: string }; live: boolean };

export function requireDisconnectedTarget(
  target: RemoteControlTarget,
  records: readonly ClaudeDesktopRecord[]
): Gate<RemoteControlTarget> {
  if (target.title === RC_TOGGLE_TITLE) return alreadySet;
  const record = records.find((candidate) => candidate.sessionId === target.sessionId);
  if (record && (record.remoteControlUserEnabled === false || claudeRemoteLink(record)))
    return alreadySet;
  return { value: target };
}

export function findRcToggle(
  records: readonly ClaudeDesktopRecord[],
  liveSessions: readonly ClaudeLiveSession[]
): RcToggle | null {
  const live = new Set(liveSessions.map((session) => session.sessionId));
  const candidates = records
    .filter(
      (record) => record.title === RC_TOGGLE_TITLE && !record.isArchived && record.cliSessionId
    )
    .map((record) => ({
      record: record as RcToggle['record'],
      live: live.has(record.cliSessionId as string),
    }))
    .sort(
      (a, b) => Number(b.live) - Number(a.live) || b.record.lastActivityAt - a.record.lastActivityAt
    );
  return candidates[0] ?? null;
}

async function createRcToggle(deps: ClaudeDesktopAdapterDeps): Promise<Gate<RcToggle['record']>> {
  const cliSessionId = deps.newId();
  const opened = await runToExit(
    deps,
    [
      'claude',
      '-p',
      '--session-id',
      cliSessionId,
      '-n',
      RC_TOGGLE_TITLE,
      '--model',
      'haiku',
      '--',
      CLAUDE_RC_TOGGLE_BRIEF,
    ],
    deps.homeDir
  ).catch((error: unknown) => ({ code: -1, stdout: '', stderr: String(error) }));
  if (opened.code !== 0) {
    return { reason: reject('not_delivered', `Could not create rc-toggle: ${opened.stderr}`) };
  }
  return {
    value: {
      sessionId: `local_${cliSessionId}`,
      cliSessionId,
      cwd: deps.homeDir,
      title: RC_TOGGLE_TITLE,
      isArchived: false,
      lastActivityAt: deps.now(),
    },
  };
}

export async function openRcToggle(
  records: readonly ClaudeDesktopRecord[],
  liveSessions: readonly ClaudeLiveSession[],
  deps: ClaudeDesktopAdapterDeps
): Promise<Gate<{ record: RcToggle['record']; liveSessions: readonly ClaudeLiveSession[] }>> {
  const found = findRcToggle(records, liveSessions);
  if (found?.live) return { value: { record: found.record, liveSessions } };
  const created = found ? { value: found.record } : await createRcToggle(deps);
  if ('reason' in created) return created;
  const record = created.value;
  try {
    launchInClaudeDesktop(
      record.cliSessionId,
      record.cwd ?? record.originCwd ?? deps.homeDir,
      deps
    );
  } catch (error) {
    return {
      reason: reject('not_delivered', error instanceof Error ? error.message : String(error)),
    };
  }
  const live = await waitUntilLive(record.cliSessionId, deps);
  if (!live) {
    return { reason: reject('not_delivered', 'Claude Code Desktop did not open rc-toggle.') };
  }
  return { value: { record, liveSessions: live } };
}

export function sendRcToggleRequest(
  rcToggle: { record: RcToggle['record']; liveSessions: readonly ClaudeLiveSession[] },
  target: RemoteControlTarget,
  deps: ClaudeDesktopAdapterDeps
): Promise<Result<{ delivered: boolean }>> {
  const message = fillPrompt(CLAUDE_RC_TOGGLE_REQUEST, {
    sessionId: target.sessionId,
    title: target.title,
  });
  return sendClaudeMessage(rcToggle.record, rcToggle.liveSessions, message, deps);
}

export const runClaudeRemoteControlRequest = (
  superpipe({})('claude-remote-control-request') as PipelineAPI
)
  .input(['target', 'deps', 'cache'])
  .pipe(loadClaudeDesktopRecords, ['deps', 'cache'], 'records')
  .pipe(requireDisconnectedTarget, ['target', 'records'], 'result:outcome')
  .pipe(probeLiveClaudeSessions, 'deps', 'result:outcome')
  .pipe((live: readonly ClaudeLiveSession[]) => live, 'outcome', 'liveSessions')
  .pipe(openRcToggle, ['records', 'liveSessions', 'deps'], 'result:outcome')
  .pipe(sendRcToggleRequest, ['outcome', 'target', 'deps'], 'outcome')
  .endAsync('outcome') as (
  target: RemoteControlTarget,
  deps: ClaudeDesktopAdapterDeps,
  cache: ClaudeRecordCache
) => Promise<Result<{ delivered: boolean }>>;

export function withClaudeRemoteControl(
  adapter: WorkAdapter,
  deps: ClaudeDesktopAdapterDeps,
  request: typeof runClaudeRemoteControlRequest = runClaudeRemoteControlRequest
): WorkAdapter {
  const start = adapter.start;
  if (!start) return adapter;
  let queue: Promise<unknown> = Promise.resolve();
  return {
    ...adapter,
    start: async (startRequest, context) => {
      const started = await start(startRequest, context);
      if (started.ok) {
        const target = { sessionId: started.value.ref.id, title: started.value.title };
        queue = queue
          .then(() => request(target, deps, new Map()))
          .then(
            (outcome) => {
              if (!outcome.ok)
                log.warn(
                  `Remote Control for ${target.sessionId} was not set: ${outcome.reason}: ${outcome.detail}`
                );
            },
            (error: unknown) =>
              log.warn(
                `Remote Control for ${target.sessionId} threw: ${error instanceof Error ? error.message : String(error)}`
              )
          );
      }
      return started;
    },
  };
}
