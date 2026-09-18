import { AGENT_OPERATION_NAMES } from './operation-names/agent.ts';
import { ARTIFACT_OPERATION_NAMES } from './operation-names/artifacts.ts';
import { AUDIT_OPERATION_NAMES } from './operation-names/audit.ts';
import { CORE_OPERATION_NAMES } from './operation-names/core.ts';
import { DAEMON_OPERATION_NAMES } from './operation-names/daemon.ts';
import { EXTERNAL_EVENT_OPERATION_NAMES } from './operation-names/external-event.ts';
import { FORGE_OPERATION_NAMES } from './operation-names/forge.ts';
import { GOAL_OPERATION_NAMES } from './operation-names/goal.ts';
import { MESSAGING_OPERATION_NAMES } from './operation-names/messaging.ts';
import { NODE_OPERATION_NAMES } from './operation-names/node.ts';
import { SCHEDULE_OPERATION_NAMES } from './operation-names/schedule.ts';
import { SESSION_OPERATION_NAMES } from './operation-names/session.ts';
import { TASK_OPERATION_NAMES } from './operation-names/task.ts';
import { WORKFLOW_OPERATION_NAMES } from './operation-names/workflow.ts';

export const OPERATION_NAME_FAMILIES = {
  agent: AGENT_OPERATION_NAMES,
  artifacts: ARTIFACT_OPERATION_NAMES,
  audit: AUDIT_OPERATION_NAMES,
  core: CORE_OPERATION_NAMES,
  daemon: DAEMON_OPERATION_NAMES,
  externalEvent: EXTERNAL_EVENT_OPERATION_NAMES,
  forge: FORGE_OPERATION_NAMES,
  goal: GOAL_OPERATION_NAMES,
  messaging: MESSAGING_OPERATION_NAMES,
  node: NODE_OPERATION_NAMES,
  schedule: SCHEDULE_OPERATION_NAMES,
  session: SESSION_OPERATION_NAMES,
  task: TASK_OPERATION_NAMES,
  workflow: WORKFLOW_OPERATION_NAMES,
} as const;

export const OPERATION_NAMES = [
  ...AGENT_OPERATION_NAMES,
  ...ARTIFACT_OPERATION_NAMES,
  ...AUDIT_OPERATION_NAMES,
  ...CORE_OPERATION_NAMES,
  ...DAEMON_OPERATION_NAMES,
  ...EXTERNAL_EVENT_OPERATION_NAMES,
  ...FORGE_OPERATION_NAMES,
  ...GOAL_OPERATION_NAMES,
  ...MESSAGING_OPERATION_NAMES,
  ...NODE_OPERATION_NAMES,
  ...SCHEDULE_OPERATION_NAMES,
  ...SESSION_OPERATION_NAMES,
  ...TASK_OPERATION_NAMES,
  ...WORKFLOW_OPERATION_NAMES,
] as const;

export type OperationName = (typeof OPERATION_NAMES)[number];

export function isOperationName(value: string): value is OperationName {
  return (OPERATION_NAMES as readonly string[]).includes(value);
}
