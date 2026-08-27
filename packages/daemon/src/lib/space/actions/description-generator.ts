import { resolveEffectiveAutonomyLevel } from '../tools/tool-admission-gates.ts';
import type { ActionRegistry, RegisteredAction } from './registry.ts';

export interface BuildCallActionDescriptionInput {
  role: string;
  spaceLevel?: number | null;
  agentCeiling?: number | null;
  hotActions: readonly string[];
  registry: ActionRegistry;
}

export const CODER_HOT_ACTIONS: readonly string[] = [
  'create_standalone_task',
  'list_tasks',
  'get_task_detail',
  'update_task',
  'send_message_to_task',
];

export const GENERAL_HOT_ACTIONS: readonly string[] = [
  'create_standalone_task',
  'list_tasks',
  'get_task_detail',
  'list_workflows',
  'send_message_to_task',
];

export const PLANNER_HOT_ACTIONS: readonly string[] = [
  'create_standalone_task',
  'list_tasks',
  'list_workflows',
  'get_workflow_detail',
  'suggest_workflow',
];

export const RESEARCH_HOT_ACTIONS: readonly string[] = [
  'create_standalone_task',
  'list_tasks',
  'get_task_detail',
  'list_workflows',
  'send_message_to_task',
];

export const REVIEWER_HOT_ACTIONS: readonly string[] = [
  'list_tasks',
  'get_task_detail',
  'list_workflows',
  'send_message_to_task',
  'list_artifacts',
];

export const QA_HOT_ACTIONS: readonly string[] = [
  'list_tasks',
  'get_task_detail',
  'list_workflows',
  'get_session_detail',
  'update_task',
];

export const ROLE_HOT_ACTIONS: Record<string, readonly string[]> = {
  coder: CODER_HOT_ACTIONS,
  general: GENERAL_HOT_ACTIONS,
  planner: PLANNER_HOT_ACTIONS,
  research: RESEARCH_HOT_ACTIONS,
  reviewer: REVIEWER_HOT_ACTIONS,
  qa: QA_HOT_ACTIONS,
};

function resolveAutonomyRequirement(action: RegisteredAction): number | null {
  if (typeof action.autonomyRequirement === 'number') return action.autonomyRequirement;
  if (action.autonomyRequirement === undefined) return 0;
  return null;
}

function buildAutonomyLine(action: RegisteredAction, effectiveLevel: number): string {
  const required = resolveAutonomyRequirement(action);
  if (required === null) {
    return 'Autonomy requirement depends on the provided parameters and is evaluated when the action is invoked.';
  }
  if (effectiveLevel >= required) {
    return `Unlocked for this role (autonomy ${effectiveLevel} >= required ${required}).`;
  }
  return `NOT AVAILABLE: autonomy ${effectiveLevel} < required ${required}. Do NOT call this action; use \`call_action(name="list_actions")\` to discover alternatives.`;
}

function formatActionEntry(action: RegisteredAction, effectiveLevel: number): string[] {
  return [
    `- ${action.name} — ${action.description}`,
    `  Params: ${action.paramsDoc}`,
    `  Returns: ${action.returnsHint ?? 'the action result'}`,
    `  ${buildAutonomyLine(action, effectiveLevel)}`,
  ];
}

export function buildCallActionDescription(input: BuildCallActionDescriptionInput): string {
  const { role, spaceLevel, agentCeiling, hotActions, registry } = input;
  const effectiveLevel = resolveEffectiveAutonomyLevel({
    spaceLevel: spaceLevel ?? 1,
    agentLevel: agentCeiling ?? null,
  }).level;

  const sections: string[] = [`## ${role} actions`, ''];
  const advertised: RegisteredAction[] = [];

  for (const name of hotActions) {
    const action = registry.get(name);
    if (action == null) continue;
    advertised.push(action);
    if (advertised.length >= 6) break;
  }

  if (advertised.length === 0) {
    sections.push('No suggested hot actions are available for this role.', '');
  } else {
    for (const action of advertised) {
      sections.push(...formatActionEntry(action, effectiveLevel));
      sections.push('');
    }
  }

  sections.push(
    'For the full action catalog, call `call_action(name="list_actions")`. For details on a specific action, call `call_action(name="describe_action", params={ "name": "<action_name>" })`.'
  );

  return sections.join('\n');
}
