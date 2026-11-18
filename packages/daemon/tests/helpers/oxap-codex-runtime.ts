import type { OapEngine, OapEngineOptions } from '../../src/lib/oap/oap-engine';
import { createOapRuntime } from '../../src/lib/oap/oap-runtime';

export const syntheticHubOptions: OapEngineOptions = {
  binaryPath: '/synthetic/oapx',
  identity: { version: 'synthetic', sha256: 'a'.repeat(64) },
  stateDirectory: '/synthetic/state',
  hub: { adapters: {}, environment: {} },
};

export const codexRecord = {
  providerId: 'anthropic-codex',
  configJson: '{"harness":"oxap-codex"}',
} as never;

export function bindCodexRuntime(
  engine: OapEngine,
  options?: OapEngineOptions,
  events?: Parameters<typeof createOapRuntime>[2],
  db?: unknown,
  messageHub?: unknown
) {
  return createOapRuntime(
    engine,
    options ? { installed: () => true, read: async () => options } : undefined,
    events,
    db as never,
    messageHub as never,
    (providerId) => (providerId === 'anthropic-codex' ? codexRecord : null)
  );
}
