import type { SessionToolInventory } from '@hyperneo/shared/types/observed-tool-inventory';
import type { QueryAttemptToken } from './query-attempt-token.ts';

export class ObservedToolInventory {
  begin(_token: QueryAttemptToken, _provider: 'sdk' | 'acp'): void {}
  captureInit(_token: QueryAttemptToken, _message: unknown): void {}
  captureStatus(_token: QueryAttemptToken, _servers: unknown): void {}
  end(_token: QueryAttemptToken): void {}

  snapshot(): SessionToolInventory {
    return { state: 'not_running', tools: [], skills: [], plugins: [], mcpServers: [] };
  }
}
