import type { ActorResolver } from '../../../../../messaging/src/contracts.ts';
import type { ActorRef, MessageRecord } from '../../../../../messaging/src/types.ts';
import type { McpAuditLogRepository } from '../../../storage/repositories/mcp-audit-log-repository.ts';
import type { NodeExecutionRepository } from '../../../storage/repositories/node-execution-repository.ts';
import type { SpaceAgentGoalScopeRepository } from '../../../storage/repositories/space-agent-goal-scope-repository.ts';
import type { SpaceAgentReminderRepository } from '../../../storage/repositories/space-agent-reminder-repository.ts';
import type { SpaceAgentSubscriptionRepository } from '../../../storage/repositories/space-agent-subscription-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../../storage/repositories/space-workflow-run-repository.ts';
import type { Database as BunDatabase } from '../../../storage/sqlite-compat.ts';
import type { ExternalEventStore } from '../../external-events/external-event-store.ts';
import type { DaemonInternalEventMap, InternalEventBus } from '../../internal-event-bus.ts';
import type { SessionManager } from '../../session/session-manager.ts';
import type { EnsureSessionOutcome, SessionTarget } from '../../session-resolution/target.ts';
import { type OwnedAgentLookup } from '../../agents/unified-agent-events.ts';
import type { SpaceManager } from '../managers/space-manager.ts';
import type { SpaceTaskManager } from '../../tasks/task-manager.ts';
import type { SpaceWorkflowManager } from '../../workflows/workflow-manager.ts';
import type { ReplyRoutingRegistry } from '../../messaging/reply-routing-registry.ts';
import type { SpaceMcpSessionRole } from '../runtime/space-mcp-session-policy.ts';
import type { SpaceRuntime } from '../runtime/space-runtime.ts';
import type { TaskAgentManager } from '../runtime/task-agent-manager.ts';

export interface SpaceAgentToolsConfig {
  spaceId: string;
  db?: BunDatabase;
  longHorizonAgentRepo?: SpaceLongHorizonAgentRepository;
  goalScopeRepo?: SpaceAgentGoalScopeRepository;
  subscriptionRepo?: SpaceAgentSubscriptionRepository;
  reminderRepo?: SpaceAgentReminderRepository;
  runtime: SpaceRuntime;
  workflowManager: SpaceWorkflowManager;
  spaceManager?: Pick<
    SpaceManager,
    'getSpace' | 'resolveWorkspaceSelection' | 'validateDefaultTaskWorkspace'
  >;
  taskRepo: SpaceTaskRepository;
  nodeExecutionRepo: NodeExecutionRepository;
  workflowRunRepo: SpaceWorkflowRunRepository;
  isWorkflowRunActive?: (runId: string) => boolean;
  taskManager: SpaceTaskManager;
  sessionManager?: Pick<SessionManager, 'getCachedSession' | 'getSessionAsync' | 'sendUserMessage'>;
  clearLongTermAgentSessionProvider?: (spaceId: string, agentId: string) => Promise<void>;
  taskAgentManager?: TaskAgentManager;
  internalEventBus?: InternalEventBus<DaemonInternalEventMap>;
  ownedAgents?: OwnedAgentLookup;
  activateNode?: (runId: string, nodeId: string) => Promise<void>;
  ensureTargetSession?: (target: SessionTarget) => Promise<EnsureSessionOutcome>;
  getSpaceAutonomyLevel?: (spaceId: string) => Promise<number>;
  myAgentName?: string;
  myAgentNameAliases?: string[];
  myAgentId?: string;
  mySessionId?: string;
  callerRole?: SpaceMcpSessionRole;

  onRestoreNodeAgent?: (args: { reason?: string }) => Promise<void> | void;
  auditLogRepo?: McpAuditLogRepository;
  scheduleService?: import('../../schedule/schedule-service.ts').ScheduleService;
  replyRoutingRegistry?: ReplyRoutingRegistry;
  goalService?: import('../../goals/service.ts').SpaceGoalService;
  evolutionScopeService?: import('../../evolution/scope-service.ts').EvolutionScopeService;
  goalRepo?: import('../../../storage/repositories/space-goal-repository.ts').SpaceGoalRepository;
  messageResolver?: ActorResolver;
  longTermAgentDelivery?: {
    deliverToSession?: (
      actor: ActorRef,
      message: MessageRecord
    ) => Promise<string | null | undefined>;
    queueForActivation?: (
      actor: ActorRef,
      message: MessageRecord
    ) => Promise<string | null | undefined>;
  };
  externalEventStore?: ExternalEventStore;
  inactivityConfigRepo?: import('../../../storage/repositories/space-agent-inactivity-repository.ts').SpaceAgentInactivityConfigRepository;
  inactivityClaimRepo?: import('../../../storage/repositories/space-agent-inactivity-repository.ts').SpaceAgentInactivityClaimRepository;
  inactivityRunNow?: (spaceId: string, agentId: string) => Promise<void>;
  templateManager?: import('../../agents/template-manager.ts').SpaceAgentTemplateManager;
}
