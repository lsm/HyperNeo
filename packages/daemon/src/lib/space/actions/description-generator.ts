export const CODER_HOT_ACTIONS: readonly string[] = [
  'task.create',
  'task.list',
  'task.update',
  'task.message.send',
];

export const GENERAL_HOT_ACTIONS: readonly string[] = [
  'task.create',
  'task.list',
  'workflow.list',
  'task.message.send',
];

export const PLANNER_HOT_ACTIONS: readonly string[] = [
  'task.create',
  'task.list',
  'workflow.list',
  'workflow.get',
  'workflow.suggest',
];

export const RESEARCH_HOT_ACTIONS: readonly string[] = [
  'task.create',
  'task.list',
  'workflow.list',
  'task.message.send',
];

export const REVIEWER_HOT_ACTIONS: readonly string[] = [
  'task.list',
  'workflow.list',
  'task.message.send',
  'artifact.list',
];

export const QA_HOT_ACTIONS: readonly string[] = [
  'task.list',
  'workflow.list',
  'session.get',
  'task.update',
];

export const ROLE_HOT_ACTIONS: Record<string, readonly string[]> = {
  coder: CODER_HOT_ACTIONS,
  general: GENERAL_HOT_ACTIONS,
  planner: PLANNER_HOT_ACTIONS,
  research: RESEARCH_HOT_ACTIONS,
  reviewer: REVIEWER_HOT_ACTIONS,
  qa: QA_HOT_ACTIONS,
};
