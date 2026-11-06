import type { SessionConfig } from '@hyperneo/shared';

type SessionEngine = NonNullable<SessionConfig['harness']>;

export function selectSessionEngine(harness: unknown): SessionEngine {
  if (harness === undefined || harness === 'sdk') return 'sdk';
  if (harness === 'codex') return 'codex';
  throw new Error(`Unknown session harness: ${String(harness)}`);
}
