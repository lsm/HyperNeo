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
