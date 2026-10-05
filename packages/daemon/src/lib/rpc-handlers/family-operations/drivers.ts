import { hostname } from 'node:os';
import { createFindWorkOperation } from '../../drivers/find-operation.ts';
import { createHyperneoAdapter } from '../../drivers/hyperneo-adapter.ts';
import { createSpaceAdapter } from '../../drivers/space-adapter.ts';
import { createWorkVerbOperations } from '../../drivers/work-operations.ts';
import { renderAddress } from '../../mailbox/address.ts';
import { handoffPromptToMailbox } from '../../mailbox/handoff.ts';
import type { OperationDefinition } from '../../operations/registry.ts';
import { remoteDaemons } from '../../remote-daemons/registry.ts';
import type { FamilyOperationContext } from './context.ts';

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
    }),
    createSpaceAdapter({
      db,
      machine,
      searchTaskIds: (text) =>
        new Set(search(text).flatMap((result) => (result.taskId ? [result.taskId] : []))),
    }),
  ];
  const deps = { adapters: () => adapters, remote: remoteDaemons };
  return [createFindWorkOperation(deps), ...createWorkVerbOperations(deps)];
}
