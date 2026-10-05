import { existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { createCodexDesktopAdapter } from '../../drivers/codex-desktop-adapter.ts';
import { createFindWorkOperation } from '../../drivers/find-operation.ts';
import { createHyperneoAdapter } from '../../drivers/hyperneo-adapter.ts';
import {
  createSpaceAdapter,
  spaceTaskCaller,
  taskOperationRejection,
  type SpaceTaskControl,
} from '../../drivers/space-adapter.ts';
import type { WorkAdapter } from '../../drivers/types.ts';
import { createWorkVerbOperations } from '../../drivers/work-operations.ts';
import { invokeOperation } from '../../operations/invoke.ts';
import type { OperationCaller, OperationDefinition } from '../../operations/registry.ts';
import { remoteDaemons } from '../../remote-daemons/registry.ts';
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

function spaceTaskControl(context: FamilyOperationContext): SpaceTaskControl {
  const invoke = async (name: string, input: unknown, caller: OperationCaller) => {
    const outcome = await invokeOperation(
      context.deps.sessionManager.getOperationRegistry(),
      name,
      input,
      spaceTaskCaller(caller)
    );
    return outcome.kind === 'completed' ? outcome.value : outcome.message;
  };
  return {
    create: async (spaceId, title, description, caller) => {
      const created = await invoke('task.create', { spaceId, title, description }, caller);
      const reason = taskOperationRejection(created);
      return reason === null ? { taskId: (created as { id: string }).id } : { reason };
    },
    cancel: async (taskId, caller) => {
      const reason = taskOperationRejection(
        await invoke('task.transition', { taskId, status: 'cancelled' }, caller)
      );
      return reason === null ? { cancelled: true } : { reason };
    },
  };
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
      tasks: spaceTaskControl(context),
    }),
    ...codexDesktopAdapters(),
  ];
  const deps = { adapters: () => adapters, remote: remoteDaemons };
  return [createFindWorkOperation(deps), ...createWorkVerbOperations(deps)];
}
