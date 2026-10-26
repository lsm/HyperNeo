import superpipe, { type PipelineAPI } from 'superpipe';
import { readClaudeInboxEndpoint } from './claude-inbox-endpoint.ts';
import { requireClaudeReplyDestination } from './claude-inbox-submit.ts';
import type { createClaudeDesktopModsRuntime } from './claude-desktop-mods-runtime.ts';
import type { createClaudeDesktopModsServer } from './claude-desktop-mods-server.ts';
import type { Result, WorkCallContext, WorkDelivery, WorkWithdrawal } from './types.ts';
import { reject } from './work-operations.ts';

type Runtime = NonNullable<Awaited<ReturnType<typeof createClaudeDesktopModsRuntime>>>;
type Action =
  | { kind: 'submit'; text: string }
  | { kind: 'stop' }
  | { kind: 'withdraw'; id: string };
type Outcome = Result<WorkDelivery | WorkWithdrawal | { stopped: boolean }>;
interface Deps {
  runtime: Runtime;
  registrationsDir: string;
  liveSessions: Parameters<typeof createClaudeDesktopModsServer>[0]['liveSessions'];
  hasSession(sessionId: string): boolean;
  stopTimeoutMs?: number;
}
type Target = NonNullable<ReturnType<Runtime['outbox']['journal']['active']>>;
async function requireBridge(sessionId: string, action: Action, deps: Deps) {
  if (action.kind === 'withdraw') return { value: null };
  const owner = await readClaudeInboxEndpoint(
    sessionId,
    await deps.liveSessions(),
    deps.registrationsDir
  );
  if ('ok' in owner) return { reason: owner };
  const state = deps.runtime.outbox.journal.active(sessionId);
  return owner.version === '2.1.299' &&
    state?.ownerPid === owner.pid &&
    state.state.phase !== 'ended' &&
    deps.runtime.connected(sessionId, owner.pid)
    ? { value: state }
    : {
        reason: reject(
          'unsupported',
          'No connected, verified Desktop mods instance owns this session.'
        ),
      };
}
function planControl(action: Action, target: Target | null) {
  if (action.kind !== 'stop') return { value: action };
  if (target!.state.phase === 'idle')
    return { reason: { ok: true as const, value: { stopped: false } } };
  return target!.state.phase === 'busy' && target!.state.turnId
    ? { value: { ...action, turnId: target!.state.turnId } }
    : {
        reason: reject(
          'unsupported',
          'The plugin has not observed the current turn ID; stop is unavailable until a turn event arrives.'
        ),
      };
}
function observeStop(
  sessionId: string,
  target: Target,
  turnId: string,
  id: string,
  from: string,
  deps: Deps
): Promise<Outcome> {
  const { runtime } = deps;
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout>;
  return new Promise<Outcome>((resolve) => {
    const inspect = (sid: string) => {
      if (sid !== sessionId) return;
      const completion = runtime.outbox.journal
        .events(sessionId, target.instanceId)
        .find((event) => event.kind === 'turn.complete' && event.turnId === turnId);
      if (completion)
        resolve({
          ok: true,
          value: { stopped: completion.isAborted === true || completion.reason === 'aborted' },
        });
      else if (runtime.outbox.get(sessionId, from, id)?.status === 'dead')
        resolve(
          reject(
            'not_delivered',
            `Desktop stop command ${id} failed; inspect its reported transport fact.`
          )
        );
      else if (
        !runtime.connected(sessionId, target.ownerPid) ||
        runtime.outbox.journal.active(sessionId)?.instanceId !== target.instanceId
      )
        resolve(
          reject(
            'unreachable',
            `Desktop mods owner changed or disconnected; stop ${id} is unconfirmed.`
          )
        );
    };
    timer = setTimeout(
      () =>
        resolve(
          reject(
            'unreachable',
            `No matching turn completion for Desktop stop ${id}; termination is unconfirmed.`
          )
        ),
      deps.stopTimeoutMs ?? 10_000
    );
    unsubscribe = runtime.subscribe(inspect);
    inspect(sessionId);
  }).finally(() => {
    clearTimeout(timer);
    unsubscribe();
  });
}
async function executeControl(
  action: Action & { turnId?: string },
  target: Target | null,
  sessionId: string,
  from: string,
  deps: Deps
): Promise<Outcome> {
  const outbox = deps.runtime.outbox;
  if (action.kind === 'withdraw')
    return outbox.write('withdrawReported', sessionId, from, action.id);
  const job = await outbox.write(
    'enqueueReported',
    sessionId,
    from,
    action.kind === 'submit' ? action : { kind: 'stop', turnId: action.turnId! }
  );
  return action.kind === 'submit'
    ? { ok: true, value: { delivered: false, unconfirmed: true, queuedSubmissionId: job.id } }
    : observeStop(sessionId, target!, action.turnId!, job.id, from, deps);
}
const control = (superpipe({})('control-claude-desktop-mods') as PipelineAPI)
  .input(['sessionId', 'action', 'context', 'deps'])
  .pipe(requireClaudeReplyDestination, ['context', 'deps'], 'result:outcome')
  .pipe((from: string) => from, 'outcome', 'from')
  .pipe(requireBridge, ['sessionId', 'action', 'deps'], 'result:outcome')
  .pipe((target: Target | null) => target, 'outcome', 'target')
  .pipe(planControl, ['action', 'target'], 'result:outcome')
  .pipe(executeControl, ['outcome', 'target', 'sessionId', 'from', 'deps'], 'outcome')
  .endAsync('outcome') as (
  sessionId: string,
  action: Action,
  context: WorkCallContext,
  deps: Deps
) => Promise<Outcome>;

export function createClaudeDesktopModsControl(deps: Deps) {
  return {
    queue: (sessionId: string, text: string, context: WorkCallContext) =>
      control(sessionId, { kind: 'submit', text }, context, deps) as Promise<Result<WorkDelivery>>,
    stop: (sessionId: string, context: WorkCallContext) =>
      control(sessionId, { kind: 'stop' }, context, deps) as Promise<Result<{ stopped: boolean }>>,
    withdraw: (sessionId: string, id: string, context: WorkCallContext) =>
      control(sessionId, { kind: 'withdraw', id }, context, deps) as Promise<
        Result<WorkWithdrawal>
      >,
    report: (sessionId: string) => deps.runtime.outbox.write('report', sessionId),
  };
}
