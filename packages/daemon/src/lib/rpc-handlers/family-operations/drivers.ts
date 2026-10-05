import { hostname } from 'node:os';
import { createFindWorkOperation } from '../../drivers/find-operation.ts';
import { createHyperneoAdapter } from '../../drivers/hyperneo-adapter.ts';
import {
  createSpaceAdapter,
  taskOperationRejection,
  type SpaceTaskControl,
} from '../../drivers/space-adapter.ts';
import { createWorkVerbOperations } from '../../drivers/work-operations.ts';
import { invokeOperation } from '../../operations/invoke.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import { remoteDaemons } from '../../remote-daemons/registry.ts';
import type { FamilyOperationContext } from './context.ts';

function spaceTaskControl(context: FamilyOperationContext): SpaceTaskControl {
  const invoke = async (name: string, input: unknown) => {
    const outcome = await invokeOperation(
      context.deps.sessionManager.getOperationRegistry(),
      name,
      input,
      { source: 'rpc' }
    );
    return outcome.kind === 'completed' ? outcome.value : outcome.message;
  };
  return {
    create: async (spaceId, title, description) => {
      const created = await invoke('task.create', { spaceId, title, description });
      const reason = taskOperationRejection(created);
      return reason === null ? { taskId: (created as { id: string }).id } : { reason };
    },
    cancel: async (taskId) => {
      const reason = taskOperationRejection(
        await invoke('task.transition', { taskId, status: 'cancelled' })
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
  ];
  const deps = { adapters: () => adapters, remote: remoteDaemons };
  return [createFindWorkOperation(deps), ...createWorkVerbOperations(deps)];
}
