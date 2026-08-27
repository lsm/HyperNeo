import {
  ChangePlanSchema,
  GetSessionDetailSchema,
  GetSessionMessagesSchema,
  GetWorkflowDetailSchema,
  GetWorkflowRunSchema,
  InterruptSessionSchema,
  ListSessionsSchema,
  ListWorkflowsSchema,
  SendSessionMessageSchema,
  SuggestWorkflowSchema,
  UpdateSessionStateSchema,
} from '../tools/space-agent-tool-schemas.ts';
import {
  createSpaceAgentToolHandlers,
  type SpaceAgentToolsConfig,
} from '../tools/space-agent-tools.ts';
import { SESSION_WRITE_AUTONOMY_LEVEL } from '../tools/tool-admission-gates.ts';
import { type ActionDefinition, defineAction } from './registry.ts';

export function createSpaceRegistryEntries(config: SpaceAgentToolsConfig): ActionDefinition[] {
  const handlers = createSpaceAgentToolHandlers({ ...config, auditLogRepo: undefined });

  const sessionEntries: ActionDefinition[] = [
    defineAction({
      name: 'list_sessions',
      family: 'sessions',
      safetyClass: 'read',
      description:
        'List ad-hoc and worker sessions in this space; returns summaries with derived status, type, workspace, and git branch.',
      paramsDoc: 'status?, type?, limit? (max 100, default 50), offset? (default 0)',
      paramsSchema: ListSessionsSchema,
      handler: (args) => handlers.list_sessions(args),
    }),
    defineAction({
      name: 'get_session_detail',
      family: 'sessions',
      safetyClass: 'read',
      description:
        'Inspect one session including parsed processing_state and its last messages; returns the full session summary.',
      paramsDoc: 'session_id',
      paramsSchema: GetSessionDetailSchema,
      handler: (args) => handlers.get_session_detail(args),
    }),
    defineAction({
      name: 'get_session_messages',
      family: 'sessions',
      safetyClass: 'read',
      description:
        'Read one session conversation with per-message summaries; returns newest-first messages and a pagination cursor.',
      paramsDoc:
        'session_id, limit? (max 100, default 20), before? (timestamp or timestamp|id cursor)',
      paramsSchema: GetSessionMessagesSchema,
      handler: (args) => handlers.get_session_messages(args),
    }),
    defineAction({
      name: 'send_session_message',
      family: 'sessions',
      safetyClass: 'mutate',
      description:
        'Send a user message to an ad-hoc session and optionally clear a pending question; returns the delivery result.',
      paramsDoc: 'session_id, message, answer_question?',
      paramsSchema: SendSessionMessageSchema,
      handler: (args) => handlers.send_session_message(args),
    }),
    defineAction({
      name: 'update_session_state',
      family: 'sessions',
      safetyClass: 'mutate',
      description:
        'Force a stuck session processing_state to idle, running, or waiting_for_input; returns previous and new state.',
      paramsDoc:
        'session_id, processing_state (idle|running|waiting_for_input), clear_pending_question?',
      paramsSchema: UpdateSessionStateSchema,
      autonomyRequirement: SESSION_WRITE_AUTONOMY_LEVEL,
      handler: (args) => handlers.update_session_state(args),
    }),
    defineAction({
      name: 'interrupt_session',
      family: 'sessions',
      safetyClass: 'destructive',
      description:
        'Force-interrupt a running or stuck session and reset it to idle; returns whether the interrupt was delivered.',
      paramsDoc: 'session_id, reason?',
      paramsSchema: InterruptSessionSchema,
      autonomyRequirement: SESSION_WRITE_AUTONOMY_LEVEL,
      handler: (args) => handlers.interrupt_session(args),
    }),
  ];

  const workflowEntries: ActionDefinition[] = [
    defineAction({
      name: 'list_workflows',
      family: 'workflows',
      safetyClass: 'read',
      description:
        'List every workflow in this space; returns summaries with id, handle, description, tags, and node count.',
      paramsDoc: 'none',
      paramsSchema: ListWorkflowsSchema,
      handler: () => handlers.list_workflows(),
    }),
    defineAction({
      name: 'get_workflow_run',
      family: 'workflows',
      safetyClass: 'read',
      description:
        'Check one workflow run including its current step; returns the run record and its node executions.',
      paramsDoc: 'run_id',
      paramsSchema: GetWorkflowRunSchema,
      handler: (args) => handlers.get_workflow_run(args),
    }),
    defineAction({
      name: 'change_plan',
      family: 'workflows',
      safetyClass: 'destructive',
      description:
        'Update an active run description, or switch it to another workflow (cancels the run and starts a new one); returns the affected run(s).',
      paramsDoc: 'run_id, plus description? and/or workflow_id?/workflow_handle?',
      paramsSchema: ChangePlanSchema,
      handler: (args) => handlers.change_plan(args),
    }),
    defineAction({
      name: 'get_workflow_detail',
      family: 'workflows',
      safetyClass: 'read',
      description:
        'Read one workflow definition including steps, transitions, and rules; returns the full workflow record.',
      paramsDoc: 'workflow_id? or workflow_handle? (one required)',
      paramsSchema: GetWorkflowDetailSchema,
      handler: (args) => handlers.get_workflow_detail(args),
    }),
    defineAction({
      name: 'suggest_workflow',
      family: 'workflows',
      safetyClass: 'read',
      description:
        'List all enabled workflows unranked for a described piece of work; returns id, handle, description, tags, and node count.',
      paramsDoc: 'description (context only — every workflow is returned)',
      paramsSchema: SuggestWorkflowSchema,
      handler: (args) => handlers.suggest_workflow(args),
    }),
  ];

  const entries = config.db ? [...sessionEntries, ...workflowEntries] : [...workflowEntries];
  return config.taskAgentManager
    ? entries
    : entries.filter((entry) => entry.name !== 'send_message_to_task');
}
