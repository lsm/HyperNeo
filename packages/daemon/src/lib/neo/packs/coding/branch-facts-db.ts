import { isSqliteBusyError } from '../../../../storage/busy-retry.ts';
import { defineRepositoryOp } from '../../../../storage/db-gateway/db-op.ts';
import type { Database } from '../../../../storage/sqlite-compat.ts';
import { emitStructuredLogEvent } from '../../../logger.ts';
import { CodingBranchFactsRepository } from './branch-facts.ts';

class CodingBranchCommands {
  constructor(private readonly db: Database) {}

  snapshot(...args: Parameters<CodingBranchFactsRepository['snapshot']>) {
    return new CodingBranchFactsRepository(this.db).snapshot(...args);
  }

  observe(...args: Parameters<CodingBranchFactsRepository['observe']>) {
    return new CodingBranchFactsRepository(this.db).observe(...args);
  }
}

export const codingBranchReads = defineRepositoryOp(
  'coding.branch.snapshot',
  'read',
  CodingBranchCommands,
  ['snapshot']
);
export const codingBranchWrites = defineRepositoryOp(
  'coding.branch.observe',
  'write',
  CodingBranchCommands,
  ['observe']
);

function retryLog(metadata: Record<string, unknown>): void {
  emitStructuredLogEvent({
    level: 'warn',
    source: 'logger',
    module: 'hyperneo:daemon:sqlite.query',
    args: ['sqlite.busy_retry'],
    metadata: { operationPhase: 'coding.branch.db', ...metadata },
  });
}

export async function callCodingBranchDb<T>(
  call: () => Promise<T>,
  operationPhase = 'coding.branch.db'
): Promise<T> {
  const report = (metadata: Record<string, unknown>) => retryLog({ operationPhase, ...metadata });
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await call();
      if (attempt) report({ phase: 'retry', attempt: attempt + 1, outcome: 'ok' });
      return result;
    } catch (error) {
      const busy = isSqliteBusyError(error);
      if (busy || attempt)
        report({
          phase: 'retry',
          attempt: attempt + 1,
          outcome: busy ? (attempt >= 2 ? 'exhausted' : 'busy') : 'error',
        });
      if (!busy || attempt >= 2) throw error;
      const requestedMs = 25 * 2 ** attempt,
        start = performance.now();
      await new Promise((done) => setTimeout(done, requestedMs));
      report({
        phase: 'sleep',
        attempt: attempt + 1,
        outcome: 'ok',
        requestedMs,
        durationMs: performance.now() - start,
      });
    }
  }
}
