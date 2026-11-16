import type { NeoTodoSessionRepository } from '../../../storage/repositories/neo-todo-session-repository.ts';
import type { NeoPack } from '../pack-contract.ts';
import type { NeoAttentionEvent } from './decide.ts';

export function createNeoAttentionSweep(deps: {
  sessions: NeoTodoSessionRepository;
  packs(): readonly NeoPack[];
  limits(): { running: number; perGroup: number };
  tell(event: NeoAttentionEvent, now: number): Promise<unknown>;
}) {
  return async (now: number): Promise<void> => void [deps, now];
}
