import type {
  CreateSpaceWorkerAgentParams,
  CreateSpaceGoalParams,
  CreateSpaceTaskParams,
  CreateSpaceWorkflowParams,
  CreateSpaceLongHorizonAgentReminderParams,
  CreateSpaceLongHorizonAgentSubscriptionParams,
  LiveQueryDeltaEvent,
  LiveQuerySnapshotEvent,
  MessageImage,
  MessageDeliveryMode,
  NodeExecution,
  PaginatedSpaceTaskResult,
  RuntimeState,
  Space,
  SpaceWorkerAgent,
  SpaceWorkerAgentPromotionDraft,
  SpaceWorkerAgentSyncPreview,
  SpaceBlockReason,
  SpaceGoal,
  SpaceGoalEvent,
  SpaceGoalListParams,
  SpaceGoalOwnerResolution,
  SpaceLongHorizonAgent,
  SpaceLongHorizonAgentEventSubscription,
  SpaceLongHorizonAgentReminder,
  SpaceLongHorizonAgentTemplate,
  SpaceTask,
  SpaceTaskActivityMember,
  SpaceTaskPriority,
  SpaceTaskStatus,
  SpaceWorkflow,
  SpaceWorkflowRun,
  SpaceWorkflowSummary,
  TaskSchedule,
  TaskScheduleStatus,
  TaskScheduleTriggerType,
  UpdateSpaceWorkerAgentParams,
  UpdateSpaceLongHorizonAgentParams,
  UpdateSpaceLongHorizonAgentSubscriptionParams,
  UpdateSpaceGoalParams,
  UpdateSpaceParams,
  UpdateSpaceTaskParams,
  UpdateSpaceWorkflowParams,
  WorkflowRunArtifact,
  SpaceWorkflowSyncPreview,
} from '@hyperneo/shared';
import { isUUID, Logger } from '@hyperneo/shared';
import { computed, signal } from '@preact/signals';
import { connectionManager } from './connection-manager';
import { currentSpaceCanonicalIdSignal, currentSpaceIdSignal } from './signals';

const logger = new Logger('hyperneo:web:spacestore');

export interface SpaceSessionSummary {
  id: string;
  title: string;
  status: string;
  type: string;
  lastActiveAt: number;
}

export interface SpaceSessionRow {
  id: string;
  title: string;
  status: string;
  processingState?: string;
  messageCount?: number;
  lastActiveAt: number;
}

export interface SpaceWithTasks extends Space {
  tasks: SpaceTask[];
  sessions: SpaceSessionSummary[];
}

export type ExternalEventDeliveryStatus = 'pending' | 'delivered' | 'failed';

export interface QueueAgeStats {
  count: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  p95Ms: number;
}

export interface QueueHealthCounters {
  since: number;
  enqueue: number;
  enqueueBySource: Record<string, number>;
  enqueueByTargetState: Record<string, number>;
  flushAttempts: number;
  flushItemsDispatched: number;
  delivered: number;
  finalFailuresByReason: Record<string, number>;
  claimConflicts: number;
  staleSessionSkips: number;
  pausedSpaceSkips: number;
  cooldownSkips: number;
}

export interface QueueHealthGauges {
  queueDepth: number;
  queueKeys: number;
  inFlight: number;
  digestBacklog: number;
  retryTimers: number;
  persistedPending: number;
  queueAgeMs: QueueAgeStats | null;
  persistedAgeMs: QueueAgeStats | null;
}

export type QueueHealthFailureCategory =
  | 'ttl_expired'
  | 'cap_eviction'
  | 'deliverability'
  | 'retry_exhausted'
  | 'injection_error'
  | 'other';

export interface QueueHealthSnapshot {
  collectedAt: number;
  counters: QueueHealthCounters;
  failuresByCategory: Record<QueueHealthFailureCategory, number>;
  gauges: QueueHealthGauges;
}

export interface SpaceExternalEventDeliveryLogRecord {
  eventId: string;
  deliveryKey: string;
  workflowRunId: string;
  taskId: string;
  nodeId: string;
  agentName: string;
  state: ExternalEventDeliveryStatus;
  failureReason: string | null;
  deliveredAt: number | null;
  updatedAt: number;
  event: {
    id: string;
    spaceId: string;
    topic: string;
    occurredAt: number;
    ingestedAt: number;
    source: string;
    sourceEventId?: string;
    summary: string;
    externalUrl?: string;
    payload: Record<string, unknown>;
    dedupeKey: string;
  };
  eventState: string;
  eventCreatedAt: number;
  eventUpdatedAt: number;
}

export interface SpaceWorkerAgentTemplate {
  name: string;
  description: string;
  tools: string[];
  customPrompt: string;
  templateHash?: string | null;
}

function workflowToSummary(wf: SpaceWorkflow): SpaceWorkflowSummary {
  return {
    id: wf.id,
    spaceId: wf.spaceId,
    name: wf.name,
    description: wf.description,
    tags: wf.tags,
    templateName: wf.templateName,
    templateHash: wf.templateHash ?? null,
    disabled: wf.disabled,
    handle: wf.handle,
    nodeCount: wf.nodes?.length ?? 0,
    completionAutonomyLevel: wf.completionAutonomyLevel,
    createdAt: wf.createdAt,
    updatedAt: wf.updatedAt,
  };
}
class SpaceStore {
  readonly spaces = signal<Space[]>([]);

  readonly spacesWithTasks = signal<SpaceWithTasks[]>([]);

  readonly spaceId = signal<string | null>(null);

  readonly space = signal<Space | null>(null);

  readonly tasks = signal<SpaceTask[]>([]);

  readonly workflowRuns = signal<SpaceWorkflowRun[]>([]);

  readonly agents = signal<SpaceWorkerAgent[]>([]);

  readonly agentTemplates = signal<SpaceWorkerAgentTemplate[]>([]);

  readonly longHorizonAgents = signal<SpaceLongHorizonAgent[]>([]);

  readonly longHorizonAgentTemplates = signal<SpaceLongHorizonAgentTemplate[]>([]);

  readonly workflows = signal<SpaceWorkflowSummary[]>([]);

  readonly workflowDetails = signal<SpaceWorkflow[]>([]);

  readonly workflowTemplates = signal<SpaceWorkflow[]>([]);

  readonly runtimeState = signal<RuntimeState | null>(null);

  readonly schedules = signal<TaskSchedule[]>([]);

  readonly goals = signal<SpaceGoal[]>([]);

  readonly goalEvents = signal<Map<string, SpaceGoalEvent[]>>(new Map());

  readonly goalOwners = signal<Map<string, SpaceGoalOwnerResolution>>(new Map());

  readonly taskActivity = signal<Map<string, SpaceTaskActivityMember[]>>(new Map());

  readonly taskMessageActivity = signal<Map<string, number>>(new Map());

  readonly loading = signal<boolean>(false);

  readonly error = signal<string | null>(null);

  readonly configDataLoaded = signal<boolean>(false);

  readonly nodeExecLoaded = signal<boolean>(false);

  readonly sessions = signal<SpaceSessionRow[]>([]);

  updateSession(sessionId: string, patch: Partial<Omit<SpaceSessionRow, 'id'>>): void {
    this.sessions.value = this.sessions.value.map((s) =>
      s.id === sessionId ? { ...s, ...patch } : s
    );
  }

  private spaceSessionsCleanupFns: Array<() => void> = [];

  private activeSpaceSessionsSubscriptionId: string | null = null;

  private updateRuntimeState(space: Space): void {
    if (space.status === 'archived') {
      this.runtimeState.value = 'stopped';
      return;
    }
    if (space.stopped) {
      this.runtimeState.value = 'stopped';
      return;
    }
    this.runtimeState.value = space.paused ? 'paused' : 'running';
  }

  readonly activeTasks = computed(() => this.tasks.value.filter((t) => t.status === 'in_progress'));

  readonly activeRuns = computed(() =>
    this.workflowRuns.value.filter((r) => r.status === 'pending' || r.status === 'in_progress')
  );

  readonly tasksByRun = computed(() => {
    const map = new Map<string, SpaceTask[]>();
    for (const task of this.tasks.value) {
      if (task.workflowRunId) {
        const existing = map.get(task.workflowRunId) ?? [];
        map.set(task.workflowRunId, [...existing, task]);
      }
    }
    return map;
  });

  readonly standaloneTasks = computed(() => this.tasks.value.filter((t) => !t.workflowRunId));

  readonly nodeExecutions = signal<NodeExecution[]>([]);

  readonly nodeExecutionsByNodeId = computed(() => {
    const map = new Map<string, NodeExecution[]>();
    for (const exec of this.nodeExecutions.value) {
      let arr = map.get(exec.workflowNodeId);
      if (!arr) {
        arr = [];
        map.set(exec.workflowNodeId, arr);
      }
      arr.push(exec);
    }
    return map;
  });

  private selectPromise: Promise<void> = Promise.resolve();

  private cleanupFunctions: Array<() => void> = [];

  private activeSpaceChannel: string | null = null;

  private globalListInitialized = false;

  private globalListCleanupFns: Array<() => void> = [];

  private taskActivityCleanupFns: Array<() => void> = [];

  private activeTaskActivityTaskId: string | null = null;

  private activeTaskActivitySubscriptionIds = new Set<string>();

  private taskMessageActivityCleanupFns: Array<() => void> = [];

  private activeTaskMessageActivityTaskId: string | null = null;

  private activeTaskMessageActivitySubscriptionIds = new Set<string>();

  private nodeExecCleanupFns: Array<() => void> = [];

  private activeNodeExecSubscriptionIds = new Set<string>();

  private activeNodeExecRunId: string | null = null;

  private nodeExecLoadGen = 0;

  private goalListRequestVersion = 0;

  private configDataPromise: Promise<void> | null = null;

  private nodeExecPromise: Promise<void> | null = null;

  private workflowDetailCache = new Map<string, SpaceWorkflow>();

  private workflowDetailPromises = new Map<string, Promise<SpaceWorkflow | null>>();

  private workflowDetailFetchGens = new Map<string, number>();

  private workflowSummariesLoaded = false;

  private workflowDetailsRetryCount = 0;

  private workflowDetailsRetryPending = false;

  private workflowDetailsLoadGeneration = 0;

  readonly workflowVersions = signal<Map<string, number>>(new Map());

  private upsertLongHorizonAgent(agent: SpaceLongHorizonAgent): void {
    const idx = this.longHorizonAgents.value.findIndex((current) => current.id === agent.id);
    if (idx >= 0) {
      this.longHorizonAgents.value = [
        ...this.longHorizonAgents.value.slice(0, idx),
        agent,
        ...this.longHorizonAgents.value.slice(idx + 1),
      ];
    } else {
      this.longHorizonAgents.value = [...this.longHorizonAgents.value, agent];
    }
  }

  private upsertTaskOnePerRun(tasks: SpaceTask[], task: SpaceTask): SpaceTask[] {
    const withoutSameId = tasks.filter((current) => current.id !== task.id);
    if (!task.workflowRunId) {
      return [...withoutSameId, task].sort((a, b) => b.updatedAt - a.updatedAt);
    }

    const sameRun = withoutSameId.filter((current) => current.workflowRunId === task.workflowRunId);
    const others = withoutSameId.filter((current) => current.workflowRunId !== task.workflowRunId);
    const runTitle =
      this.workflowRuns.value
        .find((run) => run.id === task.workflowRunId)
        ?.title?.trim()
        .toLowerCase() ?? null;
    const merged = [...sameRun, task];
    const canonical = merged.find((candidate) => {
      if (!runTitle) return false;
      return candidate.title.trim().toLowerCase() === runTitle;
    });
    const fallback =
      canonical ??
      [...merged].sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
        return a.taskNumber - b.taskNumber;
      })[0];
    return [...others, fallback].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  private removeTaskOnePerRun(tasks: SpaceTask[], task: SpaceTask): SpaceTask[] {
    return tasks.filter(
      (current) =>
        current.id !== task.id &&
        (!task.workflowRunId || current.workflowRunId !== task.workflowRunId)
    );
  }

  async initGlobalList(): Promise<void> {
    if (this.globalListInitialized) return;
    this.globalListInitialized = true;

    for (const cleanup of this.globalListCleanupFns) {
      try {
        cleanup();
      } catch {}
    }
    this.globalListCleanupFns = [];

    try {
      const hub = await connectionManager.getHub();
      const enriched = await hub.request<SpaceWithTasks[]>('space.listWithTasks', {});
      const spaces = (enriched ?? []).map(
        ({ tasks: _tasks, sessions: _sessions, ...space }) => space
      );
      this.spaces.value = spaces;
      this.spacesWithTasks.value = enriched ?? [];

      this.globalListCleanupFns.push(
        hub.onEvent<{ spaceId: string; space: Space }>('space.created', (event) => {
          if (event.space) {
            const exists = this.spaces.value.some((s) => s.id === event.spaceId);
            if (!exists) {
              this.spaces.value = [...this.spaces.value, event.space];
              this.spacesWithTasks.value = [
                ...this.spacesWithTasks.value,
                { ...event.space, tasks: [], sessions: [] },
              ];
            }
          }
        })
      );

      this.globalListCleanupFns.push(
        hub.onEvent<{ spaceId: string; space?: Partial<Space> }>('space.updated', (event) => {
          this.spaces.value = this.spaces.value.map((s) =>
            s.id === event.spaceId ? ({ ...s, ...event.space } as Space) : s
          );
          this.spacesWithTasks.value = this.spacesWithTasks.value.map((s) =>
            s.id === event.spaceId ? ({ ...s, ...event.space } as SpaceWithTasks) : s
          );
        })
      );

      this.globalListCleanupFns.push(
        hub.onEvent<{ spaceId: string; space: Space }>('space.archived', (event) => {
          this.spaces.value = this.spaces.value.map((s) =>
            s.id === event.spaceId ? event.space : s
          );
          this.spacesWithTasks.value = this.spacesWithTasks.value.map((s) =>
            s.id === event.spaceId
              ? ({ ...event.space, tasks: s.tasks, sessions: s.sessions } as SpaceWithTasks)
              : s
          );
        })
      );

      this.globalListCleanupFns.push(
        hub.onEvent<{ spaceId: string }>('space.deleted', (event) => {
          this.spaces.value = this.spaces.value.filter((s) => s.id !== event.spaceId);
          this.spacesWithTasks.value = this.spacesWithTasks.value.filter(
            (s) => s.id !== event.spaceId
          );
        })
      );

      this.globalListCleanupFns.push(
        hub.onEvent<{
          sessionId: string;
          spaceId: string;
          taskId: string;
          task: SpaceTask;
        }>('space.task.created', (event) => {
          const swt = this.spacesWithTasks.value;
          const idx = swt.findIndex((s) => s.id === event.spaceId);
          if (idx >= 0) {
            if (event.task.status !== 'done' && event.task.status !== 'cancelled') {
              const nextTasks = this.upsertTaskOnePerRun(swt[idx].tasks, event.task);
              this.spacesWithTasks.value = [
                ...swt.slice(0, idx),
                { ...swt[idx], tasks: nextTasks },
                ...swt.slice(idx + 1),
              ];
            }
          }
        })
      );

      this.globalListCleanupFns.push(
        hub.onEvent<{
          sessionId: string;
          spaceId: string;
          taskId: string;
          task: SpaceTask;
        }>('space.task.updated', (event) => {
          const swt = this.spacesWithTasks.value;
          const idx = swt.findIndex((s) => s.id === event.spaceId);
          if (idx >= 0) {
            const spaceTasks = swt[idx].tasks;
            if (event.task.status === 'done' || event.task.status === 'cancelled') {
              const updated = this.removeTaskOnePerRun(spaceTasks, event.task);
              this.spacesWithTasks.value = [
                ...swt.slice(0, idx),
                { ...swt[idx], tasks: updated },
                ...swt.slice(idx + 1),
              ];
            } else {
              const updated = this.upsertTaskOnePerRun(spaceTasks, event.task);
              this.spacesWithTasks.value = [
                ...swt.slice(0, idx),
                { ...swt[idx], tasks: updated },
                ...swt.slice(idx + 1),
              ];
            }
          }
        })
      );
    } catch (err) {
      logger.error('Failed to initialize global space list:', err);
      this.globalListInitialized = false;
    }
  }

  selectSpace(spaceId: string | null): Promise<void> {
    this.selectPromise = this.selectPromise
      .then(() => this.doSelect(spaceId))
      .catch((err) => {
        logger.error('selectSpace chain error:', err);
      });
    return this.selectPromise;
  }

  clearSpace(): Promise<void> {
    return this.selectSpace(null);
  }

  private async doSelect(spaceIdOrSlug: string | null): Promise<void> {
    if (this.spaceId.value === spaceIdOrSlug) {
      return;
    }

    this.stopSubscriptions();
    if (this.activeSpaceChannel) {
      const hub = connectionManager.getHubIfConnected();
      if (hub) {
        hub.leaveChannel(this.activeSpaceChannel);
      }
      this.activeSpaceChannel = null;
    }

    this.space.value = null;
    this.tasks.value = [];
    this.workflowRuns.value = [];
    this.agents.value = [];
    this.agentTemplates.value = [];
    this.longHorizonAgents.value = [];
    this.longHorizonAgentTemplates.value = [];
    this.workflows.value = [];
    this.workflowSummariesLoaded = false;
    this.workflowDetails.value = [];
    this.workflowDetailsLoaded.value = false;
    this.workflowDetailsPromise = null;
    this.workflowTemplates.value = [];
    this.nodeExecutions.value = [];
    this.runtimeState.value = null;
    this.taskActivity.value = new Map();
    this.taskMessageActivity.value = new Map();
    this.error.value = null;
    this.configDataLoaded.value = false;
    this.configDataPromise = null;
    this.nodeExecLoaded.value = false;
    this.nodeExecPromise = null;
    this.activeNodeExecRunId = null;
    this.sessions.value = [];
    this.schedules.value = [];
    this.goals.value = [];
    this.goalEvents.value = new Map();
    this.goalOwners.value = new Map();
    this.clearWorkflowDetailCache();
    this.workflowVersions.value = new Map();
    this.disposeSpaceSessionsSubscription();

    this.spaceId.value = spaceIdOrSlug;

    if (spaceIdOrSlug) {
      this.loading.value = true;
      try {
        const resolvedId = await this.fetchAndResolveSpace(spaceIdOrSlug);
        if (resolvedId) {
          if (resolvedId !== spaceIdOrSlug) {
            this.spaceId.value = resolvedId;
            if (currentSpaceIdSignal.value === spaceIdOrSlug) {
              currentSpaceCanonicalIdSignal.value = resolvedId;
            }
          }
          this.listGoals({ includeArchived: false }).catch((err) => {
            logger.warn('Failed to fetch space goals:', err);
          });
          await this.startSubscriptions(resolvedId);
        }
      } catch (err) {
        logger.error('Failed to start space subscriptions:', err);
        this.error.value = err instanceof Error ? err.message : 'Failed to load space';
      } finally {
        this.loading.value = false;
      }
    }
  }

  private async startSubscriptions(spaceId: string): Promise<void> {
    const hub = await connectionManager.getHub();

    const spaceChannel = `space:${spaceId}`;
    hub.joinChannel(spaceChannel);
    this.activeSpaceChannel = spaceChannel;

    const unsubSpaceUpdated = hub.onEvent<{
      sessionId: string;
      spaceId: string;
      space?: Partial<Space>;
    }>('space.updated', (event) => {
      if (event.spaceId === spaceId && event.space && this.space.value) {
        const updated = { ...this.space.value, ...event.space } as Space;
        this.space.value = updated;
        this.updateRuntimeState(updated);
      }
    });
    this.cleanupFunctions.push(unsubSpaceUpdated);

    this.subscribeSpaceSessions(hub, spaceId);

    const unsubSpaceArchived = hub.onEvent<{
      sessionId: string;
      spaceId: string;
      space: Space;
    }>('space.archived', (event) => {
      if (event.spaceId === spaceId) {
        this.selectPromise = this.selectPromise
          .then(() => {
            if (this.spaceId.value === spaceId) {
              return this.doSelect(null);
            }
          })
          .catch((err) => {
            logger.error('Failed to clear space after external archive:', err);
          });
      }
    });
    this.cleanupFunctions.push(unsubSpaceArchived);

    const unsubSpaceDeleted = hub.onEvent<{
      sessionId: string;
      spaceId: string;
    }>('space.deleted', (event) => {
      if (event.spaceId === spaceId) {
        this.selectPromise = this.selectPromise
          .then(() => {
            if (this.spaceId.value === spaceId) {
              return this.doSelect(null);
            }
          })
          .catch((err) => {
            logger.error('Failed to clear space after external delete:', err);
          });
      }
    });
    this.cleanupFunctions.push(unsubSpaceDeleted);

    const unsubTaskCreated = hub.onEvent<{
      sessionId: string;
      spaceId: string;
      taskId: string;
      task: SpaceTask;
    }>('space.task.created', (event) => {
      if (event.spaceId === spaceId) {
        this.tasks.value = this.upsertTaskOnePerRun(this.tasks.value, event.task);
      }
    });
    this.cleanupFunctions.push(unsubTaskCreated);

    const unsubTaskUpdated = hub.onEvent<{
      sessionId: string;
      spaceId: string;
      taskId: string;
      task: SpaceTask;
    }>('space.task.updated', (event) => {
      if (event.spaceId === spaceId) {
        this.tasks.value = this.upsertTaskOnePerRun(this.tasks.value, event.task);
      }
    });
    this.cleanupFunctions.push(unsubTaskUpdated);

    const unsubScheduleUpdated = hub.onEvent<{
      sessionId: string;
      spaceId: string;
      scheduleId: string;
      schedule: TaskSchedule;
    }>('space.schedule.updated', (event) => {
      if (event.spaceId === spaceId) {
        this.schedules.value = this.schedules.value.map((s) =>
          s.id === event.scheduleId ? event.schedule : s
        );
      }
    });
    this.cleanupFunctions.push(unsubScheduleUpdated);

    const unsubRunCreated = hub.onEvent<{
      sessionId: string;
      spaceId: string;
      runId: string;
      run: SpaceWorkflowRun;
    }>('space.workflowRun.created', (event) => {
      if (event.spaceId === spaceId) {
        const exists = this.workflowRuns.value.some((r) => r.id === event.run.id);
        if (!exists) {
          this.workflowRuns.value = [...this.workflowRuns.value, event.run];
        }
      }
    });
    this.cleanupFunctions.push(unsubRunCreated);

    const unsubRunUpdated = hub.onEvent<{
      sessionId: string;
      spaceId: string;
      runId: string;
      run?: Partial<SpaceWorkflowRun>;
    }>('space.workflowRun.updated', (event) => {
      if (event.spaceId === spaceId && event.run) {
        const idx = this.workflowRuns.value.findIndex((r) => r.id === event.runId);
        if (idx >= 0) {
          this.workflowRuns.value = [
            ...this.workflowRuns.value.slice(0, idx),
            { ...this.workflowRuns.value[idx], ...event.run },
            ...this.workflowRuns.value.slice(idx + 1),
          ];
        }
      }
    });
    this.cleanupFunctions.push(unsubRunUpdated);

    const unsubAgentCreated = hub.onEvent<{
      sessionId: string;
      spaceId: string;
      agent: SpaceWorkerAgent;
    }>('spaceAgent.created', (event) => {
      if (event.spaceId === spaceId) {
        const exists = this.agents.value.some((a) => a.id === event.agent.id);
        if (!exists) {
          this.agents.value = [...this.agents.value, event.agent];
        }
      }
    });
    this.cleanupFunctions.push(unsubAgentCreated);

    const unsubAgentUpdated = hub.onEvent<{
      sessionId: string;
      spaceId: string;
      agent: SpaceWorkerAgent;
    }>('spaceAgent.updated', (event) => {
      if (event.spaceId === spaceId) {
        const idx = this.agents.value.findIndex((a) => a.id === event.agent.id);
        if (idx >= 0) {
          this.agents.value = [
            ...this.agents.value.slice(0, idx),
            event.agent,
            ...this.agents.value.slice(idx + 1),
          ];
        } else {
          this.agents.value = [...this.agents.value, event.agent];
        }
      }
    });
    this.cleanupFunctions.push(unsubAgentUpdated);

    const unsubAgentDeleted = hub.onEvent<{
      sessionId: string;
      spaceId: string;
      agentId: string;
    }>('spaceAgent.deleted', (event) => {
      if (event.spaceId === spaceId) {
        this.agents.value = this.agents.value.filter((a) => a.id !== event.agentId);
      }
    });
    this.cleanupFunctions.push(unsubAgentDeleted);

    const unsubLongHorizonAgentCreated = hub.onEvent<{
      sessionId: string;
      spaceId: string;
      agent: SpaceLongHorizonAgent;
    }>('spaceLongHorizonAgent.created', (event) => {
      if (event.spaceId === spaceId) {
        this.upsertLongHorizonAgent(event.agent);
      }
    });
    this.cleanupFunctions.push(unsubLongHorizonAgentCreated);

    const unsubLongHorizonAgentUpdated = hub.onEvent<{
      sessionId: string;
      spaceId: string;
      agent: SpaceLongHorizonAgent;
    }>('spaceLongHorizonAgent.updated', (event) => {
      if (event.spaceId === spaceId) {
        this.upsertLongHorizonAgent(event.agent);
      }
    });
    this.cleanupFunctions.push(unsubLongHorizonAgentUpdated);

    const unsubLongHorizonAgentDeleted = hub.onEvent<{
      sessionId: string;
      spaceId: string;
      agentId: string;
    }>('spaceLongHorizonAgent.deleted', (event) => {
      if (event.spaceId === spaceId) {
        this.longHorizonAgents.value = this.longHorizonAgents.value.filter(
          (agent) => agent.id !== event.agentId
        );
      }
    });
    this.cleanupFunctions.push(unsubLongHorizonAgentDeleted);

    const unsubWorkflowCreated = hub.onEvent<{
      sessionId: string;
      spaceId: string;
      workflow: SpaceWorkflow;
    }>('spaceWorkflow.created', (event) => {
      if (event.spaceId === spaceId) {
        const exists = this.workflows.value.some((w) => w.id === event.workflow.id);
        if (!exists) {
          this.workflows.value = [...this.workflows.value, workflowToSummary(event.workflow)];
        }
        this.workflowDetails.value = [...this.workflowDetails.value, event.workflow];
      }
    });
    this.cleanupFunctions.push(unsubWorkflowCreated);

    const unsubWorkflowUpdated = hub.onEvent<{
      sessionId: string;
      spaceId: string;
      workflow: SpaceWorkflow;
    }>('spaceWorkflow.updated', (event) => {
      if (event.spaceId === spaceId) {
        const idx = this.workflows.value.findIndex((w) => w.id === event.workflow.id);
        const summary = workflowToSummary(event.workflow);
        if (idx >= 0) {
          this.workflows.value = [
            ...this.workflows.value.slice(0, idx),
            summary,
            ...this.workflows.value.slice(idx + 1),
          ];
        } else {
          this.workflows.value = [...this.workflows.value, summary];
        }
        const detailIdx = this.workflowDetails.value.findIndex((w) => w.id === event.workflow.id);
        if (detailIdx >= 0) {
          this.workflowDetails.value = [
            ...this.workflowDetails.value.slice(0, detailIdx),
            event.workflow,
            ...this.workflowDetails.value.slice(detailIdx + 1),
          ];
        } else {
          this.workflowDetails.value = [...this.workflowDetails.value, event.workflow];
        }
        this.workflowDetailCache.delete(event.workflow.id);
        this.workflowDetailPromises.delete(event.workflow.id);
        this.workflowDetailFetchGens.set(
          event.workflow.id,
          (this.workflowDetailFetchGens.get(event.workflow.id) ?? 0) + 1
        );
        this.workflowVersions.value = new Map(this.workflowVersions.value).set(
          event.workflow.id,
          (this.workflowVersions.value.get(event.workflow.id) ?? 0) + 1
        );
      }
    });
    this.cleanupFunctions.push(unsubWorkflowUpdated);

    const unsubWorkflowDeleted = hub.onEvent<{
      sessionId: string;
      spaceId: string;
      workflowId: string;
    }>('spaceWorkflow.deleted', (event) => {
      if (event.spaceId === spaceId) {
        this.workflows.value = this.workflows.value.filter((w) => w.id !== event.workflowId);
        this.workflowDetails.value = this.workflowDetails.value.filter(
          (w) => w.id !== event.workflowId
        );
        this.workflowDetailCache.delete(event.workflowId);
        this.workflowDetailPromises.delete(event.workflowId);
        this.workflowDetailFetchGens.set(
          event.workflowId,
          (this.workflowDetailFetchGens.get(event.workflowId) ?? 0) + 1
        );
        this.workflowVersions.value = new Map(this.workflowVersions.value).set(
          event.workflowId,
          (this.workflowVersions.value.get(event.workflowId) ?? 0) + 1
        );
      }
    });
    this.cleanupFunctions.push(unsubWorkflowDeleted);
  }

  private async fetchAndResolveSpace(spaceIdOrSlug: string): Promise<string | null> {
    const hub = await connectionManager.getHub();

    const overview = await hub.request<{
      space: Space;
      tasks: SpaceTask[];
      workflowRuns: SpaceWorkflowRun[];
      sessions: string[];
    }>('space.overview', isUUID(spaceIdOrSlug) ? { id: spaceIdOrSlug } : { slug: spaceIdOrSlug });

    if (!overview) {
      this.error.value = 'Space not found';
      return null;
    }

    this.space.value = overview.space;
    this.updateRuntimeState(overview.space);
    this.workflowRuns.value = overview.workflowRuns ?? [];
    this.tasks.value = overview.tasks ?? [];
    return overview.space.id;
  }

  private async fetchAgents(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    spaceId: string
  ): Promise<void> {
    try {
      const result = await hub.request<{ agents: SpaceWorkerAgent[] }>('spaceAgent.list', {
        spaceId,
      });
      if (this.spaceId.value !== spaceId) return;
      this.agents.value = (result?.agents ?? []).filter((agent) => agent.spaceId === spaceId);
    } catch (err) {
      logger.error('Failed to fetch agents:', err);
    }
  }

  private async fetchLongHorizonAgents(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    spaceId: string
  ): Promise<void> {
    try {
      const result = await hub.request<{ agents: SpaceLongHorizonAgent[] }>(
        'spaceLongHorizonAgent.list',
        { spaceId }
      );
      if (this.spaceId.value !== spaceId) return;
      this.longHorizonAgents.value = (result?.agents ?? []).filter(
        (agent) => agent.spaceId === spaceId
      );
    } catch (err) {
      logger.error('Failed to fetch long-horizon agents (keeping cached list):', err);
    }
  }

  async refreshLongHorizonAgents(): Promise<void> {
    const spaceId = this.spaceId.value;
    if (!spaceId) return;
    try {
      const hub = await connectionManager.getHub();
      await this.fetchLongHorizonAgents(hub, spaceId);
    } catch (err) {
      logger.error('Failed to refresh long-horizon agents:', err);
    }
  }

  private async fetchLongHorizonAgentTemplates(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    spaceId: string
  ): Promise<void> {
    try {
      const result = await hub.request<{ templates: SpaceLongHorizonAgentTemplate[] }>(
        'spaceLongHorizonAgent.listBuiltInTemplates',
        { spaceId }
      );
      if (this.spaceId.value !== spaceId) return;
      this.longHorizonAgentTemplates.value = result?.templates ?? [];
    } catch (err) {
      logger.error('Failed to fetch long-horizon agent templates:', err);
      if (this.spaceId.value === spaceId) this.longHorizonAgentTemplates.value = [];
    }
  }

  private async fetchAgentTemplates(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    spaceId: string
  ): Promise<void> {
    try {
      const result = await hub.request<{ templates: SpaceWorkerAgentTemplate[] }>(
        'spaceAgent.listBuiltInTemplates',
        {
          spaceId,
        }
      );
      this.agentTemplates.value = result?.templates ?? [];
    } catch (err) {
      logger.error('Failed to fetch agent templates:', err);
      this.agentTemplates.value = [];
    }
  }

  private async fetchWorkflows(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    spaceId: string
  ): Promise<void> {
    try {
      const result = await hub.request<{ workflows: SpaceWorkflowSummary[] }>(
        'spaceWorkflow.list',
        {
          spaceId,
        }
      );
      this.workflows.value = result?.workflows ?? [];
      this.workflowSummariesLoaded = true;
    } catch (err) {
      logger.error('Failed to fetch workflows:', err);
      this.workflowSummariesLoaded = false;
    }
  }

  private workflowDetailsPromise: Promise<void> | null = null;

  readonly workflowDetailsLoaded = signal<boolean>(false);

  async ensureWorkflowDetails(): Promise<void> {
    if (this.workflowDetailsLoaded.value) return;
    if (this.workflowDetailsPromise) return this.workflowDetailsPromise;

    const spaceId = this.spaceId.value;
    if (!spaceId) return;

    if (!this.workflowSummariesLoaded) {
      this.retryWorkflowSummaries(spaceId);
      return;
    }

    const requestedIds = new Set(this.workflows.value.map((workflow) => workflow.id));
    const priorDetails = new Map<string, SpaceWorkflow>(
      this.workflowDetails.value.map((workflow) => [workflow.id, workflow])
    );

    const loadGeneration = this.workflowDetailsLoadGeneration;

    this.workflowDetailsPromise = (async (): Promise<void> => {
      try {
        for (const id of requestedIds) {
          this.workflowDetailCache.delete(id);
          this.workflowDetailPromises.delete(id);
          this.workflowDetailFetchGens.set(id, (this.workflowDetailFetchGens.get(id) ?? 0) + 1);
        }
        const results = await Promise.all(
          [...requestedIds].map(async (id) => {
            const detail = await this.fetchWorkflowDetail(id);
            return { id, detail };
          })
        );
        if (
          this.spaceId.value !== spaceId ||
          this.workflowDetailsLoadGeneration !== loadGeneration
        ) {
          return;
        }

        const fetchedById = new Map<string, SpaceWorkflow>();
        let missing = 0;
        for (const { id, detail } of results) {
          if (detail) {
            fetchedById.set(id, detail);
          } else if (
            this.workflows.value.some((w) => w.id === id) &&
            !this.workflowDetails.value.some((w) => w.id === id)
          ) {
            missing += 1;
          }
        }
        const merged: SpaceWorkflow[] = [];
        const seen = new Set<string>();
        for (const workflow of this.workflowDetails.value) {
          if (!this.workflows.value.some((w) => w.id === workflow.id)) continue;
          const fresh = fetchedById.get(workflow.id);
          const wasUpdatedDuringFetch = workflow !== priorDetails.get(workflow.id);
          if (wasUpdatedDuringFetch) {
            merged.push(workflow);
          } else if (fresh) {
            merged.push(fresh);
          } else {
            merged.push(workflow);
          }
          seen.add(workflow.id);
        }
        for (const [id, detail] of fetchedById) {
          if (!seen.has(id) && this.workflows.value.some((w) => w.id === id)) {
            const current = this.workflowDetails.value.find((w) => w.id === id);
            const wasUpdatedDuringFetch = current && current !== priorDetails.get(id);
            merged.push(wasUpdatedDuringFetch ? current : detail);
            seen.add(id);
          }
        }
        this.workflowDetails.value = merged;
        if (missing === 0) {
          this.workflowDetailsLoaded.value = true;
          this.workflowDetailsRetryCount = 0;
          this.workflowDetailsRetryPending = false;
        } else {
          logger.error(`ensureWorkflowDetails: ${missing} workflow detail(s) failed to load`);
          const MAX_RETRIES = 5;
          if (this.workflowDetailsRetryCount < MAX_RETRIES) {
            const delay = 2 ** this.workflowDetailsRetryCount * 3000;
            this.workflowDetailsRetryCount += 1;
            this.workflowDetailsRetryPending = true;
            setTimeout(() => {
              if (
                this.spaceId.value === spaceId &&
                this.workflowDetailsLoadGeneration === loadGeneration
              ) {
                this.workflowDetailsRetryPending = false;
                if (!this.workflowDetailsLoaded.value) {
                  this.ensureWorkflowDetails().catch(() => {});
                }
              }
            }, delay);
          } else {
            this.workflowDetailsLoaded.value = true;
            this.workflowDetailsRetryCount = 0;
            this.workflowDetailsRetryPending = false;
          }
        }
      } catch (err) {
        logger.error('Failed to fetch workflow details:', err);
        if (this.spaceId.value === spaceId) this.workflowDetails.value = [];
      } finally {
        if (this.workflowDetailsLoadGeneration === loadGeneration) {
          this.workflowDetailsPromise = null;
        }
      }
    })();

    return this.workflowDetailsPromise;
  }

  private retryWorkflowSummaries(spaceId: string): void {
    const loadGeneration = this.workflowDetailsLoadGeneration;
    const MAX_RETRIES = 5;
    if (this.workflowDetailsRetryCount >= MAX_RETRIES) {
      this.workflowDetailsLoaded.value = true;
      this.workflowDetailsRetryCount = 0;
      this.workflowDetailsRetryPending = false;
      return;
    }
    const delay = 2 ** this.workflowDetailsRetryCount * 3000;
    this.workflowDetailsRetryCount += 1;
    this.workflowDetailsRetryPending = true;
    setTimeout(() => {
      if (this.spaceId.value !== spaceId || this.workflowDetailsLoadGeneration !== loadGeneration) {
        return;
      }
      this.workflowDetailsRetryPending = false;
      this.configDataLoaded.value = false;
      this.configDataPromise = null;
      this.ensureConfigData()
        .then(() => {
          if (
            this.spaceId.value !== spaceId ||
            this.workflowDetailsLoadGeneration !== loadGeneration
          ) {
            return;
          }
          if (this.workflowSummariesLoaded) {
            if (!this.workflowDetailsLoaded.value) {
              this.workflowDetailsRetryCount = 0;
              this.ensureWorkflowDetails().catch(() => {});
            }
          } else {
            this.retryWorkflowSummaries(spaceId);
          }
        })
        .catch(() => {});
    }, delay);
  }

  private async fetchWorkflowTemplates(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    spaceId: string
  ): Promise<void> {
    try {
      const result = await hub.request<{ workflows: SpaceWorkflow[] }>(
        'spaceWorkflow.listBuiltInTemplates',
        {
          spaceId,
        }
      );
      this.workflowTemplates.value = result?.workflows ?? [];
    } catch (err) {
      logger.error('Failed to fetch workflow templates:', err);
      this.workflowTemplates.value = [];
    }
  }

  async fetchWorkflowDetail(workflowId: string): Promise<SpaceWorkflow | null> {
    const cached = this.workflowDetailCache.get(workflowId);
    if (cached) return cached;

    const inFlight = this.workflowDetailPromises.get(workflowId);
    if (inFlight) return inFlight;

    const spaceId = this.spaceId.value;
    if (!spaceId) return null;

    const generation = (this.workflowDetailFetchGens.get(workflowId) ?? 0) + 1;
    this.workflowDetailFetchGens.set(workflowId, generation);

    const promise = (async (): Promise<SpaceWorkflow | null> => {
      try {
        const hub = await connectionManager.getHub();
        const result = await hub.request<{ workflow: SpaceWorkflow }>('spaceWorkflow.get', {
          id: workflowId,
          spaceId,
        });
        if (result?.workflow) {
          if (
            this.spaceId.value === spaceId &&
            this.workflowDetailFetchGens.get(workflowId) === generation
          ) {
            this.workflowDetailCache.set(workflowId, result.workflow);
          }
          return result.workflow;
        }
        return null;
      } catch (err) {
        logger.error('Failed to fetch workflow detail:', err);
        return null;
      } finally {
        this.workflowDetailPromises.delete(workflowId);
      }
    })();

    this.workflowDetailPromises.set(workflowId, promise);
    return promise;
  }

  private clearWorkflowDetailCache(): void {
    this.workflowDetailCache.clear();
    this.workflowDetailPromises.clear();
    this.workflowDetailFetchGens.clear();
    this.workflowDetailsRetryCount = 0;
    this.workflowDetailsRetryPending = false;
    this.workflowDetailsLoadGeneration += 1;
  }

  private async fetchNodeExecutions(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    runId: string
  ): Promise<void> {
    try {
      const result = await hub.request<{ executions: NodeExecution[] }>('nodeExecution.list', {
        workflowRunId: runId,
        spaceId: this.spaceId.value,
      });
      if (this.activeNodeExecRunId !== runId) return;
      this.nodeExecutions.value = result?.executions ?? [];
    } catch (err) {
      logger.error('Failed to fetch node executions:', err);
    }
  }

  private stopSubscriptions(): void {
    for (const cleanup of this.cleanupFunctions) {
      try {
        cleanup();
      } catch {}
    }
    this.cleanupFunctions = [];
    this.unsubscribeTaskActivity();
    this.unsubscribeTaskMessageActivity();
    this.unsubscribeNodeExecutions();
  }

  async ensureConfigData(): Promise<void> {
    if (this.configDataLoaded.value) return;
    if (this.configDataPromise) return this.configDataPromise;

    const spaceId = this.spaceId.value;
    if (!spaceId) return;

    this.configDataPromise = this.doEnsureConfigData(spaceId);
    try {
      await this.configDataPromise;
    } finally {
      this.configDataPromise = null;
    }
  }

  private async doEnsureConfigData(spaceId: string): Promise<void> {
    try {
      const hub = await connectionManager.getHub();
      await Promise.all([
        this.fetchAgents(hub, spaceId),
        this.fetchAgentTemplates(hub, spaceId),
        this.fetchWorkflows(hub, spaceId),
        this.fetchWorkflowTemplates(hub, spaceId),
        this.fetchLongHorizonAgents(hub, spaceId),
        this.fetchLongHorizonAgentTemplates(hub, spaceId),
      ]);
      if (this.spaceId.value === spaceId) {
        this.configDataLoaded.value = true;
      }
    } catch (err) {
      logger.error('Failed to load config data:', err);
    }
  }

  async ensureNodeExecutions(workflowRunId: string | null): Promise<void> {
    if (!workflowRunId) {
      if (this.activeNodeExecRunId !== null) {
        this.unsubscribeNodeExecutions();
        this.nodeExecutions.value = [];
        this.activeNodeExecRunId = null;
        this.nodeExecLoaded.value = false;
      }
      return;
    }
    if (this.activeNodeExecRunId === workflowRunId && this.nodeExecLoaded.value) return;
    if (this.nodeExecPromise && this.activeNodeExecRunId === workflowRunId) {
      return this.nodeExecPromise;
    }
    const spaceId = this.spaceId.value;
    if (!spaceId) return;

    this.activeNodeExecRunId = workflowRunId;
    this.nodeExecLoaded.value = false;
    this.nodeExecutions.value = [];
    this.unsubscribeNodeExecutions();

    const gen = ++this.nodeExecLoadGen;
    this.nodeExecPromise = this.doEnsureNodeExecutions(workflowRunId);
    try {
      await this.nodeExecPromise;
    } finally {
      if (gen === this.nodeExecLoadGen) this.nodeExecPromise = null;
    }
  }

  private async doEnsureNodeExecutions(runId: string): Promise<void> {
    try {
      const hub = await connectionManager.getHub();
      await this.fetchNodeExecutions(hub, runId);
      if (this.activeNodeExecRunId !== runId) return;
      this.subscribeNodeExecutionsByRun(hub, runId);
      this.nodeExecLoaded.value = true;
    } catch (err) {
      logger.error('Failed to load node executions:', err);
    }
  }

  private applyTaskActivityDelta(
    currentRows: SpaceTaskActivityMember[],
    event: LiveQueryDeltaEvent
  ): SpaceTaskActivityMember[] {
    const next = new Map(currentRows.map((row) => [row.id, row]));

    for (const row of (event.removed ?? []) as SpaceTaskActivityMember[]) {
      next.delete(row.id);
    }
    for (const row of (event.updated ?? []) as SpaceTaskActivityMember[]) {
      next.set(row.id, row);
    }
    for (const row of (event.added ?? []) as SpaceTaskActivityMember[]) {
      next.set(row.id, row);
    }

    return Array.from(next.values()).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  async subscribeTaskActivity(taskId: string): Promise<void> {
    if (!taskId) return;
    if (this.activeTaskActivityTaskId === taskId) return;

    this.unsubscribeTaskActivity();
    this.activeTaskActivityTaskId = taskId;

    const subscriptionId = `spaceTaskActivity-${taskId}`;

    try {
      const hub = await connectionManager.getHub();
      if (this.activeTaskActivityTaskId !== taskId) return;

      this.activeTaskActivitySubscriptionIds.add(subscriptionId);

      const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
        if (event.subscriptionId !== subscriptionId) return;
        if (!this.activeTaskActivitySubscriptionIds.has(subscriptionId)) return;
        this.taskActivity.value = new Map(this.taskActivity.value).set(
          taskId,
          (event.rows as SpaceTaskActivityMember[]) ?? []
        );
      });
      this.taskActivityCleanupFns.push(unsubSnapshot);
      this.taskActivityCleanupFns.push(() =>
        this.activeTaskActivitySubscriptionIds.delete(subscriptionId)
      );

      const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
        if (event.subscriptionId !== subscriptionId) return;
        if (!this.activeTaskActivitySubscriptionIds.has(subscriptionId)) return;
        const currentRows = this.taskActivity.value.get(taskId) ?? [];
        const nextRows = this.applyTaskActivityDelta(currentRows, event);
        this.taskActivity.value = new Map(this.taskActivity.value).set(taskId, nextRows);
      });
      this.taskActivityCleanupFns.push(unsubDelta);

      const unsubReconnect = hub.onConnection((state) => {
        if (state !== 'connected') return;
        if (!this.activeTaskActivitySubscriptionIds.has(subscriptionId)) return;
        hub
          .request('liveQuery.subscribe', {
            queryName: 'spaceTaskActivity.byTask',
            params: [taskId],
            subscriptionId,
          })
          .catch((err) => {
            logger.warn('Task activity LiveQuery re-subscribe failed:', err);
          });
      });
      this.taskActivityCleanupFns.push(unsubReconnect);

      await hub.request('liveQuery.subscribe', {
        queryName: 'spaceTaskActivity.byTask',
        params: [taskId],
        subscriptionId,
      });

      if (this.activeTaskActivityTaskId !== taskId) {
        this.unsubscribeTaskActivity(taskId);
      }
    } catch (err) {
      this.unsubscribeTaskActivity(taskId);
      throw err;
    }
  }

  unsubscribeTaskActivity(taskId?: string): void {
    const activeTaskId = this.activeTaskActivityTaskId;
    if (!activeTaskId || (taskId && activeTaskId !== taskId)) return;

    const subscriptionId = `spaceTaskActivity-${activeTaskId}`;
    this.activeTaskActivitySubscriptionIds.delete(subscriptionId);

    for (const cleanup of this.taskActivityCleanupFns) {
      try {
        cleanup();
      } catch {}
    }
    this.taskActivityCleanupFns = [];
    this.activeTaskActivityTaskId = null;

    const hub = connectionManager.getHubIfConnected();
    if (hub) {
      hub.request('liveQuery.unsubscribe', { subscriptionId }).catch(() => {});
    }
  }

  hasTaskMessageActivity(taskId: string): boolean | null {
    const count = this.taskMessageActivity.value.get(taskId);
    return count === undefined ? null : count > 0;
  }

  async subscribeTaskMessageActivity(taskId: string): Promise<void> {
    if (!taskId) return;
    if (this.activeTaskMessageActivityTaskId === taskId) return;

    this.unsubscribeTaskMessageActivity();
    this.activeTaskMessageActivityTaskId = taskId;

    const subscriptionId = `spaceTaskMessageActivity-${taskId}`;

    try {
      const hub = await connectionManager.getHub();
      if (this.activeTaskMessageActivityTaskId !== taskId) return;

      this.activeTaskMessageActivitySubscriptionIds.add(subscriptionId);

      const setTaskMessageCount = (count: number) => {
        this.taskMessageActivity.value = new Map(this.taskMessageActivity.value).set(taskId, count);
      };

      const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
        if (event.subscriptionId !== subscriptionId) return;
        if (!this.activeTaskMessageActivitySubscriptionIds.has(subscriptionId)) return;
        setTaskMessageCount(((event.rows as unknown[]) ?? []).length);
      });
      this.taskMessageActivityCleanupFns.push(unsubSnapshot);
      this.taskMessageActivityCleanupFns.push(() =>
        this.activeTaskMessageActivitySubscriptionIds.delete(subscriptionId)
      );

      const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
        if (event.subscriptionId !== subscriptionId) return;
        if (!this.activeTaskMessageActivitySubscriptionIds.has(subscriptionId)) return;
        const current = this.taskMessageActivity.value.get(taskId);
        if (current === undefined) return;
        const added = (event.added ?? []).length;
        const removed = (event.removed ?? []).length;
        if (added === 0 && removed === 0) return;
        setTaskMessageCount(Math.max(0, current + added - removed));
      });
      this.taskMessageActivityCleanupFns.push(unsubDelta);

      const unsubReconnect = hub.onConnection((state) => {
        if (state !== 'connected') return;
        if (!this.activeTaskMessageActivitySubscriptionIds.has(subscriptionId)) return;
        hub
          .request('liveQuery.subscribe', {
            queryName: 'spaceTaskMessages.byTask.compact',
            params: [taskId],
            subscriptionId,
          })
          .catch((err) => {
            logger.warn('Task message activity LiveQuery re-subscribe failed:', err);
          });
      });
      this.taskMessageActivityCleanupFns.push(unsubReconnect);

      await hub.request('liveQuery.subscribe', {
        queryName: 'spaceTaskMessages.byTask.compact',
        params: [taskId],
        subscriptionId,
      });

      if (this.activeTaskMessageActivityTaskId !== taskId) {
        this.unsubscribeTaskMessageActivity(taskId);
      }
    } catch (err) {
      this.unsubscribeTaskMessageActivity(taskId);
      throw err;
    }
  }

  unsubscribeTaskMessageActivity(taskId?: string): void {
    const activeTaskId = this.activeTaskMessageActivityTaskId;
    if (!activeTaskId || (taskId && activeTaskId !== taskId)) return;

    const subscriptionId = `spaceTaskMessageActivity-${activeTaskId}`;
    this.activeTaskMessageActivitySubscriptionIds.delete(subscriptionId);

    for (const cleanup of this.taskMessageActivityCleanupFns) {
      try {
        cleanup();
      } catch {}
    }
    this.taskMessageActivityCleanupFns = [];
    this.activeTaskMessageActivityTaskId = null;

    const hub = connectionManager.getHubIfConnected();
    if (hub) {
      hub.request('liveQuery.unsubscribe', { subscriptionId }).catch(() => {});
    }
  }

  private subscribeNodeExecutionsByRun(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    runId: string
  ): void {
    const subscriptionId = `nodeExecutions-byRun-${runId}`;
    if (this.activeNodeExecSubscriptionIds.has(subscriptionId)) return;
    this.activeNodeExecSubscriptionIds.add(subscriptionId);

    const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
      if (event.subscriptionId !== subscriptionId) return;
      if (!this.activeNodeExecSubscriptionIds.has(subscriptionId)) return;
      this.mergeNodeExecSnapshot(event.rows as NodeExecution[], runId);
    });
    this.nodeExecCleanupFns.push(unsubSnapshot);

    const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
      if (event.subscriptionId !== subscriptionId) return;
      if (!this.activeNodeExecSubscriptionIds.has(subscriptionId)) return;
      this.mergeNodeExecDelta(event);
    });
    this.nodeExecCleanupFns.push(unsubDelta);

    const unsubReconnect = hub.onConnection((state) => {
      if (state !== 'connected') return;
      if (!this.activeNodeExecSubscriptionIds.has(subscriptionId)) return;
      hub
        .request('liveQuery.subscribe', {
          queryName: 'nodeExecutions.byRun',
          params: [runId],
          subscriptionId,
        })
        .catch((err) => {
          logger.warn('Node execution LiveQuery re-subscribe failed:', err);
        });
    });
    this.nodeExecCleanupFns.push(unsubReconnect);

    hub
      .request('liveQuery.subscribe', {
        queryName: 'nodeExecutions.byRun',
        params: [runId],
        subscriptionId,
      })
      .catch((err) => {
        logger.warn('Node execution LiveQuery subscribe failed:', err);
      });
  }

  private mergeNodeExecSnapshot(rows: NodeExecution[], runId: string): void {
    const current = this.nodeExecutions.value;
    const filtered = current.filter((e) => e.workflowRunId !== runId);
    this.nodeExecutions.value = [...filtered, ...rows];
  }

  private mergeNodeExecDelta(event: LiveQueryDeltaEvent): void {
    const current = this.nodeExecutions.value;
    const next = new Map(current.map((e) => [e.id, e]));

    for (const row of (event.removed ?? []) as NodeExecution[]) {
      next.delete(row.id);
    }
    for (const row of (event.updated ?? []) as NodeExecution[]) {
      next.set(row.id, row);
    }
    for (const row of (event.added ?? []) as NodeExecution[]) {
      next.set(row.id, row);
    }

    this.nodeExecutions.value = Array.from(next.values());
  }

  private unsubscribeNodeExecutions(): void {
    for (const cleanup of this.nodeExecCleanupFns) {
      try {
        cleanup();
      } catch {}
    }
    this.nodeExecCleanupFns = [];

    for (const subId of this.activeNodeExecSubscriptionIds) {
      const hub = connectionManager.getHubIfConnected();
      if (hub) {
        hub.request('liveQuery.unsubscribe', { subscriptionId: subId }).catch(() => {});
      }
    }
    this.activeNodeExecSubscriptionIds = new Set();
  }

  private subscribeSpaceSessions(
    hub: Awaited<ReturnType<typeof connectionManager.getHub>>,
    spaceId: string
  ): void {
    const subscriptionId = `spaceSessions-bySpace-${spaceId}`;
    if (this.activeSpaceSessionsSubscriptionId === subscriptionId) return;
    this.disposeSpaceSessionsSubscription();
    this.activeSpaceSessionsSubscriptionId = subscriptionId;

    type SessionRow = SpaceSessionRow;

    const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
      if (event.subscriptionId !== subscriptionId) return;
      if (this.activeSpaceSessionsSubscriptionId !== subscriptionId) return;
      this.sessions.value = (event.rows as SessionRow[]) ?? [];
    });
    this.spaceSessionsCleanupFns.push(unsubSnapshot);

    const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
      if (event.subscriptionId !== subscriptionId) return;
      if (this.activeSpaceSessionsSubscriptionId !== subscriptionId) return;
      const current = this.sessions.value;
      const next = new Map(current.map((s) => [s.id, s]));
      for (const row of (event.removed ?? []) as SessionRow[]) next.delete(row.id);
      for (const row of (event.updated ?? []) as SessionRow[]) next.set(row.id, row);
      for (const row of (event.added ?? []) as SessionRow[]) next.set(row.id, row);
      this.sessions.value = [...next.values()];
    });
    this.spaceSessionsCleanupFns.push(unsubDelta);

    const unsubReconnect = hub.onConnection((state) => {
      if (state !== 'connected') return;
      if (this.activeSpaceSessionsSubscriptionId !== subscriptionId) return;
      hub
        .request('liveQuery.subscribe', {
          queryName: 'spaceSessions.bySpace',
          params: [spaceId],
          subscriptionId,
        })
        .catch((err) => {
          logger.warn('Space sessions LiveQuery re-subscribe failed:', err);
        });
    });
    this.spaceSessionsCleanupFns.push(unsubReconnect);

    hub
      .request('liveQuery.subscribe', {
        queryName: 'spaceSessions.bySpace',
        params: [spaceId],
        subscriptionId,
      })
      .catch((err) => {
        logger.warn('Space sessions LiveQuery subscribe failed:', err);
      });
  }

  private disposeSpaceSessionsSubscription(): void {
    for (const cleanup of this.spaceSessionsCleanupFns) {
      try {
        cleanup();
      } catch {}
    }
    this.spaceSessionsCleanupFns = [];

    if (this.activeSpaceSessionsSubscriptionId) {
      const hub = connectionManager.getHubIfConnected();
      if (hub) {
        hub
          .request('liveQuery.unsubscribe', {
            subscriptionId: this.activeSpaceSessionsSubscriptionId,
          })
          .catch(() => {});
      }
      this.activeSpaceSessionsSubscriptionId = null;
    }
  }

  async refresh(): Promise<void> {
    if (this.globalListInitialized) {
      this.globalListInitialized = false;
      this.initGlobalList().catch((err) => {
        logger.error('Failed to re-initialize global space list on reconnect:', err);
      });
    }

    const spaceId = this.spaceId.value;
    if (!spaceId) return;

    const hadConfigData = this.configDataLoaded.value;
    const hadNodeExec = this.nodeExecLoaded.value;
    const hadWorkflowDetails = this.workflowDetailsLoaded.value;
    const hadWorkflowDetailsPending =
      this.workflowDetailsPromise !== null || this.workflowDetailsRetryPending;

    this.configDataLoaded.value = false;
    this.configDataPromise = null;
    this.nodeExecLoaded.value = false;
    this.nodeExecPromise = null;
    this.workflowDetailsLoaded.value = false;
    this.workflowDetailsPromise = null;
    this.workflowDetailsRetryPending = false;
    this.workflowDetailsLoadGeneration += 1;
    this.sessions.value = [];
    this.disposeSpaceSessionsSubscription();

    try {
      await this.fetchAndResolveSpace(spaceId);
      await this.startSubscriptions(spaceId);
      if (hadConfigData) {
        this.ensureConfigData().catch((err) => {
          logger.error('Failed to refresh config data:', err);
        });
      }
      if (hadWorkflowDetails || hadWorkflowDetailsPending) {
        this.ensureConfigData()
          .then(() => {
            if (this.configDataLoaded.value) return this.ensureWorkflowDetails();
          })
          .catch((err) => {
            logger.error('Failed to refresh workflow details:', err);
          });
      }
      if (hadNodeExec) {
        this.ensureNodeExecutions(this.activeNodeExecRunId).catch((err) => {
          logger.error('Failed to refresh node executions:', err);
        });
      }
    } catch (err) {
      logger.error('Failed to refresh space state:', err);
    }
  }

  async updateSpace(params: UpdateSpaceParams): Promise<void> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const space = await hub.request<Space>('space.update', { id: spaceId, ...params });
    if (space) {
      this.space.value = space;
      this.updateRuntimeState(space);
    }
  }

  async archiveSpace(): Promise<void> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    await hub.request('space.archive', { id: spaceId });
    await this.clearSpace();
  }

  async stopSpace(): Promise<void> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const space = await hub.request<Space>('space.stop', { id: spaceId });
    if (space) {
      this.space.value = space;
      this.updateRuntimeState(space);
    }
  }

  async startSpace(): Promise<void> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const space = await hub.request<Space>('space.start', { id: spaceId });
    if (space) {
      this.space.value = space;
      this.updateRuntimeState(space);
    }
  }

  async pauseSpace(): Promise<void> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const space = await hub.request<Space>('space.pause', { id: spaceId });
    if (space) {
      this.space.value = space;
      this.updateRuntimeState(space);
    }
  }

  async resumeSpace(): Promise<void> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const space = await hub.request<Space>('space.resume', { id: spaceId });
    if (space) {
      this.space.value = space;
      this.updateRuntimeState(space);
    }
  }

  async deleteSpace(): Promise<void> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    await hub.request('space.delete', { id: spaceId });
    await this.clearSpace();
  }

  async createTask(params: Omit<CreateSpaceTaskParams, 'spaceId'>): Promise<SpaceTask> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const task = await hub.request<SpaceTask>('spaceTask.create', { ...params, spaceId });
    return task;
  }

  async fetchTaskGroup(
    status: SpaceTaskStatus,
    options?: {
      blockReason?: SpaceBlockReason | null;
      blockReasonNotIn?: SpaceBlockReason[];
      limit?: number;
      offset?: number;
    }
  ): Promise<PaginatedSpaceTaskResult> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const limit = options?.limit ?? 10;
    const offset = options?.offset ?? 0;

    const payload: {
      spaceId: string;
      status: SpaceTaskStatus;
      limit: number;
      offset: number;
      blockReason?: SpaceBlockReason | null;
      blockReasonNotIn?: SpaceBlockReason[];
    } = { spaceId, status, limit, offset };
    if (options && 'blockReason' in options) payload.blockReason = options.blockReason;
    if (options?.blockReasonNotIn) payload.blockReasonNotIn = options.blockReasonNotIn;

    const result = await hub.request<PaginatedSpaceTaskResult>('spaceTask.list', payload);
    return {
      tasks: result?.tasks ?? [],
      total: result?.total ?? 0,
    };
  }

  async updateTask(taskId: string, params: UpdateSpaceTaskParams): Promise<SpaceTask> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const task = await hub.request<SpaceTask>('spaceTask.update', {
      taskId,
      spaceId,
      ...params,
    });
    return task;
  }

  async fetchEvolutionScope(
    scopeId: string
  ): Promise<import('@hyperneo/shared').EvolutionScope | null> {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');
    const result = await hub.request<{ scope: import('@hyperneo/shared').EvolutionScope | null }>(
      'evolution.scope.get',
      { id: scopeId }
    );
    return result.scope ?? null;
  }

  async recoverWorkflowTask(taskId: string, status: 'open' | 'in_progress'): Promise<SpaceTask> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    return hub.request<SpaceTask>('spaceTask.recoverWorkflow', {
      taskId,
      spaceId,
      status,
    });
  }

  async cancelWorkflowRun(runId: string): Promise<void> {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    await hub.request('spaceWorkflowRun.cancel', { id: runId });
  }

  async publishTask(taskId: string): Promise<SpaceTask> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    return hub.request<SpaceTask>('spaceTask.publish', {
      taskId,
      spaceId,
    });
  }

  async submitForReview(taskId: string, reason?: string | null): Promise<SpaceTask> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const task = await hub.request<SpaceTask>('spaceTask.submitForReview', {
      taskId,
      spaceId,
      reason: reason ?? null,
    });
    return task;
  }

  async approvePendingCompletion(
    taskId: string,
    approved: boolean,
    reason?: string | null
  ): Promise<SpaceTask> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const task = await hub.request<SpaceTask>('spaceTask.approvePendingCompletion', {
      taskId,
      spaceId,
      approved,
      reason: reason ?? null,
    });
    return task;
  }

  async sendTaskMessage(
    taskId: string,
    message: string,
    target?: {
      kind: 'node_agent';
      agentName: string;
      nodeExecutionId?: string;
      workflowNodeId?: string;
      sessionId?: string;
    },
    images?: MessageImage[],
    deliveryMode?: MessageDeliveryMode
  ): Promise<{
    ok: boolean;
    routedTo?: string[];
    delivered?: false;
    activated?: true;
    queued?: true;
  }> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    return hub.request('space.task.sendMessage', {
      taskId,
      spaceId,
      message,
      ...(target ? { target } : {}),
      ...(images && images.length > 0 ? { images } : {}),
      ...(deliveryMode ? { deliveryMode } : {}),
    });
  }

  async activateTaskNodeAgent(
    taskId: string,
    agentName: string,
    message?: string,
    workflowNodeId?: string,
    clientMessageId?: string
  ): Promise<{
    sessionId: string | null;
    activated: boolean;
    queued: boolean;
    queuedMessageId?: string;
  }> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const response = await hub.request<{
      sessionId: string | null;
      activated: boolean;
      queued: boolean;
      queuedMessageId?: string;
    }>('space.task.activateNodeAgent', {
      taskId,
      spaceId,
      agentName,
      ...(message !== undefined ? { message } : {}),
      ...(workflowNodeId ? { workflowNodeId } : {}),
      ...(clientMessageId ? { clientMessageId } : {}),
    });

    return {
      sessionId: response?.sessionId ?? null,
      activated: response?.activated ?? false,
      queued: response?.queued ?? false,
      ...(response?.queuedMessageId ? { queuedMessageId: response.queuedMessageId } : {}),
    };
  }

  async listExternalEventDeliveries(
    filters: {
      spaceId?: string;
      status?: ExternalEventDeliveryStatus | '';
      agentName?: string;
      eventId?: string;
      limit?: number;
      offset?: number;
    } = {}
  ): Promise<SpaceExternalEventDeliveryLogRecord[]> {
    const spaceId = filters.spaceId ?? this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const result = await hub.request<{ deliveries: SpaceExternalEventDeliveryLogRecord[] }>(
      'space.externalEvents.listDeliveries',
      {
        spaceId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.agentName ? { agentName: filters.agentName } : {}),
        ...(filters.eventId ? { eventId: filters.eventId } : {}),
        limit: filters.limit ?? 100,
        offset: filters.offset ?? 0,
      }
    );
    return result?.deliveries ?? [];
  }

  async getExternalEventQueueHealth(): Promise<QueueHealthSnapshot | null> {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');
    const result = await hub.request<QueueHealthSnapshot>('space.externalEvents.queueHealth', {});
    return result ?? null;
  }

  async listArtifacts(runId: string): Promise<WorkflowRunArtifact[]> {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const result = await hub.request<{ artifacts: WorkflowRunArtifact[] }>(
      'spaceWorkflowRun.listArtifacts',
      { runId }
    );
    return result?.artifacts ?? [];
  }

  async listHookStates(
    runId: string
  ): Promise<import('@hyperneo/shared').WorkflowHookStateSnapshot[]> {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const result = await hub.request<{
      hookStates: import('@hyperneo/shared').WorkflowHookStateSnapshot[];
      hooks: import('@hyperneo/shared').WorkflowHook[];
    }>('spaceWorkflowRun.listHookStates', { runId });
    return result?.hookStates ?? [];
  }

  async approveHook(
    runId: string,
    hookId: string,
    approved: boolean,
    reason?: string | null
  ): Promise<import('@hyperneo/shared').WorkflowHookStateSnapshot> {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const result = await hub.request<{
      hookState: import('@hyperneo/shared').WorkflowHookStateSnapshot;
    }>('spaceWorkflowRun.approveHook', { runId, hookId, approved, reason: reason ?? null });
    return (
      result?.hookState ?? {
        runId,
        hookId,
        version: 0,
        localState: {},
        retryCount: 0,
        createdAt: 0,
        updatedAt: 0,
        voteMaps: {},
      }
    );
  }

  async retryHook(
    runId: string,
    hookId: string
  ): Promise<import('@hyperneo/shared').WorkflowHookStateSnapshot> {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const result = await hub.request<{
      hookState: import('@hyperneo/shared').WorkflowHookStateSnapshot;
    }>('spaceWorkflowRun.retryHook', { runId, hookId });
    return (
      result?.hookState ?? {
        runId,
        hookId,
        version: 0,
        localState: {},
        retryCount: 0,
        createdAt: 0,
        updatedAt: 0,
        voteMaps: {},
      }
    );
  }

  private upsertAgent(agent: SpaceWorkerAgent, expectedSpaceId?: string): void {
    const activeSpaceId = this.spaceId.value;
    const agentSpaceId = agent.spaceId;
    if (expectedSpaceId && activeSpaceId !== expectedSpaceId) return;
    if (agentSpaceId && activeSpaceId && agentSpaceId !== activeSpaceId) return;

    const exists = this.agents.value.some((a) => a.id === agent.id);
    this.agents.value = exists
      ? this.agents.value.map((a) => (a.id === agent.id ? agent : a))
      : [...this.agents.value, agent];
  }

  async createAgent(
    params: Omit<CreateSpaceWorkerAgentParams, 'spaceId'>
  ): Promise<SpaceWorkerAgent> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { agent } = await hub.request<{ agent: SpaceWorkerAgent }>('spaceAgent.create', {
      ...params,
      spaceId,
    });
    this.upsertAgent(agent, spaceId);
    return agent;
  }

  async getAgentPromotionDraft(sessionId: string): Promise<SpaceWorkerAgentPromotionDraft> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { draft } = await hub.request<{ draft: SpaceWorkerAgentPromotionDraft }>(
      'spaceAgent.getPromotionDraft',
      { spaceId, sessionId }
    );
    return draft;
  }

  async promoteSessionToAgent(
    sessionId: string,
    params: Omit<CreateSpaceWorkerAgentParams, 'spaceId'>
  ): Promise<SpaceWorkerAgent> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { agent } = await hub.request<{ agent: SpaceWorkerAgent }>('spaceAgent.promoteSession', {
      ...params,
      spaceId,
      sessionId,
    });
    this.upsertAgent(agent, spaceId);
    return agent;
  }

  async updateAgent(
    agentId: string,
    params: UpdateSpaceWorkerAgentParams
  ): Promise<SpaceWorkerAgent> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { agent } = await hub.request<{ agent: SpaceWorkerAgent }>('spaceAgent.update', {
      id: agentId,
      spaceId,
      ...params,
    });
    this.upsertAgent(agent, spaceId);
    return agent;
  }

  async syncAgentFromTemplate(
    agentId: string,
    expectedRowHash?: string
  ): Promise<SpaceWorkerAgent> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { agent } = await hub.request<{ agent: SpaceWorkerAgent }>(
      'spaceAgent.syncFromTemplate',
      {
        spaceId,
        agentId,
        ...(expectedRowHash !== undefined ? { expectedRowHash } : {}),
      }
    );
    this.upsertAgent(agent, spaceId);
    return agent;
  }

  async previewAgentTemplateSync(agentId: string): Promise<SpaceWorkerAgentSyncPreview> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { preview } = await hub.request<{ preview: SpaceWorkerAgentSyncPreview }>(
      'spaceAgent.previewTemplateSync',
      {
        spaceId,
        agentId,
      }
    );
    return preview;
  }

  async deleteAgent(agentId: string): Promise<void> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    await hub.request('spaceAgent.delete', { id: agentId, spaceId });
    this.agents.value = this.agents.value.filter((agent) => agent.id !== agentId);
  }

  async createLongHorizonAgent(params: {
    id?: string;
    handle: string;
    displayName?: string;
    templateKey?: string | null;
    instructions?: string;
    autonomyLevel?: number | null;
    model?: string | null;
    thinkingLevel?: string | null;
    provider?: string | null;
    settingSources?: SpaceLongHorizonAgent['settingSources'];
    toolPermissions?: Record<string, unknown>;
    status?: SpaceLongHorizonAgent['status'];
  }): Promise<SpaceLongHorizonAgent> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');
    const { agent } = await hub.request<{ agent: SpaceLongHorizonAgent }>(
      'spaceLongHorizonAgent.create',
      { spaceId, ...params }
    );
    this.upsertLongHorizonAgent(agent);
    return agent;
  }

  async updateLongHorizonAgent(
    agentId: string,
    params: UpdateSpaceLongHorizonAgentParams
  ): Promise<SpaceLongHorizonAgent> {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');
    const { agent } = await hub.request<{ agent: SpaceLongHorizonAgent }>(
      'spaceLongHorizonAgent.update',
      { agentId, spaceId, ...params }
    );
    this.longHorizonAgents.value = this.longHorizonAgents.value.map((a) =>
      a.id === agentId ? agent : a
    );
    return agent;
  }

  async deleteLongHorizonAgent(agentId: string): Promise<void> {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');
    await hub.request('spaceLongHorizonAgent.delete', { agentId, spaceId });
    this.longHorizonAgents.value = this.longHorizonAgents.value.filter((a) => a.id !== agentId);
  }

  async listLongHorizonAgentReminderCounts(agentIds: string[]): Promise<Record<string, number>> {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');
    const { counts } = await hub.request<{ counts: Record<string, number> }>(
      'spaceLongHorizonAgent.listReminderCounts',
      { agentIds }
    );
    return counts;
  }

  async createLongHorizonAgentReminder(
    params: Omit<CreateSpaceLongHorizonAgentReminderParams, 'spaceId'>
  ): Promise<SpaceLongHorizonAgentReminder> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');
    const { reminder } = await hub.request<{ reminder: SpaceLongHorizonAgentReminder }>(
      'spaceLongHorizonAgent.createReminder',
      { spaceId, ...params }
    );
    return reminder;
  }

  async deleteLongHorizonAgentReminder(reminderId: string): Promise<void> {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');
    await hub.request('spaceLongHorizonAgent.deleteReminder', { reminderId });
  }

  async listLongHorizonAgentSubscriptions(
    agentId: string
  ): Promise<SpaceLongHorizonAgentEventSubscription[]> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');
    const { subscriptions } = await hub.request<{
      subscriptions: SpaceLongHorizonAgentEventSubscription[];
    }>('spaceLongHorizonAgent.listSubscriptions', { agentId, spaceId });
    return subscriptions ?? [];
  }

  async createLongHorizonAgentSubscription(
    params: Omit<CreateSpaceLongHorizonAgentSubscriptionParams, 'spaceId'>
  ): Promise<SpaceLongHorizonAgentEventSubscription> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');
    const { subscription } = await hub.request<{
      subscription: SpaceLongHorizonAgentEventSubscription;
    }>('spaceLongHorizonAgent.createSubscription', { spaceId, ...params });
    return subscription;
  }

  async updateLongHorizonAgentSubscription(
    subscriptionId: string,
    params: UpdateSpaceLongHorizonAgentSubscriptionParams
  ): Promise<SpaceLongHorizonAgentEventSubscription> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');
    const { subscription } = await hub.request<{
      subscription: SpaceLongHorizonAgentEventSubscription;
    }>('spaceLongHorizonAgent.updateSubscription', { subscriptionId, spaceId, ...params });
    return subscription;
  }

  async deleteLongHorizonAgentSubscription(subscriptionId: string): Promise<void> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');
    await hub.request('spaceLongHorizonAgent.deleteSubscription', { subscriptionId, spaceId });
  }

  async createWorkflow(params: Omit<CreateSpaceWorkflowParams, 'spaceId'>): Promise<SpaceWorkflow> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { workflow } = await hub.request<{ workflow: SpaceWorkflow }>('spaceWorkflow.create', {
      ...params,
      spaceId,
    });
    return workflow;
  }

  async updateWorkflow(
    workflowId: string,
    params: UpdateSpaceWorkflowParams
  ): Promise<SpaceWorkflow> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { workflow } = await hub.request<{ workflow: SpaceWorkflow }>('spaceWorkflow.update', {
      id: workflowId,
      spaceId,
      ...params,
    });
    return workflow;
  }

  async deleteWorkflow(workflowId: string): Promise<void> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    await hub.request('spaceWorkflow.delete', { id: workflowId, spaceId });
  }

  async syncWorkflowFromTemplate(
    workflowId: string,
    expectedRowHash?: string
  ): Promise<SpaceWorkflow> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { workflow } = await hub.request<{ workflow: SpaceWorkflow }>(
      'spaceWorkflow.syncFromTemplate',
      {
        id: workflowId,
        spaceId,
        ...(expectedRowHash !== undefined ? { expectedRowHash } : {}),
      }
    );
    return workflow;
  }

  async previewWorkflowTemplateSync(workflowId: string): Promise<SpaceWorkflowSyncPreview> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { preview } = await hub.request<{ preview: SpaceWorkflowSyncPreview }>(
      'spaceWorkflow.previewTemplateSync',
      { id: workflowId, spaceId }
    );
    return preview;
  }

  upsertGoal(goal: SpaceGoal): void {
    this.goalListRequestVersion += 1;
    const existing = this.goals.value.filter((current) => current.id !== goal.id);
    this.goals.value = [...existing, goal].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async listGoals(options: Omit<SpaceGoalListParams, 'spaceId'> = {}): Promise<SpaceGoal[]> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const requestVersion = ++this.goalListRequestVersion;
    const { goals } = await hub.request<{ goals: SpaceGoal[] }>('spaceGoal.list', {
      ...options,
      spaceId,
    });
    if (this.spaceId.value === spaceId && this.goalListRequestVersion === requestVersion) {
      this.goals.value = goals ?? [];
    }
    return goals ?? [];
  }

  async fetchGoal(goalId: string): Promise<SpaceGoal> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { goal } = await hub.request<{ goal: SpaceGoal }>('spaceGoal.get', { spaceId, goalId });
    if (goal && this.spaceId.value === spaceId) this.upsertGoal(goal);
    return goal;
  }

  async createGoal(params: Omit<CreateSpaceGoalParams, 'spaceId'>): Promise<SpaceGoal> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { goal } = await hub.request<{ goal: SpaceGoal }>('spaceGoal.create', {
      ...params,
      spaceId,
    });
    if (goal && this.spaceId.value === spaceId) this.upsertGoal(goal);
    return goal;
  }

  async updateGoal(
    goalId: string,
    params: Pick<
      UpdateSpaceGoalParams,
      | 'title'
      | 'description'
      | 'status'
      | 'type'
      | 'priority'
      | 'labels'
      | 'metrics'
      | 'summary'
      | 'progress'
      | 'nextSteps'
      | 'preferredWorkflowId'
      | 'autoTriggerNext'
      | 'checkInCronExpression'
      | 'checkInTimezone'
    >
  ): Promise<SpaceGoal> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { goal } = await hub.request<{ goal: SpaceGoal }>('spaceGoal.update', {
      ...params,
      spaceId,
      goalId,
    });
    if (goal && this.spaceId.value === spaceId) this.upsertGoal(goal);
    return goal;
  }

  async pauseGoal(goalId: string): Promise<SpaceGoal> {
    return this.runGoalAction('spaceGoal.pause', goalId);
  }

  async resumeGoal(goalId: string): Promise<SpaceGoal> {
    return this.runGoalAction('spaceGoal.resume', goalId);
  }

  async archiveGoal(goalId: string): Promise<SpaceGoal> {
    return this.updateGoal(goalId, { status: 'archived' });
  }

  async createImmediateGoalTask(goalId: string): Promise<{
    goal: SpaceGoal;
    task: SpaceTask | null;
    queued: boolean;
  }> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const result = await hub.request<{
      goal: SpaceGoal;
      task: SpaceTask | null;
      queued: boolean;
    }>('spaceGoal.createImmediateTask', { spaceId, goalId });
    if (result?.goal && this.spaceId.value === spaceId) this.upsertGoal(result.goal);
    if (result?.task && this.spaceId.value === spaceId) {
      this.tasks.value = this.upsertTaskOnePerRun(this.tasks.value, result.task);
    }
    return result;
  }

  async listGoalEvents(goalId: string): Promise<SpaceGoalEvent[]> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { events } = await hub.request<{ events: SpaceGoalEvent[] }>('spaceGoal.listEvents', {
      spaceId,
      goalId,
      limit: 20,
    });
    if (this.spaceId.value === spaceId) {
      this.goalEvents.value = new Map(this.goalEvents.value).set(goalId, events ?? []);
    }
    return events ?? [];
  }

  private upsertGoalOwner(goalId: string, owner: SpaceGoalOwnerResolution): void {
    this.goalOwners.value = new Map(this.goalOwners.value).set(goalId, owner);
  }

  async fetchGoalOwner(goalId: string): Promise<SpaceGoalOwnerResolution | null> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { owner } = await hub.request<{ owner: SpaceGoalOwnerResolution }>('spaceGoal.getOwner', {
      spaceId,
      goalId,
    });
    if (owner && this.spaceId.value === spaceId) this.upsertGoalOwner(goalId, owner);
    return owner ?? null;
  }

  async assignGoalOwner(goalId: string, agentId: string): Promise<SpaceGoalOwnerResolution> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { owner } = await hub.request<{ owner: SpaceGoalOwnerResolution }>(
      'spaceGoal.assignOwner',
      { spaceId, goalId, agentId }
    );
    if (owner && this.spaceId.value === spaceId) this.upsertGoalOwner(goalId, owner);
    return owner;
  }

  async unassignGoalOwner(goalId: string): Promise<SpaceGoalOwnerResolution> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { owner } = await hub.request<{ owner: SpaceGoalOwnerResolution }>(
      'spaceGoal.unassignOwner',
      { spaceId, goalId }
    );
    if (owner && this.spaceId.value === spaceId) this.upsertGoalOwner(goalId, owner);
    return owner;
  }

  private async runGoalAction(method: 'spaceGoal.pause' | 'spaceGoal.resume', goalId: string) {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { goal } = await hub.request<{ goal: SpaceGoal }>(method, { spaceId, goalId });
    if (goal && this.spaceId.value === spaceId) this.upsertGoal(goal);
    return goal;
  }

  async createSchedule(params: {
    title: string;
    description?: string;
    priority?: SpaceTaskPriority;
    preferredWorkflowId?: string | null;
    labels?: string[];
    triggerType: TaskScheduleTriggerType;
    cronExpression?: string | null;
    runAt?: number | null;
    timezone?: string | null;
  }): Promise<TaskSchedule> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { schedule } = await hub.request<{ schedule: TaskSchedule }>('taskSchedule.create', {
      ...params,
      spaceId,
    });
    if (this.spaceId.value !== spaceId) return schedule;
    this.schedules.value = [...this.schedules.value, schedule];
    return schedule;
  }

  async listSchedules(status?: TaskScheduleStatus): Promise<TaskSchedule[]> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');

    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { schedules } = await hub.request<{ schedules: TaskSchedule[] }>('taskSchedule.list', {
      spaceId,
      status,
    });
    if (this.spaceId.value !== spaceId) return schedules;
    this.schedules.value = schedules;
    return schedules;
  }

  async getSchedule(scheduleId: string): Promise<TaskSchedule | null> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { schedule } = await hub.request<{ schedule: TaskSchedule | null }>('taskSchedule.get', {
      scheduleId,
      spaceId,
    });
    return schedule;
  }

  async pauseSchedule(scheduleId: string): Promise<TaskSchedule> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { schedule } = await hub.request<{ schedule: TaskSchedule }>('taskSchedule.pause', {
      scheduleId,
      spaceId,
    });
    this.schedules.value = this.schedules.value.map((s) => (s.id === scheduleId ? schedule : s));
    return schedule;
  }

  async resumeSchedule(scheduleId: string): Promise<TaskSchedule> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    const { schedule } = await hub.request<{ schedule: TaskSchedule }>('taskSchedule.resume', {
      scheduleId,
      spaceId,
    });
    this.schedules.value = this.schedules.value.map((s) => (s.id === scheduleId ? schedule : s));
    return schedule;
  }

  async deleteSchedule(scheduleId: string): Promise<void> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');

    await hub.request('taskSchedule.delete', { scheduleId, spaceId });
    this.schedules.value = this.schedules.value.filter((s) => s.id !== scheduleId);
  }
}

export const spaceStore = new SpaceStore();
