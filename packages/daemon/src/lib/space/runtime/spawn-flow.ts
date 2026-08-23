import type {
  NodeExecution,
  Space,
  SpaceTask,
  SpaceWorkflow,
  SpaceWorkflowRun,
  WorkflowNode,
  WorkflowNodeAgent,
} from '@hyperneo/shared';
import { decideSpawnExecutionAdmissionViaPipeline } from './spawn-admission-decision-pipeline';
import type { WorkflowNodeSlotResolution } from './spawn-slot-resolution';
import { resolveWorkflowNodeSlot } from './spawn-slot-resolution';
import { stagedRun, type StagedRunOutcome } from './staged-run';
import { validateExecutionAgainstWorkflow } from './workflow-node-execution-validation';

export interface IndexedSessionInspection {
  sessionId: string | null;
  alive: boolean;
}

export interface SpawnSessionRequest {
  task: SpaceTask;
  space: Space;
  workflow: SpaceWorkflow;
  workflowRun: SpaceWorkflowRun;
  execution: NodeExecution;
  node: WorkflowNode;
  slot: WorkflowNodeAgent;
  sessionId: string;
  workspacePath: string;
  kickoff: boolean;
}

export interface AttachNodeAgentRequest {
  task: SpaceTask;
  space: Space;
  workflowRun: SpaceWorkflowRun;
  execution: NodeExecution;
  sessionId: string;
  workspacePath: string;
}

export interface KickoffMessageRequest {
  task: SpaceTask;
  space: Space;
  workflow: SpaceWorkflow;
  workflowRun: SpaceWorkflowRun;
  execution: NodeExecution;
  node: WorkflowNode;
  slot: WorkflowNodeAgent;
  sessionId: string;
  workspacePath: string;
}

export interface SpawnExecutionFlowDeps {
  getFreshTask(taskId: string): SpaceTask | null;
  getNodeExecution(executionId: string): NodeExecution | null;
  isSpawningExecution(executionId: string): boolean;
  inspectIndexedSession(agentSessionId: string | null): IndexedSessionInspection;
  reserveExecution(executionId: string): void;
  releaseExecution(executionId: string): void;
  reserveTaskSpawn(taskId: string): 'won' | 'superseded';
  releaseTaskSpawn(taskId: string): void;
  cancelSpawnedSession(sessionId: string): void;
  rebindLiveExecution(execution: NodeExecution, sessionId: string): 'won' | 'superseded';
  raiseSpawnRejection(
    freshTask: SpaceTask,
    execution: NodeExecution,
    workflow: SpaceWorkflow
  ): never;
  resolveSpawnSessionId(space: Space, task: SpaceTask, execution: NodeExecution): string;
  resolveWorkspacePath(task: SpaceTask, space: Space): Promise<string>;
  createSpawnedSession(request: SpawnSessionRequest): Promise<string>;
  bindExecutionToSession(execution: NodeExecution, sessionId: string): 'won' | 'superseded';
  flushPendingMessagesForTarget(workflowRunId: string, agentName: string, sessionId: string): void;
  attachNodeAgent(request: AttachNodeAgentRequest): Promise<void>;
  registerSpawnCompletionCallback(taskId: string, workflowNodeId: string, sessionId: string): void;
  buildKickoffMessage(request: KickoffMessageRequest): Promise<string>;
  injectKickoffMessage(sessionId: string, message: string): Promise<void>;
}

export interface SpawnExecutionFlowInput {
  task: SpaceTask;
  space: Space;
  workflow: SpaceWorkflow;
  workflowRun: SpaceWorkflowRun;
  execution: NodeExecution;
  kickoff: boolean;
}

interface SpawnExecutionFlowState extends SpawnExecutionFlowInput {
  freshTask: SpaceTask;
  slotResolution: WorkflowNodeSlotResolution | null;
  workflowValid: boolean;
  isSpawning: boolean;
  indexedSession: IndexedSessionInspection;
  spawnedSessionId: string;
  workspacePath: string;
}

export function isSpawnFlowWaitConcurrent(result: unknown): result is {
  kind: 'wait_concurrent';
} {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { kind?: unknown }).kind === 'wait_concurrent'
  );
}

export function isSpawnFlowReusedSession(result: unknown): result is {
  kind: 'reused_session';
  sessionId: string;
} {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { kind?: unknown }).kind === 'reused_session'
  );
}

interface SpawnAttemptBox {
  sessionId: string | null;
  workspacePath: string | null;
}

export function runSpawnExecutionFlow(
  deps: SpawnExecutionFlowDeps,
  input: SpawnExecutionFlowInput
): Promise<StagedRunOutcome> {
  const attempt: SpawnAttemptBox = { sessionId: null, workspacePath: null };
  const executionId = input.execution.id;
  const flow = stagedRun<SpawnExecutionFlowState>(
    'spawn-execution',
    (s) => [
      s.snapshot({
        name: 'gather-spawn-admission',
        provides: ['freshTask', 'slotResolution', 'workflowValid', 'isSpawning', 'indexedSession'],
        reads: ['task', 'workflow', 'execution'],
        run: (view) => ({
          freshTask: deps.getFreshTask(view.task.id) ?? view.task,
          slotResolution: resolveWorkflowNodeSlot(
            view.workflow,
            view.execution.workflowNodeId,
            view.execution.agentName
          ),
          workflowValid: validateExecutionAgainstWorkflow(view.execution, view.workflow).valid,
          isSpawning: deps.isSpawningExecution(view.execution.id),
          indexedSession: deps.inspectIndexedSession(view.execution.agentSessionId),
        }),
      }),
      s.decide({
        name: 'admission',
        reads: ['freshTask', 'slotResolution', 'workflowValid', 'isSpawning', 'indexedSession'],
        branches: ['reuseLive', 'waitConcurrent', 'rejectSpawn', 'proceedFresh'],
        run: (view) => {
          const liveSessionId = view.indexedSession.alive ? view.indexedSession.sessionId : null;
          const admission = decideSpawnExecutionAdmissionViaPipeline({
            hasLiveIndexedSession: liveSessionId !== null,
            isSpawningExecution: view.isSpawning,
            taskStatus: view.freshTask.status,
            executionWorkflowValid: view.workflowValid,
            slotResolvable: view.slotResolution !== null,
          });
          return {
            decision: admission,
            reuseLive:
              admission.action === 'reuse_live' ? { sessionId: liveSessionId! } : undefined,
            waitConcurrent: admission.action === 'wait_concurrent' ? true : undefined,
            rejectSpawn:
              admission.action === 'reject_permanent' || admission.action === 'reject_transient'
                ? true
                : undefined,
            proceedFresh: admission.action === 'proceed_fresh' ? true : undefined,
          };
        },
      }),
      s.effect({
        name: 'rebind-live-session',
        when: 'reuseLive',
        reads: ['execution'],
        writes: [],
        run: (view) =>
          deps.rebindLiveExecution(
            view.execution,
            (view.reuseLive as { sessionId: string }).sessionId
          ),
      }),
      s.halt({
        name: 'return-live-session',
        when: 'reuseLive',
        run: (view) => ({
          kind: 'reused_session',
          sessionId: (view.reuseLive as { sessionId: string }).sessionId,
        }),
      }),
      s.halt({
        name: 'defer-to-concurrent-spawn',
        when: 'waitConcurrent',
        run: () => ({ kind: 'wait_concurrent' }),
      }),
      s.halt({
        name: 'raise-spawn-rejection',
        when: 'rejectSpawn',
        reads: ['freshTask', 'execution', 'workflow'],
        run: (view) => {
          deps.raiseSpawnRejection(view.freshTask, view.execution, view.workflow);
        },
      }),
      s.effect({
        name: 'reserve-task-spawn',
        when: 'proceedFresh',
        reads: ['task'],
        writes: [],
        run: (view) => deps.reserveTaskSpawn(view.task.id),
        compensate: (view, result) => {
          if (result === 'superseded') return;
          deps.releaseTaskSpawn(view.task.id);
        },
      }),
      s.effect({
        name: 'reserve-and-spawn-session',
        when: 'proceedFresh',
        reads: [
          'task',
          'space',
          'workflow',
          'workflowRun',
          'execution',
          'slotResolution',
          'kickoff',
        ],
        writes: ['isSpawning'],
        run: async (view) => {
          deps.reserveExecution(view.execution.id);
          const sessionId = deps.resolveSpawnSessionId(view.space, view.task, view.execution);
          const workspacePath = await deps.resolveWorkspacePath(view.task, view.space);
          const slotResolution = view.slotResolution!;
          attempt.workspacePath = workspacePath;
          attempt.sessionId = await deps.createSpawnedSession({
            task: view.task,
            space: view.space,
            workflow: view.workflow,
            workflowRun: view.workflowRun,
            execution: view.execution,
            node: slotResolution.node,
            slot: slotResolution.slot,
            sessionId,
            workspacePath,
            kickoff: view.kickoff,
          });
        },
        compensate: () => {
          if (attempt.sessionId !== null) {
            deps.cancelSpawnedSession(attempt.sessionId);
          }
          deps.releaseExecution(executionId);
        },
      }),
      s.resnapshot({
        name: 'read-spawn-attempt',
        when: 'proceedFresh',
        provides: ['spawnedSessionId', 'workspacePath'],
        run: () => {
          if (attempt.sessionId === null || attempt.workspacePath === null) {
            throw new Error(`Spawn attempt for execution ${executionId} has no spawned session`);
          }
          return { spawnedSessionId: attempt.sessionId, workspacePath: attempt.workspacePath };
        },
      }),
      s.effect({
        name: 'bind-execution-session',
        when: 'proceedFresh',
        reads: ['execution', 'spawnedSessionId'],
        writes: ['execution'],
        run: (view) => deps.bindExecutionToSession(view.execution, view.spawnedSessionId),
      }),
      s.resnapshot({
        name: 'read-bound-execution',
        when: 'proceedFresh',
        provides: ['execution'],
        run: () => {
          const bound = deps.getNodeExecution(executionId);
          if (!bound) {
            throw new Error(`Spawn flow cannot re-read execution ${executionId} after binding`);
          }
          return { execution: bound };
        },
      }),
      s.effect({
        name: 'release-task-spawn',
        when: 'proceedFresh',
        reads: ['task'],
        writes: [],
        run: (view) => {
          deps.releaseTaskSpawn(view.task.id);
        },
      }),
      s.effect({
        name: 'flush-pending-messages',
        when: 'proceedFresh',
        reads: ['workflowRun', 'execution', 'spawnedSessionId'],
        writes: [],
        run: (view) => {
          deps.flushPendingMessagesForTarget(
            view.workflowRun.id,
            view.execution.agentName,
            view.spawnedSessionId
          );
        },
      }),
      s.effect({
        name: 'attach-node-agent',
        when: 'proceedFresh',
        reads: ['task', 'space', 'workflowRun', 'execution', 'spawnedSessionId', 'workspacePath'],
        writes: [],
        run: async (view) => {
          await deps.attachNodeAgent({
            task: view.task,
            space: view.space,
            workflowRun: view.workflowRun,
            execution: view.execution,
            sessionId: view.spawnedSessionId,
            workspacePath: view.workspacePath,
          });
          deps.registerSpawnCompletionCallback(
            view.task.id,
            view.execution.workflowNodeId,
            view.spawnedSessionId
          );
        },
      }),
      s.effect({
        name: 'kickoff-session',
        when: 'proceedFresh',
        reads: [
          'task',
          'space',
          'workflow',
          'workflowRun',
          'execution',
          'slotResolution',
          'spawnedSessionId',
          'workspacePath',
          'kickoff',
        ],
        writes: [],
        run: async (view) => {
          if (!view.kickoff) return;
          const slotResolution = view.slotResolution!;
          const message = await deps.buildKickoffMessage({
            task: view.task,
            space: view.space,
            workflow: view.workflow,
            workflowRun: view.workflowRun,
            execution: view.execution,
            node: slotResolution.node,
            slot: slotResolution.slot,
            sessionId: view.spawnedSessionId,
            workspacePath: view.workspacePath,
          });
          await deps.injectKickoffMessage(view.spawnedSessionId, message);
        },
      }),
      s.halt({
        name: 'complete-spawn',
        when: 'proceedFresh',
        reads: ['spawnedSessionId'],
        run: (view) => view.spawnedSessionId,
      }),
    ],
    { input: ['task', 'space', 'workflow', 'workflowRun', 'execution', 'kickoff'] }
  );
  return flow(input);
}
