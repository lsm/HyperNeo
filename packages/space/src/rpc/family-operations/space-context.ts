import type { ExternalEventStore } from '../../external-events/external-event-store.ts';
import type { SpaceLongHorizonAgent } from '@hyperneo/shared';
import type { DirectTaskWorkerIdentity } from '../../../../daemon/src/lib/tasks/direct-task-worker-identity.ts';
import type { ChannelCycleRepository } from '../../../../daemon/src/storage/repositories/channel-cycle-repository.ts';
import type { NodeExecutionRepository } from '../../../../daemon/src/storage/repositories/node-execution-repository.ts';
import type { SpaceAgentGoalScopeRepository } from '../../../../daemon/src/storage/repositories/space-agent-goal-scope-repository.ts';
import type {
  SpaceAgentInactivityClaimRepository,
  SpaceAgentInactivityConfigRepository,
} from '../../../../daemon/src/storage/repositories/space-agent-inactivity-repository.ts';
import type { SpaceAgentReminderRepository } from '../../../../daemon/src/storage/repositories/space-agent-reminder-repository.ts';
import type { SpaceAgentRepository } from '../../../../daemon/src/storage/repositories/space-agent-repository.ts';
import type { SpaceAgentSubscriptionRepository } from '../../../../daemon/src/storage/repositories/space-agent-subscription-repository.ts';
import type { SpaceSessionEventSubscriptionRepository } from '../../../../daemon/src/storage/repositories/space-session-event-subscription-repository.ts';
import type { SpaceAgentTemplateRepository } from '../../../../daemon/src/storage/repositories/space-agent-template-repository.ts';
import type { SpaceGoalEventRepository } from '../../../../daemon/src/storage/repositories/space-goal-event-repository.ts';
import type { SpaceGoalRepository } from '../../../../daemon/src/storage/repositories/space-goal-repository.ts';
import type { SpaceLongHorizonAgentRepository } from '../../../../daemon/src/storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceTaskRepository } from '../../../../daemon/src/storage/repositories/space-task-repository.ts';
import type { SpaceWorkflowRepository } from '../../../../daemon/src/storage/repositories/space-workflow-repository.ts';
import type { SpaceWorkflowRunRepository } from '../../../../daemon/src/storage/repositories/space-workflow-run-repository.ts';
import type { TaskScheduleRepository } from '../../../../daemon/src/storage/repositories/task-schedule-repository.ts';
import type { WorkflowRunArtifactRepository } from '../../../../daemon/src/storage/repositories/workflow-run-artifact-repository.ts';
import type { SpaceAgentTemplateManager } from '../../../../daemon/src/lib/agents/template-manager.ts';
import type { EvolutionEpisodeService } from '../../evolution/episode-service.ts';
import type { EvolutionScopeService } from '../../evolution/scope-service.ts';
import type { GoalAutomationService } from '../../goals/automation-service.ts';
import type { SpaceGoalService } from '../../goals/service.ts';
import type { ReplyRoutingRegistry } from '../../../../daemon/src/lib/messaging/reply-routing-registry.ts';
import type { ScheduleService } from '../../../../daemon/src/lib/schedule/schedule-service.ts';
import type { SpaceRuntimeService } from '../../runtime/space-runtime-service.ts';
import type { TaskAgentManager } from '../../../../daemon/src/lib/space/runtime/task-agent-manager.ts';
import type { SpaceTaskManager } from '../../../../daemon/src/lib/tasks/task-manager.ts';
import type { CodingArtifactProfile } from '../../../../daemon/src/lib/workflows/coding-artifact-profile.ts';
import type { SpaceWorkflowManager } from '../../../../daemon/src/lib/workflows/workflow-manager.ts';
import type { SpaceManager } from '../../managers/space-manager.ts';
import type { FamilyOperationContext } from '../../../../daemon/src/lib/rpc-handlers/family-operations/context.ts';

export interface SpaceFamilyContext extends FamilyOperationContext {
  readonly spaceManager: SpaceManager;
  readonly externalEventStore: ExternalEventStore;
  readonly spaceRuntimeService: SpaceRuntimeService;
  readonly taskAgentManager: TaskAgentManager;
  readonly spaceTaskManagerFactory: (spaceId: string) => SpaceTaskManager;
  readonly spaceTaskRepo: SpaceTaskRepository;
  readonly nodeExecutionRepo: NodeExecutionRepository;
  readonly longHorizonAgentRepo: SpaceLongHorizonAgentRepository;
  readonly spaceAgentRepo: SpaceAgentRepository;
  readonly spaceAgentGoalScopeRepo: SpaceAgentGoalScopeRepository;
  readonly spaceAgentTemplateRepo: SpaceAgentTemplateRepository;
  readonly spaceAgentTemplateManager: SpaceAgentTemplateManager;
  readonly spaceAgentReminderRepo: SpaceAgentReminderRepository;
  readonly spaceAgentSubscriptionRepo: SpaceAgentSubscriptionRepository;
  readonly hasDirectWorkerProvenance: (sessionId: string) => boolean;
  readonly resolveDirectWorker: (sessionId: string) => DirectTaskWorkerIdentity | null;
  readonly spaceSessionEventSubscriptionRepo: SpaceSessionEventSubscriptionRepository;
  readonly spaceAgentInactivityConfigRepo: SpaceAgentInactivityConfigRepository;
  readonly spaceAgentInactivityClaimRepo: SpaceAgentInactivityClaimRepository;
  readonly spaceGoalService: SpaceGoalService;
  readonly spaceGoalRepo: SpaceGoalRepository;
  readonly spaceGoalEventRepo: SpaceGoalEventRepository;
  readonly goalAutomationService: GoalAutomationService;
  readonly evolutionScopeService: EvolutionScopeService;
  readonly evolutionEpisodeService: EvolutionEpisodeService;
  readonly scheduleService: ScheduleService;
  readonly taskScheduleRepo: TaskScheduleRepository;
  readonly spaceWorkflowRepo: SpaceWorkflowRepository;
  readonly spaceWorkflowRunRepo: SpaceWorkflowRunRepository;
  readonly spaceWorkflowManager: SpaceWorkflowManager;
  readonly artifactRepo: WorkflowRunArtifactRepository;
  readonly artifactProfile: CodingArtifactProfile;
  readonly channelCycleRepo: ChannelCycleRepository;
  readonly replyRoutingRegistry: ReplyRoutingRegistry;
  readonly archiveAgentSessions?: (
    agent: SpaceLongHorizonAgent
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
}
