import type { SessionConfig } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

type SessionEngine = NonNullable<SessionConfig['harness']>;

export function selectSessionEngine(harness: unknown): SessionEngine {
  if (harness === undefined || harness === 'sdk') return 'sdk';
  if (harness === 'codex') return 'codex';
  throw new Error(`Unknown session harness: ${String(harness)}`);
}

function decideCodexAdmission(
  config: Partial<SessionConfig>,
  space: boolean,
  neoRoot: boolean,
  runtimeGuards = false
): string | undefined {
  if (
    config.systemPrompt !== undefined ||
    config.agent !== undefined ||
    config.agents !== undefined
  ) {
    return 'Codex session instructions are not supported yet.';
  }
  if (
    (config.toolGuards !== undefined &&
      (!Array.isArray(config.toolGuards) || config.toolGuards.length > 0)) ||
    runtimeGuards ||
    (config.workerOperations !== undefined && config.workerOperations !== false) ||
    space ||
    neoRoot
  ) {
    return 'Codex is not supported for sessions requiring tool guards, worker operations, Space, or Neo.';
  }
  return undefined;
}

export const codexSessionRefusal = (superpipe({})('oap.session.admission') as PipelineAPI)
  .input(['config', 'space', 'neoRoot', 'runtimeGuards'])
  .pipe(decideCodexAdmission, ['config', 'space', 'neoRoot', 'runtimeGuards'], 'reason')
  .end('reason') as typeof decideCodexAdmission;
