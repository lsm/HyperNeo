import superpipe, { type PipelineAPI } from 'superpipe';
import type { SessionResolutionDeps } from './deps.ts';
import { ensureAgentSession } from './ensure-agent-session.ts';
import { ensureWorkerSession } from './ensure-worker-session.ts';
import { findSessionForTarget } from './find-session-for-target.ts';
import type { EnsureSessionOutcome, SessionTarget } from './target.ts';

export async function findStage(
  target: SessionTarget,
  deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome | undefined> {
  if (target.kind === 'worker') {
    return undefined;
  }
  const outcome = await findSessionForTarget(target, deps);
  return outcome.kind === 'resolved' ? outcome : undefined;
}

export async function ensureStage(
  target: SessionTarget,
  deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  if (target.kind === 'session') {
    return { kind: 'unresolved', reason: 'not_found' };
  }
  if (target.kind === 'agent') {
    return ensureAgentSession(target, deps);
  }
  return ensureWorkerSession(target, deps);
}

export function crashHandler(error: unknown): EnsureSessionOutcome {
  return {
    kind: 'unresolved',
    reason: `internal: ${error instanceof Error ? error.message : String(error)}`,
  };
}

const settled = (outcome?: EnsureSessionOutcome): boolean => outcome !== undefined;

const runEnsureSession = (
  superpipe<{ settled: (outcome?: EnsureSessionOutcome) => boolean }>({
    settled,
  })('ensure-session') as PipelineAPI
)
  .input(['target', 'deps'])
  .pipe(findStage, ['target', 'deps'], 'outcome')
  .pipe('!settled', 'outcome')
  .pipe(ensureStage, ['target', 'deps'], 'outcome')
  .error(crashHandler, ['error'])
  .endAsync('outcome') as (
  target: SessionTarget,
  deps: SessionResolutionDeps
) => Promise<EnsureSessionOutcome>;

export async function ensureSession(
  target: SessionTarget,
  deps: SessionResolutionDeps
): Promise<EnsureSessionOutcome> {
  return runEnsureSession(target, deps).catch(crashHandler);
}
