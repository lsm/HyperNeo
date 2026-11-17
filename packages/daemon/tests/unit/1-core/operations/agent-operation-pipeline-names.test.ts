import { describe, expect, test, vi } from 'vitest';
import type { OperationCaller } from '../../../../src/lib/operations/registry';
import { createAgentTemplateOperations } from '../../../../src/lib/agents/agent-template-operations';
import { createResolveAgentOperation } from '../../../../src/lib/agents/agent-reference';
import { createListAgentsOperation } from '../../../../src/lib/agents/list-agents-operation';
import { createGetAgentOperation } from '../../../../src/lib/agents/get-agent-operation';
import { createCreateAgentOperation } from '../../../../src/lib/agents/create-agent-operation';
import { createUpdateAgentOperation } from '../../../../src/lib/agents/update-agent-operation';
import { createEnsureAgentSessionOperation } from '../../../../src/lib/agents/ensure-agent-session-operation';
import {
  createCancelAgentReminderOperation,
  createCreateAgentReminderOperation,
  createListAgentRemindersOperation,
} from '../../../../src/lib/agents/reminder-operations';

const entered = vi.hoisted(() => [] as string[]);

vi.mock('superpipe', async (importOriginal) => {
  const { recordPipelineEntries } = await import('../../../helpers/pipeline-entries');
  return recordPipelineEntries(await importOriginal<typeof import('superpipe')>(), entered);
});

const deps = {} as never;
const unscopedAgent: OperationCaller = { source: 'mcp', role: 'long_term_agent' };

const operations = [
  createListAgentsOperation(deps),
  createGetAgentOperation(deps),
  createCreateAgentOperation(deps),
  createUpdateAgentOperation(deps),
  createEnsureAgentSessionOperation(deps),
  createCreateAgentReminderOperation(deps),
  createListAgentRemindersOperation(deps),
  createCancelAgentReminderOperation(deps),
  createResolveAgentOperation({ listSpaces: () => [], listAgents: () => [] }),
  ...createAgentTemplateOperations(deps),
];

describe('agent operations', () => {
  test('covers every agent operation', () => {
    expect(operations.map((operation) => operation.name).sort()).toEqual([
      'agent.create',
      'agent.get',
      'agent.list',
      'agent.reminder.cancel',
      'agent.reminder.create',
      'agent.reminder.list',
      'agent.resolve',
      'agent.session.ensure',
      'agent.template.create',
      'agent.template.delete',
      'agent.template.instantiate',
      'agent.template.list',
      'agent.template.update',
      'agent.update',
    ]);
  });

  test.each(operations.map((operation) => [operation.name, operation] as const))(
    '%s enters a pipeline named for the operation',
    async (_name, operation) => {
      entered.length = 0;
      await Promise.resolve(
        operation.execute({ spaceId: 'space-1', agent: 'a' } as never, unscopedAgent)
      ).catch(() => undefined);
      expect(entered[0]).toBe(operation.name);
      for (const helper of entered.slice(1)) {
        expect(helper.startsWith(`${operation.name}.`)).toBe(true);
      }
    }
  );
});
