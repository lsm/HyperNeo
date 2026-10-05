import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  createClaudeDesktopAdapter,
  readLiveClaudeSessions,
} from '../../drivers/claude-desktop-adapter.ts';
import { createFindWorkOperation } from '../../drivers/find-operation.ts';
import { createHyperneoAdapter } from '../../drivers/hyperneo-adapter.ts';
import type { WorkAdapter } from '../../drivers/types.ts';
import { createWorkVerbOperations } from '../../drivers/work-operations.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import { remoteDaemons } from '../../remote-daemons/registry.ts';
import { spawnProcess } from '../../runtime-spawn/index.ts';
import type { FamilyOperationContext } from './context.ts';

function claudeDesktopAdapters(): WorkAdapter[] {
  const sessionsDir = join(
    homedir(),
    'Library',
    'Application Support',
    'Claude',
    'claude-code-sessions'
  );
  if (!existsSync(sessionsDir)) return [];
  return [
    createClaudeDesktopAdapter({
      sessionsDir,
      machine: hostname(),
      liveSessions: () => readLiveClaudeSessions(spawnProcess),
    }),
  ];
}

export function registerDriverOperations(context: FamilyOperationContext): OperationDefinition[] {
  const adapters = [
    createHyperneoAdapter({
      db: () => context.deps.db.getDatabase(),
      machine: hostname(),
      searchSessionIds: (text) =>
        new Set(
          context.deps.db
            .getSDKMessageRepo()
            .searchMessages({ query: text, limit: 50 })
            .results.flatMap((result) => (result.sessionId ? [result.sessionId] : []))
        ),
    }),
    ...claudeDesktopAdapters(),
  ];
  const deps = { adapters: () => adapters, remote: remoteDaemons };
  return [createFindWorkOperation(deps), ...createWorkVerbOperations(deps)];
}
