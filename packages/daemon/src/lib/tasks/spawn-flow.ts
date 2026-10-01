import type { FlowOutcome } from './flow-outcome.ts';
import { buildSpawnExecutionPipeline } from './spawn-flow-admission.ts';
import type { SpawnExecutionFlowDeps, SpawnExecutionFlowInput } from './spawn-flow-contract.ts';
import { isSpawnFlowSettled } from './spawn-flow-ladder.ts';

export type { SpawnExecutionFlowDeps } from './spawn-flow-contract.ts';

export function isSpawnFlowWaitConcurrent(result: unknown): result is {
  kind: 'wait_concurrent';
} {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { kind?: unknown }).kind === 'wait_concurrent'
  );
}

export function isSpawnFlowReusedSession(result: unknown): result is {
  kind: 'reused_session';
  sessionId: string;
} {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { kind?: unknown }).kind === 'reused_session'
  );
}

export async function runSpawnExecutionFlow(
  deps: SpawnExecutionFlowDeps,
  input: SpawnExecutionFlowInput
): Promise<FlowOutcome> {
  const outcome = await buildSpawnExecutionPipeline(deps)(input);
  if (isSpawnFlowSettled(outcome)) return outcome.settled;
  return { status: 'completed', result: outcome.result };
}
