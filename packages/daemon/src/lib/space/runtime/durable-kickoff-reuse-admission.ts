import type { SpaceTask } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

export type DurableKickoffReuseResult =
  | { value: { action: 'inject' } }
  | { value: { action: 'refuse'; reason: string } }
  | { reason: 'already-running' | 'resumed' };

export interface DurableKickoffReuseDeps {
  hasDurableKickoff(task: SpaceTask, sessionId: string): boolean;
  isQueryActive(sessionId: string): boolean;
  admitResume(task: SpaceTask): Promise<void>;
  startQuery(sessionId: string): Promise<void>;
}

export function loadKickoffFacts(
  deps: DurableKickoffReuseDeps,
  task: SpaceTask,
  sessionId: string
): { alreadyDelivered: boolean } {
  return { alreadyDelivered: deps.hasDurableKickoff(task, sessionId) };
}

export function gateFreshInjection(
  _deps: DurableKickoffReuseDeps,
  { alreadyDelivered }: { alreadyDelivered: boolean }
): DurableKickoffReuseResult | null {
  if (alreadyDelivered) return null;
  return { value: { action: 'inject' } };
}

export async function resumeDeliveredWorker(
  deps: DurableKickoffReuseDeps,
  task: SpaceTask,
  sessionId: string
): Promise<DurableKickoffReuseResult> {
  if (deps.isQueryActive(sessionId)) {
    return { reason: 'already-running' };
  }
  try {
    await deps.admitResume(task);
  } catch {
    return {
      value: {
        action: 'refuse',
        reason: `reused session ${sessionId} already holds this approval generation's kickoff but its query could not be admitted`,
      },
    };
  }
  await deps.startQuery(sessionId);
  if (!deps.isQueryActive(sessionId)) {
    return {
      value: {
        action: 'refuse',
        reason: `reused session ${sessionId} already holds this approval generation's kickoff but its query could not be started`,
      },
    };
  }
  return { reason: 'resumed' };
}

type KickoffReuseState = {
  deps: DurableKickoffReuseDeps;
  task: SpaceTask;
  sessionId: string;
  alreadyDelivered: boolean;
  outcome: DurableKickoffReuseResult | null;
};

const kickoffReuseRun = (
  superpipe<{ settled: (state: KickoffReuseState) => boolean }>({
    settled: (state: KickoffReuseState): boolean => state.outcome !== null,
  })('durable-kickoff-reuse-admission') as PipelineAPI
)
  .input(['deps', 'task', 'sessionId'])
  .pipe(loadKickoffFacts, ['deps', 'task', 'sessionId'], 'alreadyDelivered')
  .pipe(gateFreshInjection, ['deps', 'alreadyDelivered'], 'outcome')
  .pipe('!settled', ['deps', 'task', 'sessionId'])
  .pipe(resumeDeliveredWorker, ['deps', 'task', 'sessionId'], 'outcome')
  .endAsync('outcome');

export async function runDurableKickoffReuseAdmission(
  input: DurableKickoffReuseDeps & { task: SpaceTask; sessionId: string }
): Promise<DurableKickoffReuseResult> {
  const outcome = (await kickoffReuseRun(
    input,
    input.task,
    input.sessionId
  )) as DurableKickoffReuseResult | null;
  return outcome ?? { reason: 'resumed' };
}
