import type { Session, SessionConfig } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';

type SessionEngine = NonNullable<SessionConfig['harness']>;

export function selectSessionEngine(harness: unknown): SessionEngine {
  if (harness === undefined || harness === 'sdk') return 'sdk';
  if (harness === 'codex') return 'codex';
  throw new Error(`Unknown session harness: ${String(harness)}`);
}

function decideCodexAdmission(session: Session, neoRoot: boolean): string | undefined {
  if (
    session.config.toolGuards?.length ||
    session.config.workerOperations ||
    session.context?.spaceId ||
    neoRoot
  ) {
    return 'Codex is not supported for sessions requiring tool guards, worker operations, Space, or Neo.';
  }
  return undefined;
}

export const codexSessionRefusal = (superpipe({})('oap.session.admission') as PipelineAPI)
  .input(['session', 'neoRoot'])
  .pipe(decideCodexAdmission, ['session', 'neoRoot'], 'reason')
  .end('reason') as typeof decideCodexAdmission;
