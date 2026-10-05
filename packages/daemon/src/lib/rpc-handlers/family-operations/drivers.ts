import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  createClaudeDesktopAdapter,
  readLiveClaudeSessions,
} from '../../drivers/claude-desktop-adapter.ts';
import { createCodexDesktopAdapter } from '../../drivers/codex-desktop-adapter.ts';
import { createFindWorkOperation } from '../../drivers/find-operation.ts';
import { createHyperneoAdapter } from '../../drivers/hyperneo-adapter.ts';
import { createSpaceAdapter } from '../../drivers/space-adapter.ts';
import type { WorkAdapter } from '../../drivers/types.ts';
import { createWorkVerbOperations } from '../../drivers/work-operations.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import { remoteDaemons } from '../../remote-daemons/registry.ts';
import { spawnProcess } from '../../runtime-spawn/index.ts';
import type { FamilyOperationContext } from './context.ts';

function codexDesktopAdapters(): WorkAdapter[] {
  const codexHome = join(homedir(), '.codex');
  const statePath = join(codexHome, 'state_5.sqlite');
  if (!existsSync(statePath)) return [];
  return [
    createCodexDesktopAdapter({
      statePath,
      worktreesDir: join(codexHome, 'worktrees'),
      machine: hostname(),
      now: Date.now,
    }),
  ];
}

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
  const db = () => context.deps.db.getDatabase();
  const machine = hostname();
  const search = (text: string) =>
    context.deps.db.getSDKMessageRepo().searchMessages({ query: text, limit: 50 }).results;
  const adapters = [
    createHyperneoAdapter({
      db,
      machine,
      searchSessionIds: (text) =>
        new Set(search(text).flatMap((result) => (result.sessionId ? [result.sessionId] : []))),
    }),
    createSpaceAdapter({
      db,
      machine,
      searchTaskIds: (text) =>
        new Set(search(text).flatMap((result) => (result.taskId ? [result.taskId] : []))),
    }),
    ...codexDesktopAdapters(),
    ...claudeDesktopAdapters(),
  ];
  const deps = { adapters: () => adapters, remote: remoteDaemons };
  return [createFindWorkOperation(deps), ...createWorkVerbOperations(deps)];
}
