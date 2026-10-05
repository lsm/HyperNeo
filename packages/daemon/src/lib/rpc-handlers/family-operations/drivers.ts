import { existsSync, mkdirSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { getDataDir } from '../../data-dir.ts';
import { createCodexDesktopAdapter } from '../../drivers/codex-desktop-adapter.ts';
import { createFindWorkOperation } from '../../drivers/find-operation.ts';
import {
  createHyperneoAdapter,
  type HyperneoSessionControl,
} from '../../drivers/hyperneo-adapter.ts';
import { createSpaceAdapter } from '../../drivers/space-adapter.ts';
import type { WorkAdapter } from '../../drivers/types.ts';
import { createWorkVerbOperations } from '../../drivers/work-operations.ts';
import { renderAddress } from '../../mailbox/address.ts';
import { handoffPromptToMailbox } from '../../mailbox/handoff.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import { remoteDaemons } from '../../remote-daemons/registry.ts';
import type { FamilyOperationContext } from './context.ts';

function hyperneoSessionControl(context: FamilyOperationContext): HyperneoSessionControl {
  const { sessionManager, internalEventBus } = context.deps;
  return {
    create: (workspacePath, title) => sessionManager.createSession({ workspacePath, title }),
    chooseWorktree: async (sessionId) => {
      await sessionManager.getSessionLifecycle().completeWorktreeChoice(sessionId, 'worktree');
    },
    announce: (sessionId) => {
      const session = sessionManager.getSessionFromDB(sessionId);
      if (session)
        internalEventBus.publish('session.created', { sessionId, session }).catch(() => {});
    },
    interrupt: (sessionId) => {
      if (!sessionManager.getCachedSession(sessionId)) return false;
      internalEventBus.publish('agent.interruptRequest', { sessionId }).catch(() => {});
      return true;
    },
  };
}

function neoFolder(): string {
  const folder = join(getDataDir(), 'Neo');
  mkdirSync(folder, { recursive: true });
  return folder;
}

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
      handoff: (sessionId, message, from) =>
        handoffPromptToMailbox({
          to: renderAddress({ kind: 'session', sessionId }),
          message: {
            type: 'user',
            message: { role: 'user', content: message },
            parent_tool_use_id: null,
          },
          origin: from,
          jobQueue: context.deps.jobQueue,
        }),
      sessions: hyperneoSessionControl(context),
      neoFolder,
      folderExists: existsSync,
    }),
    createSpaceAdapter({
      db,
      machine,
      searchTaskIds: (text) =>
        new Set(search(text).flatMap((result) => (result.taskId ? [result.taskId] : []))),
    }),
    ...codexDesktopAdapters(),
  ];
  const deps = { adapters: () => adapters, remote: remoteDaemons };
  return [createFindWorkOperation(deps), ...createWorkVerbOperations(deps)];
}
