import { withWorkerProvenance } from './worker-provenance.ts';
import { CLAUDE_DESKTOP_WAKE_BRIEF, CLAUDE_RC_TOGGLE_REQUEST, fillPrompt } from '@hyperneo/prompts';
import superpipe, { type PipelineAPI } from 'superpipe';
import { Logger } from '../logger.ts';
import {
  type ClaudeDesktopAdapterDeps,
  type ClaudeDesktopRecord,
  type ClaudeLiveSession,
  type ClaudeRecordCache,
  claudeRemoteLink,
  importClaudeDesktopSession,
  loadClaudeDesktopRecords,
  probeLiveClaudeSessions,
  runToExit,
  requireClaudeRecord,
  requireOpenClaudeRecord,
  sendClaudeMessage,
  waitUntilLive,
  withRemoteControl,
} from './claude-desktop-adapter.ts';
import type { Result, WorkAdapter, WorkCallContext, WorkDelivery } from './types.ts';
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

function readyHelper(record: RcToggle['record'], liveSessions: readonly ClaudeLiveSession[]) {
  const live = liveSessions.find((candidate) => candidate.sessionId === record.cliSessionId);
  if (live?.owner !== 'desktop')
    return {
      reason: reject('unsupported', `${record.title} has no confirmed native Desktop owner.`),
    };
  return live.status === 'waiting'
    ? {
        reason: reject(
          'not_delivered',
          `${record.title} is waiting for ${live.waitingFor ?? 'a native permission prompt'}. Nothing was approved.`
        ),
      }
    : { value: { record, liveSessions } };
}

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
  liveSessions: readonly ClaudeLiveSession[],
  title = RC_TOGGLE_TITLE
): RcToggle | null {
  const live = new Set(liveSessions.map((session) => session.sessionId));
  const candidates = records
    .filter((record) => record.title === title && !record.isArchived && record.cliSessionId)
    .map((record) => ({
      record: record as RcToggle['record'],
      live: live.has(record.cliSessionId as string),
    }))
    .sort(
      (a, b) => Number(b.live) - Number(a.live) || b.record.lastActivityAt - a.record.lastActivityAt
    );
  return candidates[0] ?? null;
}

async function createWakeHelper(deps: ClaudeDesktopAdapterDeps): Promise<Gate<RcToggle['record']>> {
  const cliSessionId = deps.newId();
  const opened = await runToExit(
    deps,
    [
      'claude',
      '-p',
      '--session-id',
      cliSessionId,
      '-n',
      'desktop-wake',
      '--permission-mode',
      deps.permissionMode?.() ?? 'auto',
      '--model',
      'haiku',
      '--max-turns',
      '1',
      '--tools',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--',
      CLAUDE_DESKTOP_WAKE_BRIEF,
    ],
    deps.homeDir
  ).catch((error: unknown) => ({ code: -1, stdout: '', stderr: String(error) }));
  if (opened.code !== 0) {
    return { reason: reject('not_delivered', `Could not create desktop-wake: ${opened.stderr}`) };
  }
  return {
    value: {
      sessionId: `local_${cliSessionId}`,
      cliSessionId,
      cwd: deps.homeDir,
      title: 'desktop-wake',
      isArchived: false,
      lastActivityAt: deps.now(),
    },
  };
}

type OpenHelper = Gate<{ record: RcToggle['record']; liveSessions: readonly ClaudeLiveSession[] }>;
const openingWakeHelpers = new WeakMap<ClaudeDesktopAdapterDeps, Promise<OpenHelper>>();

export async function openRcToggle(
  records: readonly ClaudeDesktopRecord[],
  liveSessions: readonly ClaudeLiveSession[],
  deps: ClaudeDesktopAdapterDeps,
  title = RC_TOGGLE_TITLE
): Promise<OpenHelper> {
  if (title !== 'desktop-wake') return openHelper(records, liveSessions, deps, title);
  const pending = openingWakeHelpers.get(deps);
  if (pending) return pending;
  const opening = (async () => {
    const current = await loadClaudeDesktopRecords(deps, new Map());
    const live = await probeLiveClaudeSessions(deps);
    if ('reason' in live) return live;
    return openHelper(current, live.value, deps, title);
  })();
  openingWakeHelpers.set(deps, opening);
  try {
    return await opening;
  } finally {
    openingWakeHelpers.delete(deps);
  }
}

async function openHelper(
  records: readonly ClaudeDesktopRecord[],
  liveSessions: readonly ClaudeLiveSession[],
  deps: ClaudeDesktopAdapterDeps,
  title = RC_TOGGLE_TITLE
): Promise<Gate<{ record: RcToggle['record']; liveSessions: readonly ClaudeLiveSession[] }>> {
  const found = findRcToggle(records, liveSessions, title);
  if (found?.live) return readyHelper(found.record, liveSessions);
  if (!found && title === RC_TOGGLE_TITLE)
    return {
      reason: reject(
        'not_delivered',
        'The existing authorized rc-toggle helper is unavailable; native approval may be required. No replacement was created.'
      ),
    };
  const created = found ? { value: found.record } : await createWakeHelper(deps);
  if ('reason' in created) return created;
  const record = created.value;
  try {
    const imported = await importClaudeDesktopSession(
      record.cliSessionId,
      record.cwd ?? record.originCwd ?? deps.homeDir,
      deps
    );
    if (!imported.ok) return { reason: imported };
    Object.assign(record, imported.value);
  } catch (error) {
    return {
      reason: reject('not_delivered', error instanceof Error ? error.message : String(error)),
    };
  }
  const live = await waitUntilLive(record.cliSessionId, deps);
  if (!live) {
    return {
      reason: reject(
        'not_delivered',
        `Claude Code Desktop did not open ${title}.` +
          (title === 'desktop-wake'
            ? ' Desktop may be at its process cap. The helper was retained for reuse; no replacement was created.'
            : '')
      ),
    };
  }
  return readyHelper(record, live);
}

export const runClaudeDesktopWake = (superpipe({})('claude-desktop-native-wake') as PipelineAPI)
  .input(['target', 'message', 'deps', 'context'])
  .pipe(
    (target: RemoteControlTarget) => ({ adapter: 'claude-desktop', id: target.sessionId }),
    'target',
    'ref'
  )
  .pipe(
    (deps: ClaudeDesktopAdapterDeps) => loadClaudeDesktopRecords(deps, new Map()),
    'deps',
    'records'
  )
  .pipe(requireClaudeRecord, ['ref', 'records'], 'result:outcome')
  .pipe(requireOpenClaudeRecord, 'outcome', 'result:outcome')
  .pipe((record: RcToggle['record']) => record, 'outcome', 'record')
  .pipe(probeLiveClaudeSessions, 'deps', 'result:outcome')
  .pipe((live: readonly ClaudeLiveSession[]) => live, 'outcome', 'liveSessions')
  .pipe(sendClaudeMessage, ['record', 'liveSessions', 'message', 'deps', 'context'], 'outcome')
  .pipe(withRemoteControl, ['outcome', 'record', 'deps'], 'outcome')
  .endAsync('outcome') as (
  target: RemoteControlTarget,
  message: string,
  deps: ClaudeDesktopAdapterDeps,
  context?: WorkCallContext
) => Promise<Result<WorkDelivery>>;

export function sendRcToggleRequest(
  rcToggle: { record: RcToggle['record']; liveSessions: readonly ClaudeLiveSession[] },
  target: RemoteControlTarget,
  deps: ClaudeDesktopAdapterDeps,
  context?: WorkCallContext
): Promise<Result<{ delivered: boolean }>> {
  const message = fillPrompt(CLAUDE_RC_TOGGLE_REQUEST, {
    sessionId: target.sessionId,
    title: target.title,
  });
  return sendClaudeMessage(rcToggle.record, rcToggle.liveSessions, message, deps, context);
}

export const runClaudeRemoteControlRequest = (
  superpipe({})('claude-remote-control-request') as PipelineAPI
)
  .input(['target', 'deps', 'cache', 'context'])
  .pipe(loadClaudeDesktopRecords, ['deps', 'cache'], 'records')
  .pipe(requireDisconnectedTarget, ['target', 'records'], 'result:outcome')
  .pipe(probeLiveClaudeSessions, 'deps', 'result:outcome')
  .pipe((live: readonly ClaudeLiveSession[]) => live, 'outcome', 'liveSessions')
  .pipe(openRcToggle, ['records', 'liveSessions', 'deps'], 'result:outcome')
  .pipe(sendRcToggleRequest, ['outcome', 'target', 'deps', 'context'], 'outcome')
  .endAsync('outcome') as (
  target: RemoteControlTarget,
  deps: ClaudeDesktopAdapterDeps,
  cache: ClaudeRecordCache,
  context?: WorkCallContext
) => Promise<Result<{ delivered: boolean }>>;

export function withClaudeRemoteControl(
  adapter: WorkAdapter,
  deps: ClaudeDesktopAdapterDeps,
  request: typeof runClaudeRemoteControlRequest = runClaudeRemoteControlRequest,
  wake: typeof runClaudeDesktopWake = runClaudeDesktopWake
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
        const message = startRequest.provenance
          ? withWorkerProvenance(startRequest.message, {
              model: started.value.model ?? null,
              effort: started.value.effort ?? null,
              harness: adapter.id,
            })
          : startRequest.message;
        const delivery = await wake(target, message, deps, context);
        if (!delivery.ok)
          return {
            ...delivery,
            detail: `${delivery.detail} Retained imported session ${JSON.stringify(started.value.ref)}. Open ${started.value.link ?? started.value.ref.id} and inspect work.status before sending again; native delivery may still arrive.`,
          };
        const status = await adapter.status?.(started.value.ref);
        if (status?.ok) {
          const {
            status: state,
            waitingFor,
            permissionMode,
            lastActivityAt,
            watchHint,
          } = status.value;
          Object.assign(started.value, {
            status: state,
            waitingFor,
            permissionMode,
            lastActivityAt,
            watchHint,
          });
        }
        started.value.receipt = delivery.value.receipt;
        started.value.watchHint =
          `${started.value.watchHint ?? ''} Remote Control is requested separately through the existing rc-toggle; native approval may be required. A request is not a confirmed connection.`.trim();
        queue = queue
          .then(() => request(target, deps, new Map(), context))
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
    send: (ref, message, context) =>
      wake({ sessionId: ref.id, title: ref.id }, message, deps, context),
    steer: (ref, message, context) =>
      wake({ sessionId: ref.id, title: ref.id }, message, deps, context),
  };
}
