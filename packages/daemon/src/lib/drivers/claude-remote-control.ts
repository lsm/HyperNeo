import { withWorkerProvenance } from './worker-provenance.ts';
import {
  CLAUDE_DESKTOP_HELPER_ARCHIVE_REQUEST,
  CLAUDE_DESKTOP_HELPER_BRIEF,
  CLAUDE_DESKTOP_WAKE_BRIEF,
  CLAUDE_RC_TOGGLE_REQUEST,
  fillPrompt,
} from '@hyperneo/prompts';
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

export const RC_TOGGLE_TITLE = 'neo-helper';
const HELPER_ARCHIVE_RESEND_MS = 10 * 60_000;
const HELPER_OPEN_RETRY_MS = 10 * 60_000;

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

async function createHelper(
  deps: ClaudeDesktopAdapterDeps,
  title: string
): Promise<Gate<RcToggle['record']>> {
  const cliSessionId = deps.newId();
  const opened = await runToExit(
    deps,
    [
      'claude',
      '-p',
      '--session-id',
      cliSessionId,
      '-n',
      title,
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
      title === 'desktop-wake' ? CLAUDE_DESKTOP_WAKE_BRIEF : CLAUDE_DESKTOP_HELPER_BRIEF,
    ],
    deps.homeDir
  ).catch((error: unknown) => ({ code: -1, stdout: '', stderr: String(error) }));
  if (opened.code !== 0) {
    return { reason: reject('not_delivered', `Could not create ${title}: ${opened.stderr}`) };
  }
  return {
    value: {
      sessionId: `local_${cliSessionId}`,
      cliSessionId,
      cwd: deps.homeDir,
      title,
      isArchived: false,
      lastActivityAt: deps.now(),
    },
  };
}

type OpenHelper = Gate<{ record: RcToggle['record']; liveSessions: readonly ClaudeLiveSession[] }>;
const openingHelpers = new WeakMap<ClaudeDesktopAdapterDeps, Map<string, Promise<OpenHelper>>>();
const createdHelpers = new WeakMap<ClaudeDesktopAdapterDeps, Map<string, RcToggle['record']>>();
const failedOpens = new WeakMap<ClaudeDesktopAdapterDeps, Map<string, number>>();

export async function openRcToggle(
  records: readonly ClaudeDesktopRecord[],
  liveSessions: readonly ClaudeLiveSession[],
  deps: ClaudeDesktopAdapterDeps,
  title = RC_TOGGLE_TITLE
): Promise<OpenHelper> {
  if (findRcToggle(records, liveSessions, title)?.live)
    return openHelper(records, liveSessions, deps, title);
  const opening = openingHelpers.get(deps) ?? new Map<string, Promise<OpenHelper>>();
  openingHelpers.set(deps, opening);
  const pending = opening.get(title);
  if (pending) return pending;
  const failures = failedOpens.get(deps) ?? new Map<string, number>();
  failedOpens.set(deps, failures);
  const failedAt = failures.get(title);
  if (failedAt !== undefined && deps.now() - failedAt < HELPER_OPEN_RETRY_MS)
    return {
      reason: reject(
        'not_delivered',
        `Claude Code Desktop could not open ${title} recently; HyperNeo tries again after ten minutes.`
      ),
    };
  const preparing = (async () => {
    const current = await loadClaudeDesktopRecords(deps, new Map());
    const live = await probeLiveClaudeSessions(deps);
    if ('reason' in live) return live;
    return openHelper(current, live.value, deps, title);
  })();
  opening.set(title, preparing);
  try {
    const opened = await preparing;
    if ('reason' in opened) failures.set(title, deps.now());
    else failures.delete(title);
    return opened;
  } finally {
    opening.delete(title);
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
  const created = createdHelpers.get(deps) ?? new Map<string, RcToggle['record']>();
  createdHelpers.set(deps, created);
  const kept = created.get(title);
  const made = found
    ? { value: found.record }
    : kept
      ? { value: kept }
      : await createHelper(deps, title);
  if ('reason' in made) return made;
  const record = made.value;
  created.set(title, record);
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
        `Claude Code Desktop did not open ${title}. Desktop may be at its process cap. The helper was retained for reuse; no replacement was created.`
      ),
    };
  }
  created.delete(title);
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

const archiveRequests = new WeakMap<ClaudeDesktopAdapterDeps, Map<string, number>>();

export function admitArchiveRequest(
  target: RemoteControlTarget,
  deps: ClaudeDesktopAdapterDeps
): Gate<RemoteControlTarget> {
  if (target.title === RC_TOGGLE_TITLE)
    return { reason: reject('unsupported', `${RC_TOGGLE_TITLE} never archives itself.`) };
  const at = archiveRequests.get(deps)?.get(target.sessionId);
  return at !== undefined && deps.now() - at < HELPER_ARCHIVE_RESEND_MS
    ? {
        reason: reject(
          'not_delivered',
          `${RC_TOGGLE_TITLE} was asked to archive ${target.title}; waiting for Claude Desktop to archive it.`
        ),
      }
    : { value: target };
}

export function sendHelperArchiveRequest(
  helper: { record: RcToggle['record']; liveSessions: readonly ClaudeLiveSession[] },
  target: RemoteControlTarget,
  deps: ClaudeDesktopAdapterDeps
): Promise<Result<WorkDelivery>> {
  const message = fillPrompt(CLAUDE_DESKTOP_HELPER_ARCHIVE_REQUEST, {
    sessionId: target.sessionId,
    title: target.title,
  });
  return sendClaudeMessage(helper.record, helper.liveSessions, message, deps);
}

export async function awaitAppArchive(
  sent: Result<WorkDelivery>,
  target: RemoteControlTarget,
  deps: ClaudeDesktopAdapterDeps
): Promise<Result<{ archived: true }>> {
  if (!sent.ok) return sent;
  const requests = archiveRequests.get(deps) ?? new Map<string, number>();
  archiveRequests.set(deps, requests.set(target.sessionId, deps.now()));
  const records = await loadClaudeDesktopRecords(deps, new Map());
  if (
    records.some(
      (record) =>
        record.sessionId === target.sessionId && record.isArchived && record.archiveSetAtMs
    )
  )
    return { ok: true, value: { archived: true } };
  return reject(
    'not_delivered',
    `${RC_TOGGLE_TITLE} was asked to archive ${target.title}; the next release confirms it once Claude Desktop archives it.`
  );
}

export const runClaudeHelperArchive = (
  superpipe({})('claude-desktop-helper-archive') as PipelineAPI
)
  .input(['target', 'deps'])
  .pipe(admitArchiveRequest, ['target', 'deps'], 'result:outcome')
  .pipe(
    (deps: ClaudeDesktopAdapterDeps) => loadClaudeDesktopRecords(deps, new Map()),
    'deps',
    'records'
  )
  .pipe(probeLiveClaudeSessions, 'deps', 'result:outcome')
  .pipe((live: readonly ClaudeLiveSession[]) => live, 'outcome', 'liveSessions')
  .pipe(openRcToggle, ['records', 'liveSessions', 'deps'], 'result:outcome')
  .pipe(sendHelperArchiveRequest, ['outcome', 'target', 'deps'], 'outcome')
  .pipe(awaitAppArchive, ['outcome', 'target', 'deps'], 'outcome')
  .endAsync('outcome') as (
  target: RemoteControlTarget,
  deps: ClaudeDesktopAdapterDeps
) => Promise<Result<{ archived: true }>>;

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
          `${started.value.watchHint ?? ''} Remote Control is requested separately through neo-helper; native approval may be required. A request is not a confirmed connection.`.trim();
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
