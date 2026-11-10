import { defineRepositoryOp } from './db-gateway/db-op.ts';
import type { Database } from './sqlite-compat.ts';
import { readWorkInputTurn, type WorkTurn } from './work-turns.ts';

interface WorkInputIdentity {
  adapter: 'codex-desktop' | 'claude-code';
  marker: string;
}

class WorkInputRepository {
  constructor(private readonly db: Database) {}

  find(sessionId: string, input: WorkInputIdentity): WorkTurn | null {
    return readWorkInputTurn(
      this.db,
      sessionId,
      input.adapter === 'codex-desktop' ? 'codex' : 'claude',
      input.marker
    );
  }
}

export const readWorkInput = defineRepositoryOp('workInput.read', 'read', WorkInputRepository, [
  'find',
] as const);
