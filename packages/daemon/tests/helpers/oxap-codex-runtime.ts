import type { OxapEngine, OxapEngineOptions } from '../../src/lib/oxap/oxap-engine';
import { createOxapRuntime } from '../../src/lib/oxap/oxap-runtime';

export const syntheticHubOptions: OxapEngineOptions = {
  binaryPath: '/synthetic/oxap',
  identity: { version: 'synthetic', sha256: 'a'.repeat(64) },
  stateDirectory: '/synthetic/state',
  hub: { adapters: {}, environment: {} },
};

export const codexRecord = {
  providerId: 'anthropic-codex',
  configJson: '{"harness":"oxap-codex"}',
} as never;

export function bindCodexRuntime(
  engine: OxapEngine,
  options?: OxapEngineOptions,
  events?: Parameters<typeof createOxapRuntime>[2],
  db?: unknown,
  messageHub?: unknown
) {
  return createOxapRuntime(
    engine,
    options ? { installed: () => true, read: async () => options } : undefined,
    events,
    db as never,
    messageHub as never,
    (providerId) => (providerId === 'anthropic-codex' ? codexRecord : null),
    async () => {}
  );
}
