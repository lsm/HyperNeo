export { SpaceManager } from './managers/space-manager.ts';
export { SpaceWorkspaceManager } from './managers/space-workspace-manager.ts';
export type { SpaceWorkspaceRecord } from '../../storage/repositories/space-workspace-repository.ts';
export { SpaceWorktreeManager } from './managers/space-worktree-manager.ts';
export type { SpaceWorktreeInfo } from './managers/space-worktree-manager.ts';
export { SpaceWorktreeRepository } from '../../storage/repositories/space-worktree-repository.ts';
export type { SpaceWorktreeRecord } from '../../storage/repositories/space-worktree-repository.ts';
export {
  SpaceTaskManager,
  VALID_SPACE_TASK_TRANSITIONS,
  isValidSpaceTaskTransition,
} from './managers/space-task-manager.ts';
export {
  SpaceWorkflowManager,
  WorkflowValidationError,
  WorkflowDeletionBlockedError,
} from './managers/space-workflow-manager.ts';
export type { SpaceAgentLookup } from './managers/space-workflow-manager.ts';
export { SpaceWorkflowRepository } from '../../storage/repositories/space-workflow-repository.ts';
export { WorkflowHookStateRepository } from '../../storage/repositories/workflow-hook-state-repository.ts';
export { WorkflowHookRuntimeService } from './workflow-hook-runtime-service.ts';
export { validateWorkflowHooks } from './workflow-hook-validation.ts';
export {
  CODING_WORKFLOW,
  RESEARCH_WORKFLOW,
  REVIEW_ONLY_WORKFLOW,
  getBuiltInWorkflows,
  seedBuiltInWorkflows,
} from './workflows/built-in-workflows.ts';
export { WorkflowExecutor } from './runtime/workflow-executor.ts';
export type {
  ConditionContext,
  ConditionResult,
  CommandRunner,
} from './runtime/workflow-executor.ts';
export { SpaceRuntime } from './runtime/space-runtime.ts';
export type { SpaceRuntimeConfig } from './runtime/space-runtime.ts';
export { SpaceRuntimeService } from './runtime/space-runtime-service.ts';
export type { SpaceRuntimeServiceConfig } from './runtime/space-runtime-service.ts';
export { SpaceAgentNotificationService } from './runtime/space-agent-notification-service.ts';
export type { SpaceAgentNotificationServiceConfig } from './runtime/space-agent-notification-service.ts';
export type { SessionFactory } from './runtime/types.ts';
export { TaskAgentManager } from './runtime/task-agent-manager.ts';
export type { TaskAgentManagerConfig } from './runtime/task-agent-manager.ts';
export { SpaceActorRegistryAdapter, SPACE_SYSTEM_ACTORS } from './actor-registry.ts';
export type { SpaceActorRegistryRepositories } from './actor-registry.ts';
export {
  SpaceMessageResolver,
  SpaceDeliveryFacade,
  pendingMessageToMessageRecord,
  pendingMessageToDeliveryRecords,
} from './messaging-adapter.ts';
export type {
  SpaceMessageResolverConfig,
  SpaceMessageResolverContext,
  SpaceDeliveryFacadeConfig,
} from './messaging-adapter.ts';

export { selectWorkflow } from './runtime/workflow-selector.ts';
export type { WorkflowSelectionContext } from './runtime/workflow-selector.ts';

export {
  buildCustomAgentSystemPrompt,
  buildCustomAgentTaskMessage,
  createCustomAgentInit,
  resolveAgentInit,
} from './agents/custom-agent.ts';
export type { CustomAgentConfig, ResolveAgentInitConfig } from './agents/custom-agent.ts';

export { buildSpaceChatSystemPrompt } from './agents/space-chat-agent.ts';
export type {
  SpaceChatAgentContext,
  WorkflowSummary,
  AgentSummary,
} from './agents/space-chat-agent.ts';

export {
  createSpaceAgentToolHandlers,
  createSpaceAgentMcpServer,
} from './tools/space-agent-tools.ts';
export type { SpaceAgentToolsConfig, SpaceAgentMcpServer } from './tools/space-agent-tools.ts';

export {
  exportAgent,
  exportWorkflow,
  exportBundle,
  validateExportedAgent,
  validateExportedWorkflow,
  validateExportBundle,
} from './export-format.ts';
export type { ValidationResult } from './export-format.ts';

export type {
  SpaceWorkflow,
  WorkflowNode,
  WorkflowNodeInput,
  CreateSpaceWorkflowParams,
  UpdateSpaceWorkflowParams,
} from '@hyperneo/shared';
