import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  type BuildCallActionDescriptionInput,
  buildCallActionDescription,
  CODER_HOT_ACTIONS,
  GENERAL_HOT_ACTIONS,
  PLANNER_HOT_ACTIONS,
  QA_HOT_ACTIONS,
  RESEARCH_HOT_ACTIONS,
  REVIEWER_HOT_ACTIONS,
  ROLE_HOT_ACTIONS,
} from '../../../../src/lib/space/actions/description-generator.ts';
import {
  type ActionDefinition,
  createActionRegistry,
  defineAction,
} from '../../../../src/lib/space/actions/registry.ts';

const ANY_SCHEMA = z.object({});

function makeAction(overrides: Partial<ActionDefinition> & { name: string }): ActionDefinition {
  return defineAction({
    family: 'test',
    safetyClass: 'read',
    description: `Description for ${overrides.name}`,
    paramsDoc: 'No parameters',
    paramsSchema: ANY_SCHEMA,
    handler: async () => null,
    ...overrides,
  });
}

function makeTestRegistry(): ReturnType<typeof createActionRegistry> {
  return createActionRegistry([
    makeAction({
      name: 'list_tasks',
      safetyClass: 'read',
      autonomyRequirement: 1,
      returnsHint: 'task list',
    }),
    makeAction({
      name: 'get_task_detail',
      safetyClass: 'read',
      autonomyRequirement: 1,
      paramsDoc: 'task_id: string',
      returnsHint: 'task detail',
    }),
    makeAction({
      name: 'create_standalone_task',
      safetyClass: 'mutate',
      autonomyRequirement: 3,
      paramsDoc: 'title: string, description: string',
      returnsHint: 'created task',
    }),
    makeAction({
      name: 'update_task',
      safetyClass: 'mutate',
      autonomyRequirement: 3,
      paramsDoc: 'task_id: string, status?: string',
      returnsHint: 'updated task',
    }),
    makeAction({
      name: 'send_message_to_task',
      safetyClass: 'mutate',
      autonomyRequirement: 4,
      paramsDoc: 'task_id: string, message: string',
      returnsHint: 'delivery result',
    }),
    makeAction({
      name: 'list_workflows',
      safetyClass: 'read',
      autonomyRequirement: 1,
      returnsHint: 'workflow list',
    }),
    makeAction({
      name: 'get_workflow_detail',
      safetyClass: 'read',
      autonomyRequirement: 2,
      paramsDoc: 'workflow_id: string',
      returnsHint: 'workflow detail',
    }),
    makeAction({
      name: 'suggest_workflow',
      safetyClass: 'read',
      autonomyRequirement: 1,
      paramsDoc: 'description: string',
      returnsHint: 'workflow suggestion',
    }),
    makeAction({
      name: 'list_artifacts',
      safetyClass: 'read',
      autonomyRequirement: 1,
      returnsHint: 'artifact list',
    }),
    makeAction({
      name: 'get_session_detail',
      safetyClass: 'read',
      autonomyRequirement: 1,
      paramsDoc: 'session_id: string',
      returnsHint: 'session detail',
    }),
  ]);
}

function buildInput(
  role: string,
  hotActions: readonly string[],
  overrides?: Partial<Omit<BuildCallActionDescriptionInput, 'role' | 'hotActions' | 'registry'>>
): BuildCallActionDescriptionInput {
  return {
    role,
    spaceLevel: 3,
    agentCeiling: 3,
    hotActions,
    registry: makeTestRegistry(),
    ...overrides,
  };
}

const SNAPSHOTS: Record<string, string> = {
  Coder: `## Coder actions

- create_standalone_task — Description for create_standalone_task
  Params: title: string, description: string
  Returns: created task
  Unlocked for this role (autonomy 3 >= required 3).

- list_tasks — Description for list_tasks
  Params: No parameters
  Returns: task list
  Unlocked for this role (autonomy 3 >= required 1).

- get_task_detail — Description for get_task_detail
  Params: task_id: string
  Returns: task detail
  Unlocked for this role (autonomy 3 >= required 1).

- update_task — Description for update_task
  Params: task_id: string, status?: string
  Returns: updated task
  Unlocked for this role (autonomy 3 >= required 3).

- send_message_to_task — Description for send_message_to_task
  Params: task_id: string, message: string
  Returns: delivery result
  NOT AVAILABLE: autonomy 3 < required 4. Do NOT call this action; use \`call_action(name="list_actions")\` to discover alternatives.

For the full action catalog, call \`call_action(name="list_actions")\`. For details on a specific action, call \`call_action(name="describe_action", params={ "name": "<action_name>" })\`.`,
  General: `## General actions

- create_standalone_task — Description for create_standalone_task
  Params: title: string, description: string
  Returns: created task
  Unlocked for this role (autonomy 3 >= required 3).

- list_tasks — Description for list_tasks
  Params: No parameters
  Returns: task list
  Unlocked for this role (autonomy 3 >= required 1).

- get_task_detail — Description for get_task_detail
  Params: task_id: string
  Returns: task detail
  Unlocked for this role (autonomy 3 >= required 1).

- list_workflows — Description for list_workflows
  Params: No parameters
  Returns: workflow list
  Unlocked for this role (autonomy 3 >= required 1).

- send_message_to_task — Description for send_message_to_task
  Params: task_id: string, message: string
  Returns: delivery result
  NOT AVAILABLE: autonomy 3 < required 4. Do NOT call this action; use \`call_action(name="list_actions")\` to discover alternatives.

For the full action catalog, call \`call_action(name="list_actions")\`. For details on a specific action, call \`call_action(name="describe_action", params={ "name": "<action_name>" })\`.`,
  Planner: `## Planner actions

- create_standalone_task — Description for create_standalone_task
  Params: title: string, description: string
  Returns: created task
  Unlocked for this role (autonomy 3 >= required 3).

- list_tasks — Description for list_tasks
  Params: No parameters
  Returns: task list
  Unlocked for this role (autonomy 3 >= required 1).

- list_workflows — Description for list_workflows
  Params: No parameters
  Returns: workflow list
  Unlocked for this role (autonomy 3 >= required 1).

- get_workflow_detail — Description for get_workflow_detail
  Params: workflow_id: string
  Returns: workflow detail
  Unlocked for this role (autonomy 3 >= required 2).

- suggest_workflow — Description for suggest_workflow
  Params: description: string
  Returns: workflow suggestion
  Unlocked for this role (autonomy 3 >= required 1).

For the full action catalog, call \`call_action(name="list_actions")\`. For details on a specific action, call \`call_action(name="describe_action", params={ "name": "<action_name>" })\`.`,
  Research: `## Research actions

- create_standalone_task — Description for create_standalone_task
  Params: title: string, description: string
  Returns: created task
  Unlocked for this role (autonomy 3 >= required 3).

- list_tasks — Description for list_tasks
  Params: No parameters
  Returns: task list
  Unlocked for this role (autonomy 3 >= required 1).

- get_task_detail — Description for get_task_detail
  Params: task_id: string
  Returns: task detail
  Unlocked for this role (autonomy 3 >= required 1).

- list_workflows — Description for list_workflows
  Params: No parameters
  Returns: workflow list
  Unlocked for this role (autonomy 3 >= required 1).

- send_message_to_task — Description for send_message_to_task
  Params: task_id: string, message: string
  Returns: delivery result
  NOT AVAILABLE: autonomy 3 < required 4. Do NOT call this action; use \`call_action(name="list_actions")\` to discover alternatives.

For the full action catalog, call \`call_action(name="list_actions")\`. For details on a specific action, call \`call_action(name="describe_action", params={ "name": "<action_name>" })\`.`,
  Reviewer: `## Reviewer actions

- list_tasks — Description for list_tasks
  Params: No parameters
  Returns: task list
  Unlocked for this role (autonomy 3 >= required 1).

- get_task_detail — Description for get_task_detail
  Params: task_id: string
  Returns: task detail
  Unlocked for this role (autonomy 3 >= required 1).

- list_workflows — Description for list_workflows
  Params: No parameters
  Returns: workflow list
  Unlocked for this role (autonomy 3 >= required 1).

- send_message_to_task — Description for send_message_to_task
  Params: task_id: string, message: string
  Returns: delivery result
  NOT AVAILABLE: autonomy 3 < required 4. Do NOT call this action; use \`call_action(name="list_actions")\` to discover alternatives.

- list_artifacts — Description for list_artifacts
  Params: No parameters
  Returns: artifact list
  Unlocked for this role (autonomy 3 >= required 1).

For the full action catalog, call \`call_action(name="list_actions")\`. For details on a specific action, call \`call_action(name="describe_action", params={ "name": "<action_name>" })\`.`,
  QA: `## QA actions

- list_tasks — Description for list_tasks
  Params: No parameters
  Returns: task list
  Unlocked for this role (autonomy 3 >= required 1).

- get_task_detail — Description for get_task_detail
  Params: task_id: string
  Returns: task detail
  Unlocked for this role (autonomy 3 >= required 1).

- list_workflows — Description for list_workflows
  Params: No parameters
  Returns: workflow list
  Unlocked for this role (autonomy 3 >= required 1).

- get_session_detail — Description for get_session_detail
  Params: session_id: string
  Returns: session detail
  Unlocked for this role (autonomy 3 >= required 1).

- update_task — Description for update_task
  Params: task_id: string, status?: string
  Returns: updated task
  Unlocked for this role (autonomy 3 >= required 3).

For the full action catalog, call \`call_action(name="list_actions")\`. For details on a specific action, call \`call_action(name="describe_action", params={ "name": "<action_name>" })\`.`,
};

describe('buildCallActionDescription', () => {
  test('is deterministic across identical calls', () => {
    const input = buildInput('Coder', CODER_HOT_ACTIONS);
    const first = buildCallActionDescription(input);
    const second = buildCallActionDescription(input);
    expect(second).toBe(first);
  });

  test('omits hot actions missing from the registry', () => {
    const input = buildInput('Coder', ['missing_one', 'missing_two']);
    const result = buildCallActionDescription(input);
    expect(result).not.toContain('missing_one');
    expect(result).not.toContain('missing_two');
    expect(result).toContain('No suggested hot actions are available for this role');
  });

  test('caps advertised hot actions at six', () => {
    const sevenActions = Array.from({ length: 7 }, (_, i) => `list_tasks_${i}`);
    const registry = createActionRegistry(
      sevenActions.map((name) => makeAction({ name, safetyClass: 'read', autonomyRequirement: 1 }))
    );
    const result = buildCallActionDescription({
      role: 'Overflow',
      spaceLevel: 3,
      agentCeiling: 3,
      hotActions: sevenActions,
      registry,
    });
    expect((result.match(/- list_tasks_/g) ?? []).length).toBe(6);
  });

  test('defaults spaceLevel to 1 when not provided', () => {
    const input = buildInput('Coder', ['create_standalone_task'], { spaceLevel: undefined });
    const result = buildCallActionDescription(input);
    expect(result).toContain('NOT AVAILABLE: autonomy 1 < required 3');
  });

  test('uses agentCeiling as an upper bound on spaceLevel', () => {
    const input = buildInput('Coder', ['send_message_to_task'], { spaceLevel: 5, agentCeiling: 2 });
    const result = buildCallActionDescription(input);
    expect(result).toContain('NOT AVAILABLE: autonomy 2 < required 4');
  });

  test('treats null agentCeiling as inheriting the spaceLevel', () => {
    const input = buildInput('Coder', ['send_message_to_task'], {
      spaceLevel: 4,
      agentCeiling: null,
    });
    const result = buildCallActionDescription(input);
    expect(result).toContain('Unlocked for this role (autonomy 4 >= required 4)');
  });

  test('falls back to generic returns hint when action has none', () => {
    const registry = createActionRegistry([
      makeAction({ name: 'generic_returns', safetyClass: 'read', autonomyRequirement: 1 }),
    ]);
    const result = buildCallActionDescription({
      role: 'Generic',
      spaceLevel: 3,
      agentCeiling: 3,
      hotActions: ['generic_returns'],
      registry,
    });
    expect(result).toContain('Returns: the action result');
  });

  test('describes function autonomyRequirement as parameter-dependent', () => {
    const registry = createActionRegistry([
      defineAction({
        name: 'resolver_action',
        family: 'test',
        safetyClass: 'mutate',
        description: 'Resolver-based autonomy',
        paramsDoc: 'x: string',
        paramsSchema: z.object({ x: z.string() }),
        autonomyRequirement: async (params: { x: string }) => (params.x === 'high' ? 5 : 1),
        handler: async () => null,
      }),
    ]);
    const result = buildCallActionDescription({
      role: 'Resolver',
      spaceLevel: 3,
      agentCeiling: 3,
      hotActions: ['resolver_action'],
      registry,
    });
    expect(result).toContain('Autonomy requirement depends on the provided parameters');
    expect(result).toContain('evaluated when the action is invoked');
    expect(result).not.toContain('Unlocked for this role');
    expect(result).not.toContain('NOT AVAILABLE');
  });

  test('treats an absent autonomyRequirement as no requirement (level 0)', () => {
    const registry = createActionRegistry([
      makeAction({ name: 'no_requirement_action', safetyClass: 'read' }),
    ]);
    const result = buildCallActionDescription({
      role: 'NoRequirement',
      spaceLevel: 3,
      agentCeiling: 3,
      hotActions: ['no_requirement_action'],
      registry,
    });
    expect(result).toContain('Unlocked for this role (autonomy 3 >= required 0)');
  });
});

describe('role hot action seeds', () => {
  test('ROLE_HOT_ACTIONS contains all six preset roles', () => {
    expect(Object.keys(ROLE_HOT_ACTIONS).sort()).toEqual([
      'coder',
      'general',
      'planner',
      'qa',
      'research',
      'reviewer',
    ]);
  });

  test('each role has 4-6 hot actions', () => {
    for (const [, actions] of Object.entries(ROLE_HOT_ACTIONS)) {
      expect(actions.length).toBeGreaterThanOrEqual(4);
      expect(actions.length).toBeLessThanOrEqual(6);
    }
  });
});

describe('buildCallActionDescription per-role snapshots', () => {
  test('coder', () => {
    expect(buildCallActionDescription(buildInput('Coder', CODER_HOT_ACTIONS))).toBe(
      SNAPSHOTS.Coder
    );
  });

  test('general', () => {
    expect(buildCallActionDescription(buildInput('General', GENERAL_HOT_ACTIONS))).toBe(
      SNAPSHOTS.General
    );
  });

  test('planner', () => {
    expect(buildCallActionDescription(buildInput('Planner', PLANNER_HOT_ACTIONS))).toBe(
      SNAPSHOTS.Planner
    );
  });

  test('research', () => {
    expect(buildCallActionDescription(buildInput('Research', RESEARCH_HOT_ACTIONS))).toBe(
      SNAPSHOTS.Research
    );
  });

  test('reviewer', () => {
    expect(buildCallActionDescription(buildInput('Reviewer', REVIEWER_HOT_ACTIONS))).toBe(
      SNAPSHOTS.Reviewer
    );
  });

  test('qa', () => {
    expect(buildCallActionDescription(buildInput('QA', QA_HOT_ACTIONS))).toBe(SNAPSHOTS.QA);
  });
});
