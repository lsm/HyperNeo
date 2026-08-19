import { describe, expect, it, mock, beforeEach } from 'bun:test';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { MessageHub } from '@hyperneo/shared';
import type { SpaceTask } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  setupSpaceTaskMessageHandlers,
  parseMentions,
  type TaskAgentManagerInterface,
  type NodeExecutionLookup,
  type ChannelCycleResetter,
} from '../../../../src/lib/rpc-handlers/space-task-message-handlers';
import type { Database } from '../../../../src/storage/database';
import type { AgentSession } from '../../../../src/lib/agent/agent-session';
import type {
  DaemonInternalEventMap,
  InternalEventBus,
} from '../../../../src/lib/internal-event-bus';
import { ChannelCycleRepository } from '../../../../src/storage/repositories/channel-cycle-repository';
import { createSpaceTables } from '../../helpers/space-test-db';

type RequestHandler = (data: unknown) => Promise<unknown>;

const NOW = Date.now();

const mockTaskWithSession: SpaceTask = {
  id: 'task-1',
  spaceId: 'space-1',
  taskNumber: 1,
  title: 'Test Task',
  description: 'A task description',
  status: 'in_progress',
  priority: 'normal',
  dependsOn: [],
  taskAgentSessionId: 'space:space-1:task:task-1',
  createdAt: NOW,
  updatedAt: NOW,
};

const mockTaskWithoutSession: SpaceTask = {
  id: 'task-2',
  spaceId: 'space-1',
  taskNumber: 2,
  title: 'Pending Task',
  description: 'Not yet spawned',
  status: 'pending',
  priority: 'normal',
  dependsOn: [],
  taskAgentSessionId: undefined,
  createdAt: NOW,
  updatedAt: NOW,
};

const mockSDKMessages: SDKMessage[] = [
  {
    type: 'user',
    uuid: 'msg-1' as import('crypto').UUID,
    session_id: 'space:space-1:task:task-1',
    parent_tool_use_id: null,
    message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
  },
] as unknown as SDKMessage[];

function createMockMessageHub(): {
  hub: MessageHub;
  handlers: Map<string, RequestHandler>;
} {
  const handlers = new Map<string, RequestHandler>();
  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    onEvent: mock(() => () => {}),
    request: mock(async () => {}),
    event: mock(() => {}),
    joinChannel: mock(async () => {}),
    leaveChannel: mock(async () => {}),
    isConnected: mock(() => true),
    getState: mock(() => 'connected' as const),
    onConnection: mock(() => () => {}),
    onMessage: mock(() => () => {}),
    cleanup: mock(() => {}),
    registerTransport: mock(() => () => {}),
    registerRouter: mock(() => {}),
    getRouter: mock(() => null),
    getPendingCallCount: mock(() => 0),
  } as unknown as MessageHub;
  return { hub, handlers };
}

function createMockAgentSession(messages = mockSDKMessages): Partial<AgentSession> {
  return {
    getSDKMessages: mock((_limit?: number, _before?: number) => ({
      messages,
      hasMore: false,
    })),
  };
}

function createMockTaskAgentManager(
  liveSession: Partial<AgentSession> | null = null,
  ensuredTask: SpaceTask = mockTaskWithSession
): TaskAgentManagerInterface {
  return {};
}

function createMockDatabase(
  task: SpaceTask | null,
  dbMessages: SDKMessage[] = mockSDKMessages
): Database {
  return {
    getDatabase: mock(() => ({
      prepare: mock((_sql: string) => ({
        get: mock((_id: string) => {
          if (!task) return undefined;
          return {
            id: task.id,
            space_id: task.spaceId,
            title: task.title,
            description: task.description,
            status: task.status,
            priority: task.priority,
            depends_on: '[]',
            task_agent_session_id: task.taskAgentSessionId ?? null,
            workflow_node_id: null,
            workflow_run_id: task.workflowRunId ?? null,
            result: null,
            error: null,
            archived_at: null,
            created_at: task.createdAt,
            updated_at: task.updatedAt,
          };
        }),
      })),
    })),
    getSDKMessages: mock((_sessionId: string, _limit?: number, _before?: number) => ({
      messages: dbMessages,
      hasMore: false,
    })),
  } as unknown as Database;
}

describe('setupSpaceTaskMessageHandlers', () => {
  let hub: MessageHub;
  let handlers: Map<string, RequestHandler>;
  let taskAgentManager: TaskAgentManagerInterface;
  let db: Database;
  let internalEventBus: InternalEventBus<DaemonInternalEventMap>;

  function setup(
    task: SpaceTask | null = mockTaskWithSession,
    liveSession: Partial<AgentSession> | null = null,
    ensuredTask: SpaceTask = mockTaskWithSession
  ) {
    const mh = createMockMessageHub();
    hub = mh.hub;
    handlers = mh.handlers;
    taskAgentManager = createMockTaskAgentManager(liveSession, ensuredTask);
    db = createMockDatabase(task);
    internalEventBus = {
      publish: mock(async () => ({ delivered: 0, failures: [] })),
      publishAsync: mock(() => {}),
    } as unknown as InternalEventBus<DaemonInternalEventMap>;
    setupSpaceTaskMessageHandlers(hub, taskAgentManager, db, internalEventBus);
  }

  const call = (method: string, data: unknown) => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`No handler registered for ${method}`);
    return handler(data);
  };

  function makeNodeExecutionRepo(
    agents: Array<{
      id?: string;
      workflowNodeId?: string;
      agentName: string;
      agentSessionId: string | null;
      status?: string;
    }>
  ): NodeExecutionLookup {
    return {
      listByWorkflowRun: mock(() =>
        agents.map((a) => ({ ...a, status: a.status ?? 'in_progress' }))
      ),
    };
  }

  describe('handler registration', () => {
    beforeEach(() => setup());

    it('registers space.task.sendMessage handler', () => {
      expect(handlers.has('space.task.sendMessage')).toBe(true);
    });
  });

  describe('space.task.sendMessage', () => {
    beforeEach(() => setup());

    it('throws "Target agent is required" when no target and no @mentions', async () => {
      await expect(
        call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: 'Please continue',
        })
      ).rejects.toThrow('Target agent is required');
    });

    it('throws when spaceId is missing', async () => {
      await expect(
        call('space.task.sendMessage', { taskId: 'task-1', message: 'Hello' })
      ).rejects.toThrow('spaceId is required');
    });

    it('throws when taskId is missing', async () => {
      await expect(
        call('space.task.sendMessage', { spaceId: 'space-1', message: 'Hello' })
      ).rejects.toThrow('taskId is required');
    });

    it('throws when message is missing', async () => {
      await expect(
        call('space.task.sendMessage', { spaceId: 'space-1', taskId: 'task-1' })
      ).rejects.toThrow('message is required');
    });

    it('throws when message is whitespace-only', async () => {
      await expect(
        call('space.task.sendMessage', { spaceId: 'space-1', taskId: 'task-1', message: '   ' })
      ).rejects.toThrow('message is required');
    });

    it('throws when task is stopped with a resume hint', async () => {
      setup({ ...mockTaskWithSession, status: 'stopped' });
      await expect(
        call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: 'ping',
        })
      ).rejects.toThrow(/stopped — resume it before sending messages/);
    });

    it('throws when message exceeds 100,000 characters', async () => {
      const longMessage = 'x'.repeat(100_001);
      await expect(
        call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: longMessage,
        })
      ).rejects.toThrow('Message is too long');
    });

    it('throws when task is not found', async () => {
      setup(null);
      await expect(
        call('space.task.sendMessage', { spaceId: 'space-1', taskId: 'ghost', message: 'Hello' })
      ).rejects.toThrow('Task not found: ghost');
    });

    it('throws when taskId belongs to a different space (cross-space isolation)', async () => {
      await expect(
        call('space.task.sendMessage', {
          spaceId: 'space-other',
          taskId: 'task-1',
          message: 'Hello',
        })
      ).rejects.toThrow('Task not found: task-1');
    });

    describe('generic targets', () => {
      const mockTaskWithWorkflowRun: SpaceTask = {
        ...mockTaskWithSession,
        workflowRunId: 'run-abc-123',
      };

      function setupGenericTarget(
        nodeExecAgents: Array<{
          id?: string;
          workflowNodeId?: string;
          agentName: string;
          agentSessionId: string | null;
          status?: string;
        }>
      ) {
        const mh = createMockMessageHub();
        hub = mh.hub;
        handlers = mh.handlers;
        const injectSubSession = mock(async () => {});
        taskAgentManager = {
          ...createMockTaskAgentManager(null, mockTaskWithWorkflowRun),
          injectSubSessionMessage: injectSubSession,
        };
        db = createMockDatabase(mockTaskWithWorkflowRun);
        internalEventBus = {
          publish: mock(async () => ({ delivered: 0, failures: [] })),
          publishAsync: mock(() => {}),
        } as unknown as InternalEventBus<DaemonInternalEventMap>;
        setupSpaceTaskMessageHandlers(
          hub,
          taskAgentManager,
          db,
          internalEventBus,
          makeNodeExecutionRepo(nodeExecAgents)
        );
        return { injectSubSession };
      }

      it('routes @session targets by live session id', async () => {
        const { injectSubSession } = setupGenericTarget([
          {
            id: 'exec-reviewer',
            workflowNodeId: 'node-review',
            agentName: 'Reviewer',
            agentSessionId: 'session-reviewer-1',
          },
        ]);

        await call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: 'direct to session',
          target: { kind: 'generic', target: '@session:session-reviewer-1' },
        });

        expect(injectSubSession).toHaveBeenCalledWith(
          'session-reviewer-1',
          'direct to session',
          false,
          undefined,
          undefined
        );
      });

      it('routes @worker targets by exact node id only', async () => {
        const { injectSubSession } = setupGenericTarget([
          {
            id: 'exec-reviewer-a',
            workflowNodeId: 'node-review-a',
            agentName: 'Reviewer',
            agentSessionId: 'session-reviewer-a',
          },
          {
            id: 'exec-reviewer-b',
            workflowNodeId: 'node-review-b',
            agentName: 'Reviewer',
            agentSessionId: 'session-reviewer-b',
          },
        ]);

        await call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: 'direct to worker',
          target: { kind: 'generic', target: '@worker:run-abc-123/node-review-a/Reviewer' },
        });

        expect(injectSubSession).toHaveBeenCalledWith(
          'session-reviewer-a',
          'direct to worker',
          false,
          undefined,
          undefined
        );
        expect(injectSubSession).not.toHaveBeenCalledWith(
          'session-reviewer-b',
          'direct to worker',
          false,
          undefined,
          undefined
        );
      });

      it('rejects partial node-name matches for @worker targets', async () => {
        setupGenericTarget([
          {
            id: 'exec-reviewer-a',
            workflowNodeId: 'node-review-a',
            agentName: 'Reviewer',
            agentSessionId: 'session-reviewer-a',
          },
          {
            id: 'exec-reviewer-b',
            workflowNodeId: 'node-review-b',
            agentName: 'Reviewer',
            agentSessionId: 'session-reviewer-b',
          },
        ]);

        await expect(
          call('space.task.sendMessage', {
            spaceId: 'space-1',
            taskId: 'task-1',
            message: 'ambiguous worker',
            target: { kind: 'generic', target: '@worker:run-abc-123/review/Reviewer' },
          })
        ).rejects.toThrow('Workflow worker not found');
      });

      it('rejects cross-run @worker targets', async () => {
        setupGenericTarget([
          {
            id: 'exec-reviewer',
            workflowNodeId: 'node-review',
            agentName: 'Reviewer',
            agentSessionId: 'session-reviewer-1',
          },
        ]);

        await expect(
          call('space.task.sendMessage', {
            spaceId: 'space-1',
            taskId: 'task-1',
            message: 'wrong run',
            target: { kind: 'generic', target: '@worker:other-run/node-review/Reviewer' },
          })
        ).rejects.toThrow('other-run');
      });
    });

    describe('image attachments', () => {
      const sampleImage = {
        media_type: 'image/png' as const,
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
      };

      it('forwards images to injectSubSessionMessage on @mention routing', async () => {
        const mockTaskWithWorkflowRun: SpaceTask = {
          ...mockTaskWithSession,
          workflowRunId: 'run-abc-123',
        };
        const mh = createMockMessageHub();
        hub = mh.hub;
        handlers = mh.handlers;
        const injectSubSession = mock(async () => {});
        taskAgentManager = {
          ...createMockTaskAgentManager(null, mockTaskWithWorkflowRun),
          injectSubSessionMessage: injectSubSession,
        };
        db = createMockDatabase(mockTaskWithWorkflowRun);
        internalEventBus = {
          publish: mock(async () => ({ delivered: 0, failures: [] })),
          publishAsync: mock(() => {}),
        } as unknown as InternalEventBus<DaemonInternalEventMap>;
        const nodeExecutionRepo = makeNodeExecutionRepo([
          { agentName: 'Coder', agentSessionId: 'session-coder-1' },
        ]);
        setupSpaceTaskMessageHandlers(
          hub,
          taskAgentManager,
          db,
          internalEventBus,
          nodeExecutionRepo
        );

        await call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: '@Coder check this screenshot',
          images: [sampleImage],
        });

        expect(injectSubSession).toHaveBeenCalledWith(
          'session-coder-1',
          '@Coder check this screenshot',
          false,
          [sampleImage],
          undefined
        );
      });

      it('forwards images to injectSubSessionMessage on explicit node-agent target', async () => {
        const mockTaskWithWorkflowRun: SpaceTask = {
          ...mockTaskWithSession,
          workflowRunId: 'run-abc-123',
        };
        const mh = createMockMessageHub();
        hub = mh.hub;
        handlers = mh.handlers;
        const injectSubSession = mock(async () => {});
        taskAgentManager = {
          ...createMockTaskAgentManager(null, mockTaskWithWorkflowRun),
          injectSubSessionMessage: injectSubSession,
        };
        db = createMockDatabase(mockTaskWithWorkflowRun);
        internalEventBus = {
          publish: mock(async () => ({ delivered: 0, failures: [] })),
          publishAsync: mock(() => {}),
        } as unknown as InternalEventBus<DaemonInternalEventMap>;
        const nodeExecutionRepo = makeNodeExecutionRepo([
          {
            id: 'exec-reviewer',
            workflowNodeId: 'node-1',
            agentName: 'Reviewer',
            agentSessionId: 'session-reviewer-1',
          },
        ]);
        setupSpaceTaskMessageHandlers(
          hub,
          taskAgentManager,
          db,
          internalEventBus,
          nodeExecutionRepo
        );

        await call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: 'Please review the attached design',
          target: { kind: 'node_agent', agentName: 'Reviewer' },
          images: [sampleImage],
        });

        expect(injectSubSession).toHaveBeenCalledWith(
          'session-reviewer-1',
          'Please review the attached design',
          false,
          [sampleImage],
          undefined
        );
      });

      it('rejects images destined for a not-yet-spawned node agent rather than silently dropping them', async () => {
        const mockTaskWithWorkflowRun: SpaceTask = {
          ...mockTaskWithSession,
          workflowRunId: 'run-abc-123',
        };
        const mh = createMockMessageHub();
        hub = mh.hub;
        handlers = mh.handlers;
        const injectSubSession = mock(async () => {});
        taskAgentManager = {
          ...createMockTaskAgentManager(null, mockTaskWithWorkflowRun),
          injectSubSessionMessage: injectSubSession,
        };
        db = createMockDatabase(mockTaskWithWorkflowRun);
        internalEventBus = {
          publish: mock(async () => ({ delivered: 0, failures: [] })),
          publishAsync: mock(() => {}),
        } as unknown as InternalEventBus<DaemonInternalEventMap>;
        const nodeExecutionRepo = makeNodeExecutionRepo([
          {
            id: 'exec-reviewer',
            workflowNodeId: 'node-1',
            agentName: 'Reviewer',
            agentSessionId: null,
          },
        ]);
        const pendingMessageQueue = {
          enqueue: mock(() => ({ record: { id: 'pending-1' }, deduped: false })),
        };
        setupSpaceTaskMessageHandlers(
          hub,
          taskAgentManager,
          db,
          internalEventBus,
          nodeExecutionRepo,
          undefined,
          undefined,
          pendingMessageQueue
        );

        await expect(
          call('space.task.sendMessage', {
            spaceId: 'space-1',
            taskId: 'task-1',
            message: 'Take a look at this',
            target: { kind: 'node_agent', agentName: 'Reviewer' },
            images: [sampleImage],
          })
        ).rejects.toThrow(/images.*starting|starting.*images/i);

        expect(pendingMessageQueue.enqueue).not.toHaveBeenCalled();
        expect(injectSubSession).not.toHaveBeenCalled();
      });
    });

    describe('delivery mode forwarding', () => {
      const mockTaskWithWorkflowRun: SpaceTask = {
        ...mockTaskWithSession,
        workflowRunId: 'run-dm-1',
      };

      function setupDeliveryMode() {
        const mh = createMockMessageHub();
        hub = mh.hub;
        handlers = mh.handlers;
        const injectSubSession = mock(async () => {});
        taskAgentManager = {
          ...createMockTaskAgentManager(null, mockTaskWithWorkflowRun),
          injectSubSessionMessage: injectSubSession,
        };
        db = createMockDatabase(mockTaskWithWorkflowRun);
        internalEventBus = {
          publish: mock(async () => ({ delivered: 0, failures: [] })),
          publishAsync: mock(() => {}),
        } as unknown as InternalEventBus<DaemonInternalEventMap>;
        setupSpaceTaskMessageHandlers(
          hub,
          taskAgentManager,
          db,
          internalEventBus,
          makeNodeExecutionRepo([
            {
              id: 'exec-coder',
              workflowNodeId: 'node-1',
              agentName: 'Coder',
              agentSessionId: 'session-coder-1',
            },
          ])
        );
        return { injectSubSession };
      }

      it('forwards deliveryMode:"defer" as the 5th arg on an explicit node-agent target', async () => {
        const { injectSubSession } = setupDeliveryMode();

        await call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: 'for next turn',
          target: { kind: 'node_agent', agentName: 'Coder' },
          deliveryMode: 'defer',
        });

        expect(injectSubSession).toHaveBeenCalledWith(
          'session-coder-1',
          'for next turn',
          false,
          undefined,
          'defer'
        );
      });

      it('forwards deliveryMode:"defer" on @mention routing', async () => {
        const { injectSubSession } = setupDeliveryMode();

        await call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: '@Coder see this next',
          deliveryMode: 'defer',
        });

        expect(injectSubSession).toHaveBeenCalledWith(
          'session-coder-1',
          '@Coder see this next',
          false,
          undefined,
          'defer'
        );
      });

      it('forwards undefined (immediate) when deliveryMode is omitted', async () => {
        const { injectSubSession } = setupDeliveryMode();

        await call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: 'steer now',
          target: { kind: 'node_agent', agentName: 'Coder' },
        });

        expect(injectSubSession).toHaveBeenCalledWith(
          'session-coder-1',
          'steer now',
          false,
          undefined,
          undefined
        );
      });

      it('forwards deliveryMode:"defer" to the execution-less post-approval worker', async () => {
        const mh = createMockMessageHub();
        hub = mh.hub;
        handlers = mh.handlers;
        const injectSubSession = mock(async () => {});
        taskAgentManager = {
          ...createMockTaskAgentManager(null, mockTaskWithWorkflowRun),
          injectSubSessionMessage: injectSubSession,
          getPostApprovalWorkerSession: mock(() => ({
            sessionId: 'worker-session',
            agentName: 'merger',
          })),
        } as TaskAgentManagerInterface;
        db = createMockDatabase(mockTaskWithWorkflowRun);
        internalEventBus = {
          publish: mock(async () => ({ delivered: 0, failures: [] })),
          publishAsync: mock(() => {}),
        } as unknown as InternalEventBus<DaemonInternalEventMap>;
        setupSpaceTaskMessageHandlers(
          hub,
          taskAgentManager,
          db,
          internalEventBus,
          makeNodeExecutionRepo([])
        );

        await call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: 'merge after idle',
          target: { kind: 'node_agent', agentName: 'merger' },
          deliveryMode: 'defer',
        });

        expect(injectSubSession).toHaveBeenCalledWith(
          'worker-session',
          'merge after idle',
          false,
          undefined,
          'defer'
        );
      });

      it('rejects an invalid deliveryMode at the RPC boundary', async () => {
        setupDeliveryMode();

        await expect(
          call('space.task.sendMessage', {
            spaceId: 'space-1',
            taskId: 'task-1',
            message: 'bad mode',
            target: { kind: 'node_agent', agentName: 'Coder' },
            deliveryMode: 'later' as 'defer',
          })
        ).rejects.toThrow('Invalid deliveryMode');
      });

      it('persists deliveryMode:"defer" on the pending row when the target is not live yet', async () => {
        const mh = createMockMessageHub();
        hub = mh.hub;
        handlers = mh.handlers;
        const enqueued: Array<{ targetAgentName: string; deliveryMode?: string }> = [];
        taskAgentManager = {
          ...createMockTaskAgentManager(null, mockTaskWithWorkflowRun),
          injectSubSessionMessage: mock(async () => {}),
        };
        db = createMockDatabase(mockTaskWithWorkflowRun);
        internalEventBus = {
          publish: mock(async () => ({ delivered: 0, failures: [] })),
          publishAsync: mock(() => {}),
        } as unknown as InternalEventBus<DaemonInternalEventMap>;
        setupSpaceTaskMessageHandlers(
          hub,
          taskAgentManager,
          db,
          internalEventBus,
          makeNodeExecutionRepo([
            {
              id: 'exec-coder',
              workflowNodeId: 'node-1',
              agentName: 'Coder',
              agentSessionId: null,
            },
          ]),
          undefined,
          undefined,
          {
            enqueue: mock((input: { targetAgentName: string; deliveryMode?: string }) => {
              enqueued.push({
                targetAgentName: input.targetAgentName,
                deliveryMode: input.deliveryMode,
              });
              return { record: { id: 'pending-1' }, deduped: false };
            }),
          }
        );

        const result = (await call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: 'for after spawn',
          target: { kind: 'node_agent', agentName: 'Coder' },
          deliveryMode: 'defer',
        })) as { queued?: boolean };

        expect(result.queued).toBe(true);
        expect(enqueued).toHaveLength(1);
        expect(enqueued[0].targetAgentName).toBe('Coder');
        expect(enqueued[0].deliveryMode).toBe('defer');
      });
    });

    describe('post-approval worker routing', () => {
      const mockTaskWithWorkflowRun: SpaceTask = {
        ...mockTaskWithSession,
        workflowRunId: 'run-pa-123',
      };
      const mergerSessionId = 'space:space-1:task:task-1:post-approval:merger';

      function setupPostApproval(opts: {
        postApproval?: { sessionId: string; agentName: string } | null;
        declared?: string[];
        injectImpl?: (subSessionId: string) => Promise<void>;
        restoreResult?: string | null;
        withQueue?: boolean;
      }) {
        const mh = createMockMessageHub();
        hub = mh.hub;
        handlers = mh.handlers;
        const injectSubSession = mock(opts.injectImpl ?? (async () => {}));
        taskAgentManager = {
          ...createMockTaskAgentManager(null, mockTaskWithWorkflowRun),
          injectSubSessionMessage: injectSubSession,
          ...(opts.postApproval !== undefined
            ? {
                getPostApprovalWorkerSession: mock(() => opts.postApproval),
              }
            : {}),
          ...(opts.declared
            ? { getWorkflowDeclaredAgentNamesForTask: mock(() => opts.declared!) }
            : {}),
          ...(opts.restoreResult !== undefined
            ? { restorePostApprovalWorkerSession: mock(async () => opts.restoreResult!) }
            : {}),
        } as TaskAgentManagerInterface;
        db = createMockDatabase(mockTaskWithWorkflowRun);
        internalEventBus = {
          publish: mock(async () => ({ delivered: 0, failures: [] })),
          publishAsync: mock(() => {}),
        } as unknown as InternalEventBus<DaemonInternalEventMap>;
        const pendingMessageQueue = opts.withQueue
          ? { enqueue: mock(() => ({ record: { id: 'pending-1' }, deduped: false })) }
          : undefined;
        setupSpaceTaskMessageHandlers(
          hub,
          taskAgentManager,
          db,
          internalEventBus,
          makeNodeExecutionRepo([]),
          undefined,
          undefined,
          pendingMessageQueue
        );
        return { injectSubSession, pendingMessageQueue };
      }

      it('routes a merger reply (agentName target) directly to the post-approval session', async () => {
        const { injectSubSession } = setupPostApproval({
          postApproval: { sessionId: mergerSessionId, agentName: 'merger' },
        });

        const res = await call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: 'Rebase onto dev and retry the merge',
          target: { kind: 'node_agent', agentName: 'merger' },
        });

        expect(res).toEqual({ ok: true, routedTo: ['merger'] });
        expect(injectSubSession).toHaveBeenCalledTimes(1);
        expect(injectSubSession.mock.calls[0][0]).toBe(mergerSessionId);
      });

      it('matches the post-approval session exactly by agentName', async () => {
        const { injectSubSession } = setupPostApproval({
          postApproval: { sessionId: mergerSessionId, agentName: 'merger' },
        });

        const res = await call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: 'go',
          target: { kind: 'node_agent', agentName: 'merger' },
        });

        expect(res).toEqual({ ok: true, routedTo: ['merger'] });
        expect(injectSubSession).toHaveBeenCalledTimes(1);
      });

      it('does not collapse an unmatched target onto the post-approval worker', async () => {
        const { injectSubSession } = setupPostApproval({
          postApproval: { sessionId: mergerSessionId, agentName: 'merger' },
          declared: ['coder', 'reviewer', 'merger'],
        });

        await expect(
          call('space.task.sendMessage', {
            spaceId: 'space-1',
            taskId: 'task-1',
            message: 'continue',
            target: { kind: 'node_agent', agentName: 'coder' },
          })
        ).rejects.toThrow('Workflow agent not found: coder');
        expect(injectSubSession).not.toHaveBeenCalled();
      });

      it('restores the worker when it is not in memory, then delivers the reply', async () => {
        let callCount = 0;
        const { injectSubSession, pendingMessageQueue } = setupPostApproval({
          postApproval: { sessionId: mergerSessionId, agentName: 'merger' },
          restoreResult: mergerSessionId,
          withQueue: true,
          injectImpl: async () => {
            callCount += 1;
            if (callCount === 1) throw new Error(`Sub-session not found: ${mergerSessionId}`);
          },
        });

        const res = await call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: 'retry now',
          target: { kind: 'node_agent', agentName: 'merger' },
        });

        expect(res).toEqual({ ok: true, routedTo: ['merger'] });
        expect(injectSubSession).toHaveBeenCalledTimes(2);
        expect(injectSubSession.mock.calls[1][0]).toBe(mergerSessionId);
        expect(pendingMessageQueue!.enqueue).not.toHaveBeenCalled();
      });

      it('fails honestly when the worker cannot be restored', async () => {
        setupPostApproval({
          postApproval: { sessionId: mergerSessionId, agentName: 'merger' },
          restoreResult: null,
          injectImpl: async () => {
            throw new Error(`Sub-session not found: ${mergerSessionId}`);
          },
        });

        await expect(
          call('space.task.sendMessage', {
            spaceId: 'space-1',
            taskId: 'task-1',
            message: 'retry',
            target: { kind: 'node_agent', agentName: 'merger' },
          })
        ).rejects.toThrow(/not live and could not be restored/);
      });

      it('rethrows non-rehydrate inject errors (e.g. terminal task) instead of restoring', async () => {
        const { pendingMessageQueue } = setupPostApproval({
          postApproval: { sessionId: mergerSessionId, agentName: 'merger' },
          restoreResult: mergerSessionId,
          withQueue: true,
          injectImpl: async () => {
            throw new Error('Cannot inject message to session — task/run is terminal (cancelled)');
          },
        });

        await expect(
          call('space.task.sendMessage', {
            spaceId: 'space-1',
            taskId: 'task-1',
            message: 'x',
            target: { kind: 'node_agent', agentName: 'merger' },
          })
        ).rejects.toThrow('terminal');
        expect(pendingMessageQueue!.enqueue).not.toHaveBeenCalled();
      });

      it('does not match the worker by name when an execution id disambiguates the target', async () => {
        const { injectSubSession } = setupPostApproval({
          postApproval: { sessionId: mergerSessionId, agentName: 'merger' },
          declared: ['merger'],
        });

        await expect(
          call('space.task.sendMessage', {
            spaceId: 'space-1',
            taskId: 'task-1',
            message: 'x',
            target: { kind: 'node_agent', agentName: 'merger', nodeExecutionId: 'exec-xyz' },
          })
        ).rejects.toThrow('Workflow agent not found');
        expect(injectSubSession).not.toHaveBeenCalled();
      });

      it('diagnostics list workflow-declared slots, not only execution rows', async () => {
        setupPostApproval({
          postApproval: { sessionId: mergerSessionId, agentName: 'merger' },
          declared: ['coder', 'reviewer', 'merger'],
        });

        await expect(
          call('space.task.sendMessage', {
            spaceId: 'space-1',
            taskId: 'task-1',
            message: 'hi',
            target: { kind: 'node_agent', agentName: 'nonexistent' },
          })
        ).rejects.toThrow(/Available agents: coder, merger, reviewer/);
      });
    });
  });

  describe('@mention routing in space.task.sendMessage', () => {
    const mockTaskWithWorkflowRun: SpaceTask = {
      ...mockTaskWithSession,
      workflowRunId: 'run-abc-123',
    };

    function setupWithMention(
      nodeExecAgents: Array<{ agentName: string; agentSessionId: string | null; status?: string }>,
      task: SpaceTask = mockTaskWithWorkflowRun
    ) {
      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;
      const injectSubSession = mock(async (_sid: string, _msg: string) => {});
      taskAgentManager = {
        ...createMockTaskAgentManager(null, task),
        injectSubSessionMessage: injectSubSession,
      };
      db = createMockDatabase(task);
      internalEventBus = {
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as InternalEventBus<DaemonInternalEventMap>;
      const nodeExecutionRepo = makeNodeExecutionRepo(nodeExecAgents);
      setupSpaceTaskMessageHandlers(hub, taskAgentManager, db, internalEventBus, nodeExecutionRepo);
      return { injectSubSession };
    }

    it('single @mention routes to the matched agent session', async () => {
      const { injectSubSession } = setupWithMention([
        { agentName: 'Coder', agentSessionId: 'session-coder-1' },
        { agentName: 'Reviewer', agentSessionId: 'session-reviewer-1' },
      ]);

      const result = await call('space.task.sendMessage', {
        spaceId: 'space-1',
        taskId: 'task-1',
        message: '@Coder please fix the bug',
      });

      expect(result).toMatchObject({ ok: true, routedTo: ['Coder'] });
      expect(injectSubSession).toHaveBeenCalledTimes(1);
      expect(injectSubSession).toHaveBeenCalledWith(
        'session-coder-1',
        '@Coder please fix the bug',
        false,
        undefined,
        undefined
      );
    });

    it('does not @mention-inject into a spawn-retry pending dead session', async () => {
      const { injectSubSession } = setupWithMention([
        { agentName: 'Coder', agentSessionId: 'session-coder-live' },
        {
          agentName: 'Reviewer',
          agentSessionId: 'session-reviewer-dead',
          status: 'pending',
        },
      ]);

      await expect(
        call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: '@Reviewer please review',
        })
      ).rejects.toThrow('@mention not found: Reviewer');
      expect(injectSubSession).not.toHaveBeenCalledWith(
        'session-reviewer-dead',
        '@Reviewer please review',
        false,
        undefined,
        undefined
      );
    });

    it('multiple @mentions route to all mentioned agents', async () => {
      const { injectSubSession } = setupWithMention([
        { agentName: 'Coder', agentSessionId: 'session-coder-1' },
        { agentName: 'Reviewer', agentSessionId: 'session-reviewer-1' },
        { agentName: 'Planner', agentSessionId: 'session-planner-1' },
      ]);

      const result = await call('space.task.sendMessage', {
        spaceId: 'space-1',
        taskId: 'task-1',
        message: '@Coder and @Reviewer please coordinate',
      });

      expect(result).toMatchObject({ ok: true });
      const res = result as { routedTo: string[] };
      expect(res.routedTo).toHaveLength(2);
      expect(res.routedTo).toContain('Coder');
      expect(res.routedTo).toContain('Reviewer');
      expect(injectSubSession).toHaveBeenCalledTimes(2);
    });

    it('invalid @mention throws error listing available agents', async () => {
      setupWithMention([
        { agentName: 'Coder', agentSessionId: 'session-coder-1' },
        { agentName: 'Reviewer', agentSessionId: 'session-reviewer-1' },
      ]);

      await expect(
        call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: '@Ghost please do something',
        })
      ).rejects.toThrow('@mention not found: Ghost');
      await expect(
        call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: '@Ghost please do something',
        })
      ).rejects.toThrow('Coder, Reviewer');
    });

    it('ambiguous @mention (multiple agents with same name) routes to all matching sessions', async () => {
      const { injectSubSession } = setupWithMention([
        { agentName: 'Coder', agentSessionId: 'session-coder-1' },
        { agentName: 'Coder', agentSessionId: 'session-coder-2' },
      ]);

      const result = await call('space.task.sendMessage', {
        spaceId: 'space-1',
        taskId: 'task-1',
        message: '@Coder please check both',
      });

      expect(result).toMatchObject({ ok: true, routedTo: ['Coder'] });
      expect(injectSubSession).toHaveBeenCalledTimes(2);
      expect(injectSubSession).toHaveBeenCalledWith(
        'session-coder-1',
        '@Coder please check both',
        false,
        undefined,
        undefined
      );
      expect(injectSubSession).toHaveBeenCalledWith(
        'session-coder-2',
        '@Coder please check both',
        false,
        undefined,
        undefined
      );
    });

    it('partial routing: valid mentions route, invalid mentions listed in notFound', async () => {
      const { injectSubSession } = setupWithMention([
        { agentName: 'Coder', agentSessionId: 'session-coder-1' },
      ]);

      const result = (await call('space.task.sendMessage', {
        spaceId: 'space-1',
        taskId: 'task-1',
        message: '@Coder and @Ghost please help',
      })) as { ok: boolean; routedTo: string[]; notFound: string[] };

      expect(result.ok).toBe(true);
      expect(result.routedTo).toEqual(['Coder']);
      expect(result.notFound).toEqual(['Ghost']);
      expect(injectSubSession).toHaveBeenCalledTimes(1);
    });

    it('case-insensitive @mention matching', async () => {
      const { injectSubSession } = setupWithMention([
        { agentName: 'Coder', agentSessionId: 'session-coder-1' },
      ]);

      const result = await call('space.task.sendMessage', {
        spaceId: 'space-1',
        taskId: 'task-1',
        message: '@coder please fix',
      });

      expect(result).toMatchObject({ ok: true, routedTo: ['coder'] });
      expect(injectSubSession).toHaveBeenCalledWith(
        'session-coder-1',
        '@coder please fix',
        false,
        undefined,
        undefined
      );
    });

    it('explicit node-agent target routes by node execution id without @mention text', async () => {
      const { injectSubSession } = setupWithMention([
        {
          id: 'exec-coder',
          workflowNodeId: 'node-1',
          agentName: 'Coder',
          agentSessionId: 'session-coder-1',
        },
        {
          id: 'exec-reviewer',
          workflowNodeId: 'node-1',
          agentName: 'Reviewer',
          agentSessionId: 'session-reviewer-1',
        },
      ]);

      const result = await call('space.task.sendMessage', {
        spaceId: 'space-1',
        taskId: 'task-1',
        message: 'Please review this',
        target: {
          kind: 'node_agent',
          agentName: 'Reviewer',
          nodeExecutionId: 'exec-reviewer',
        },
      });

      expect(result).toMatchObject({ ok: true, routedTo: ['Reviewer'] });
      expect(injectSubSession).toHaveBeenCalledTimes(1);
      expect(injectSubSession).toHaveBeenCalledWith(
        'session-reviewer-1',
        'Please review this',
        false,
        undefined,
        undefined
      );
    });

    it('routes @mention to idle agents — core fix for the reported bug', async () => {
      const { injectSubSession } = setupWithMention([
        { agentName: 'Reviewer', agentSessionId: 'session-reviewer-idle', status: 'idle' },
      ]);

      const result = await call('space.task.sendMessage', {
        spaceId: 'space-1',
        taskId: 'task-1',
        message: '@Reviewer please review',
      });

      expect(result).toMatchObject({ ok: true, routedTo: ['Reviewer'] });
      expect(injectSubSession).toHaveBeenCalledWith(
        'session-reviewer-idle',
        '@Reviewer please review',
        false,
        undefined,
        undefined
      );
    });

    it('only excludes cancelled agents — idle, blocked, and pending are all routable', async () => {
      const { injectSubSession } = setupWithMention([
        { agentName: 'Coder', agentSessionId: 'session-coder-cancelled', status: 'cancelled' },
        { agentName: 'Coder', agentSessionId: 'session-coder-idle', status: 'idle' },
        { agentName: 'Coder', agentSessionId: 'session-coder-blocked', status: 'blocked' },
        { agentName: 'Coder', agentSessionId: 'session-coder-active', status: 'in_progress' },
      ]);

      const result = await call('space.task.sendMessage', {
        spaceId: 'space-1',
        taskId: 'task-1',
        message: '@Coder please check',
      });

      expect(result).toMatchObject({ ok: true, routedTo: ['Coder'] });
      expect(injectSubSession).toHaveBeenCalledTimes(3);
      expect(injectSubSession).not.toHaveBeenCalledWith(
        'session-coder-cancelled',
        expect.anything(),
        false,
        undefined,
        undefined
      );
      expect(injectSubSession).toHaveBeenCalledWith(
        'session-coder-idle',
        '@Coder please check',
        false,
        undefined,
        undefined
      );
      expect(injectSubSession).toHaveBeenCalledWith(
        'session-coder-blocked',
        '@Coder please check',
        false,
        undefined,
        undefined
      );
      expect(injectSubSession).toHaveBeenCalledWith(
        'session-coder-active',
        '@Coder please check',
        false,
        undefined,
        undefined
      );
    });

    it('@mention throws when all matching agents are cancelled', async () => {
      setupWithMention([
        { agentName: 'Coder', agentSessionId: 'session-coder-cancelled', status: 'cancelled' },
      ]);

      await expect(
        call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: '@Coder please help',
        })
      ).rejects.toThrow('@mention not found: Coder');
    });

    it('propagates error when injectSubSessionMessage throws', async () => {
      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;
      const injectSubSession = mock(async (_sid: string, _msg: string) => {
        throw new Error('Sub-session not found: session-coder-1');
      });
      taskAgentManager = {
        ...createMockTaskAgentManager(null, mockTaskWithWorkflowRun),
        injectSubSessionMessage: injectSubSession,
      };
      db = createMockDatabase(mockTaskWithWorkflowRun);
      internalEventBus = {
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as InternalEventBus<DaemonInternalEventMap>;
      const nodeExecutionRepo = makeNodeExecutionRepo([
        { agentName: 'Coder', agentSessionId: 'session-coder-1', status: 'in_progress' },
      ]);
      setupSpaceTaskMessageHandlers(hub, taskAgentManager, db, internalEventBus, nodeExecutionRepo);

      await expect(
        call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: '@Coder please help',
        })
      ).rejects.toThrow('Sub-session not found: session-coder-1');
    });

    it('routes an @merger mention to the execution-less post-approval worker', async () => {
      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;
      const mergerSession = 'space:space-1:task:task-1:post-approval:merger';
      const injectSubSession = mock(async (_sid: string, _msg: string) => {});
      taskAgentManager = {
        ...createMockTaskAgentManager(null, mockTaskWithWorkflowRun),
        injectSubSessionMessage: injectSubSession,
        getPostApprovalWorkerSession: mock(() => ({
          sessionId: mergerSession,
          agentName: 'merger',
        })),
      } as TaskAgentManagerInterface;
      db = createMockDatabase(mockTaskWithWorkflowRun);
      internalEventBus = {
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as InternalEventBus<DaemonInternalEventMap>;
      setupSpaceTaskMessageHandlers(
        hub,
        taskAgentManager,
        db,
        internalEventBus,
        makeNodeExecutionRepo([])
      );

      const result = await call('space.task.sendMessage', {
        spaceId: 'space-1',
        taskId: 'task-1',
        message: '@merger rebase and retry',
      });

      expect(result).toMatchObject({ ok: true, routedTo: ['merger'] });
      expect(injectSubSession).toHaveBeenCalledTimes(1);
      expect(injectSubSession.mock.calls[0][0]).toBe(mergerSession);
    });

    it('rethrows a resolved @merger mention delivery error instead of masking it as not-found', async () => {
      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;
      const mergerSession = 'space:space-1:task:task-1:post-approval:merger';
      const injectSubSession = mock(async (_sid: string, _msg: string) => {
        throw new Error('Cannot inject message to session — task/run is terminal (cancelled)');
      });
      taskAgentManager = {
        ...createMockTaskAgentManager(null, mockTaskWithWorkflowRun),
        injectSubSessionMessage: injectSubSession,
        getPostApprovalWorkerSession: mock(() => ({
          sessionId: mergerSession,
          agentName: 'merger',
        })),
      } as TaskAgentManagerInterface;
      db = createMockDatabase(mockTaskWithWorkflowRun);
      internalEventBus = {
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as InternalEventBus<DaemonInternalEventMap>;
      setupSpaceTaskMessageHandlers(
        hub,
        taskAgentManager,
        db,
        internalEventBus,
        makeNodeExecutionRepo([])
      );

      await expect(
        call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: '@merger retry',
        })
      ).rejects.toThrow('terminal');
    });
  });

  describe('explicit target: matcher correctness (PR #1660 review)', () => {
    const mockTaskWithRun: SpaceTask = {
      ...mockTaskWithSession,
      workflowRunId: 'run-match-1',
    };

    function setupWithActivation(opts: {
      nodeExecAgents: Array<{
        id?: string;
        workflowNodeId?: string;
        agentName: string;
        agentSessionId: string | null;
        status?: string;
      }>;
      activateNode?: (runId: string, nodeId: string) => Promise<void>;
      includeQueue?: boolean;
    }) {
      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;
      const injectSubSession = mock(async (_sid: string, _msg: string) => {});
      taskAgentManager = {
        ...createMockTaskAgentManager(null, mockTaskWithRun),
        injectSubSessionMessage: injectSubSession,
      };
      db = createMockDatabase(mockTaskWithRun);
      internalEventBus = {
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as InternalEventBus<DaemonInternalEventMap>;

      const nodeExecCalls: Array<{ runId: string; nodeId: string }> = [];
      const mockActivateNode = opts.activateNode
        ? mock(async (runId: string, nodeId: string) => {
            nodeExecCalls.push({ runId, nodeId });
            await opts.activateNode!(runId, nodeId);
          })
        : undefined;

      const enqueueCalls: Array<{
        targetAgentName: string;
        message: string;
        sourceAgentName?: string | null;
      }> = [];
      let pendingQueue: { enqueue: ReturnType<typeof mock> } | undefined;
      if (opts.includeQueue ?? true) {
        pendingQueue = {
          enqueue: mock(
            (input: {
              targetAgentName: string;
              message: string;
              sourceAgentName?: string | null;
            }) => {
              enqueueCalls.push({
                targetAgentName: input.targetAgentName,
                message: input.message,
                sourceAgentName: input.sourceAgentName,
              });
              return { record: { id: `pending-\${enqueueCalls.length}` }, deduped: false };
            }
          ),
        };
      }

      const nodeExecutionRepo = makeNodeExecutionRepo(opts.nodeExecAgents);

      setupSpaceTaskMessageHandlers(
        mh.hub,
        taskAgentManager,
        db,
        internalEventBus,
        nodeExecutionRepo,
        undefined,
        mockActivateNode,
        pendingQueue as Parameters<typeof setupSpaceTaskMessageHandlers>[7]
      );

      return {
        injectSubSession,
        nodeExecCalls,
        enqueueCalls,
        activateNode: mockActivateNode,
      };
    }

    it('nodeExecutionId mismatch with valid agentName throws (does not broaden)', async () => {
      const { injectSubSession } = setupWithActivation({
        nodeExecAgents: [
          {
            id: 'exec-coder-B',
            workflowNodeId: 'node-2',
            agentName: 'Coder',
            agentSessionId: 'session-coder-b',
          },
        ],
      });

      await expect(
        call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: 'Please fix',
          target: {
            kind: 'node_agent',
            agentName: 'Coder',
            nodeExecutionId: 'exec-coder-A',
          },
        })
      ).rejects.toThrow('Workflow agent not found');
      expect(injectSubSession).not.toHaveBeenCalled();
    });

    it('agentName-only target fans out to all same-named executions', async () => {
      const { injectSubSession } = setupWithActivation({
        nodeExecAgents: [
          {
            id: 'exec-coder-A',
            workflowNodeId: 'node-1',
            agentName: 'Coder',
            agentSessionId: 'session-coder-a',
          },
          {
            id: 'exec-coder-B',
            workflowNodeId: 'node-2',
            agentName: 'Coder',
            agentSessionId: 'session-coder-b',
          },
        ],
      });

      const result = await call('space.task.sendMessage', {
        spaceId: 'space-1',
        taskId: 'task-1',
        message: 'Please check both',
        target: {
          kind: 'node_agent',
          agentName: 'Coder',
        },
      });

      expect(result).toMatchObject({ ok: true, routedTo: ['Coder'] });
      expect(injectSubSession).toHaveBeenCalledTimes(2);
      expect(injectSubSession).toHaveBeenCalledWith(
        'session-coder-a',
        'Please check both',
        false,
        undefined,
        undefined
      );
      expect(injectSubSession).toHaveBeenCalledWith(
        'session-coder-b',
        'Please check both',
        false,
        undefined,
        undefined
      );
    });

    it('workflowNodeId scopes an agentName-only target to the clicked node', async () => {
      const { injectSubSession } = setupWithActivation({
        nodeExecAgents: [
          {
            id: 'exec-coder-A',
            workflowNodeId: 'node-1',
            agentName: 'Coder',
            agentSessionId: 'session-coder-a',
          },
          {
            id: 'exec-coder-B',
            workflowNodeId: 'node-2',
            agentName: 'Coder',
            agentSessionId: 'session-coder-b',
          },
        ],
      });

      const result = await call('space.task.sendMessage', {
        spaceId: 'space-1',
        taskId: 'task-1',
        message: 'just node two',
        target: { kind: 'node_agent', agentName: 'Coder', workflowNodeId: 'node-2' },
      });

      expect(result).toMatchObject({ ok: true, routedTo: ['Coder'] });
      expect(injectSubSession).toHaveBeenCalledTimes(1);
      expect(injectSubSession).toHaveBeenCalledWith(
        'session-coder-b',
        'just node two',
        false,
        undefined,
        undefined
      );
      expect(injectSubSession).not.toHaveBeenCalledWith(
        'session-coder-a',
        'just node two',
        false,
        undefined,
        undefined
      );
    });

    it('fails a send pinned to a session that no longer has an execution (no lazy-activation fallback)', async () => {
      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;
      const injectSub = mock(async (_sid: string, _msg: string) => {});
      taskAgentManager = {
        ...createMockTaskAgentManager(null, mockTaskWithRun),
        injectSubSessionMessage: injectSub,
        getWorkflowDeclaredAgentNamesForTask: mock(() => ['Coder']),
        ensureWorkflowNodeActivationForAgent: mock(async () => true),
      };
      db = createMockDatabase(mockTaskWithRun);
      internalEventBus = {
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as InternalEventBus<DaemonInternalEventMap>;
      setupSpaceTaskMessageHandlers(
        mh.hub,
        taskAgentManager,
        db,
        internalEventBus,
        makeNodeExecutionRepo([
          { agentName: 'Coder', agentSessionId: 'session-w2', workflowNodeId: 'node-1' },
        ]),
        undefined,
        undefined,
        undefined
      );

      await expect(
        call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: 'to w1',
          target: { kind: 'node_agent', agentName: 'Coder', sessionId: 'session-w1' },
        })
      ).rejects.toThrow('no longer attached');
      expect(injectSub).not.toHaveBeenCalled();
    });

    it('post-activation refresh stays scoped to the clicked node (no same-name capture)', async () => {
      const mutableRepo = {
        listByWorkflowRun: mock(() => [
          {
            id: 'exec-coder-A',
            workflowNodeId: 'node-1',
            agentName: 'Coder',
            agentSessionId: 'session-coder-a',
            status: 'in_progress',
          },
          {
            id: 'exec-coder-B',
            workflowNodeId: 'node-2',
            agentName: 'Coder',
            agentSessionId: null,
            status: 'in_progress',
          },
        ]),
      };
      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;
      const injectSub = mock(async (_sid: string, _msg: string) => {});
      taskAgentManager = {
        ...createMockTaskAgentManager(null, mockTaskWithRun),
        injectSubSessionMessage: injectSub,
      };
      db = createMockDatabase(mockTaskWithRun);
      internalEventBus = {
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as InternalEventBus<DaemonInternalEventMap>;
      const activateCalls: string[] = [];
      const mockActivate = mock(async (_runId: string, nodeId: string) => {
        activateCalls.push(nodeId);
        mutableRepo.listByWorkflowRun = mock(() => [
          {
            id: 'exec-coder-A',
            workflowNodeId: 'node-1',
            agentName: 'Coder',
            agentSessionId: 'session-coder-a',
            status: 'in_progress',
          },
          {
            id: 'exec-coder-B',
            workflowNodeId: 'node-2',
            agentName: 'Coder',
            agentSessionId: 'session-coder-b',
            status: 'in_progress',
          },
        ]);
      });
      setupSpaceTaskMessageHandlers(
        mh.hub,
        taskAgentManager,
        db,
        internalEventBus,
        mutableRepo,
        undefined,
        mockActivate,
        undefined
      );

      const result = await call('space.task.sendMessage', {
        spaceId: 'space-1',
        taskId: 'task-1',
        message: 'just node two',
        target: { kind: 'node_agent', agentName: 'Coder', workflowNodeId: 'node-2' },
      });

      expect(activateCalls).toEqual(['node-2']);
      expect(injectSub).toHaveBeenCalledTimes(1);
      expect(injectSub).toHaveBeenCalledWith(
        'session-coder-b',
        'just node two',
        false,
        undefined,
        undefined
      );
      expect(injectSub).not.toHaveBeenCalledWith(
        'session-coder-a',
        'just node two',
        false,
        undefined,
        undefined
      );
      expect(result).toMatchObject({ ok: true, routedTo: ['Coder'], activated: true });
    });

    it('node-scoped send to a sibling node is NOT misrouted into a legacy post-approval worker', async () => {
      const mutableRepo = {
        listByWorkflowRun: mock(
          () =>
            [] as Array<{
              id: string;
              workflowNodeId: string;
              agentName: string;
              agentSessionId: string | null;
              status: string;
            }>
        ),
      };
      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;
      const injectSub = mock(async (_sid: string, _msg: string) => {});
      const ensureCalls: Array<{ agentName: string; workflowNodeId?: string }> = [];
      taskAgentManager = {
        ...createMockTaskAgentManager(null, mockTaskWithRun),
        injectSubSessionMessage: injectSub,
        getPostApprovalWorkerSession: mock(() => ({
          sessionId: 'legacy-worker',
          agentName: 'merger',
          nodeId: 'node-merger',
        })),
        getWorkflowDeclaredAgentNamesForTask: mock(() => ['merger']),
        ensureWorkflowNodeActivationForAgent: mock(
          async (_taskId: string, agentName: string, options?: { workflowNodeId?: string }) => {
            ensureCalls.push({
              agentName,
              ...(options?.workflowNodeId ? { workflowNodeId: options.workflowNodeId } : {}),
            });
            mutableRepo.listByWorkflowRun = mock(() => [
              {
                id: 'exec-sibling',
                workflowNodeId: 'node-sibling',
                agentName: 'merger',
                agentSessionId: 'sibling-session',
                status: 'in_progress',
              },
            ]);
            return true;
          }
        ),
      };
      db = createMockDatabase(mockTaskWithRun);
      internalEventBus = {
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as InternalEventBus<DaemonInternalEventMap>;
      setupSpaceTaskMessageHandlers(
        mh.hub,
        taskAgentManager,
        db,
        internalEventBus,
        mutableRepo,
        undefined,
        undefined,
        undefined
      );

      const result = (await call('space.task.sendMessage', {
        spaceId: 'space-1',
        taskId: 'task-1',
        message: 'hi sibling',
        target: { kind: 'node_agent', agentName: 'merger', workflowNodeId: 'node-sibling' },
      })) as Record<string, unknown>;

      expect(injectSub).toHaveBeenCalledWith(
        'sibling-session',
        'hi sibling',
        false,
        undefined,
        undefined
      );
      expect(injectSub).not.toHaveBeenCalledWith(
        'legacy-worker',
        'hi sibling',
        false,
        undefined,
        undefined
      );
      expect(ensureCalls).toContainEqual({ agentName: 'merger', workflowNodeId: 'node-sibling' });
      expect(result).toMatchObject({ ok: true, routedTo: ['merger'] });
    });

    it('activateNode invoked once per unique missing workflowNodeId (deduped)', async () => {
      const { nodeExecCalls, injectSubSession } = setupWithActivation({
        nodeExecAgents: [
          {
            id: 'exec-coder-1',
            workflowNodeId: 'node-1',
            agentName: 'Coder',
            agentSessionId: null,
          },
          {
            id: 'exec-coder-2',
            workflowNodeId: 'node-1',
            agentName: 'Coder',
            agentSessionId: null,
          },
        ],
        activateNode: async () => {
          // No-op: session stays null after activation
        },
      });

      const result = await call('space.task.sendMessage', {
        spaceId: 'space-1',
        taskId: 'task-1',
        message: 'Wake up Coder',
        target: { kind: 'node_agent', agentName: 'Coder' },
      });

      expect(nodeExecCalls).toHaveLength(1);
      expect(nodeExecCalls[0].nodeId).toBe('node-1');
      expect(injectSubSession).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        ok: true,
        delivered: false,
        queued: true,
      });
    });

    it('activateNode + re-query delivers when session becomes available', async () => {
      const mutableRepo = {
        listByWorkflowRun: mock(() => [
          {
            id: 'exec-reviewer',
            workflowNodeId: 'node-rev',
            agentName: 'Reviewer',
            agentSessionId: null as string | null,
            status: 'in_progress',
          },
        ]),
      };

      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;
      const injectSub = mock(async (_sid: string, _msg: string) => {});
      taskAgentManager = {
        ...createMockTaskAgentManager(null, mockTaskWithRun),
        injectSubSessionMessage: injectSub,
      };
      db = createMockDatabase(mockTaskWithRun);
      internalEventBus = {
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as InternalEventBus<DaemonInternalEventMap>;

      const activateCalls: string[] = [];
      const mockActivate = mock(async (_runId: string, nodeId: string) => {
        activateCalls.push(nodeId);
        mutableRepo.listByWorkflowRun = mock(() => [
          {
            id: 'exec-reviewer',
            workflowNodeId: 'node-rev',
            agentName: 'Reviewer',
            agentSessionId: 'session-reviewer-live',
            status: 'in_progress',
          },
        ]);
      });

      setupSpaceTaskMessageHandlers(
        mh.hub,
        taskAgentManager,
        db,
        internalEventBus,
        mutableRepo,
        undefined,
        mockActivate,
        undefined
      );

      const result = await call('space.task.sendMessage', {
        spaceId: 'space-1',
        taskId: 'task-1',
        message: 'Please review',
        target: {
          kind: 'node_agent',
          agentName: 'Reviewer',
          nodeExecutionId: 'exec-reviewer',
        },
      });

      expect(activateCalls).toEqual(['node-rev']);
      expect(injectSub).toHaveBeenCalledTimes(1);
      expect(injectSub).toHaveBeenCalledWith(
        'session-reviewer-live',
        'Please review',
        false,
        undefined,
        undefined
      );
      expect(result).toMatchObject({
        ok: true,
        routedTo: ['Reviewer'],
        activated: true,
      });
      expect((result as { delivered?: boolean }).delivered).toBeUndefined();
    });

    it('activateNode throws -> handler surfaces error (no ok:true)', async () => {
      const { injectSubSession } = setupWithActivation({
        nodeExecAgents: [
          {
            id: 'exec-coder',
            workflowNodeId: 'node-1',
            agentName: 'Coder',
            agentSessionId: null,
          },
        ],
        activateNode: async () => {
          throw new Error('Activation failed: node not found');
        },
      });

      await expect(
        call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: 'Wake up',
          target: { kind: 'node_agent', agentName: 'Coder' },
        })
      ).rejects.toThrow('Activation failed: node not found');
      expect(injectSubSession).not.toHaveBeenCalled();
    });

    it('delivered:false + queued:true when session not available and queue is present', async () => {
      const { enqueueCalls, injectSubSession } = setupWithActivation({
        nodeExecAgents: [
          {
            id: 'exec-reviewer',
            workflowNodeId: 'node-rev',
            agentName: 'Reviewer',
            agentSessionId: null,
          },
        ],
        activateNode: async () => {
          // No-op: session stays null
        },
      });

      const result = await call('space.task.sendMessage', {
        spaceId: 'space-1',
        taskId: 'task-1',
        message: 'Queue this',
        target: { kind: 'node_agent', agentName: 'Reviewer' },
      });

      expect(result).toMatchObject({
        ok: true,
        routedTo: ['Reviewer'],
        delivered: false,
        queued: true,
        activated: true,
      });
      expect(enqueueCalls).toHaveLength(1);
      expect(enqueueCalls[0].targetAgentName).toBe('Reviewer');
      expect(enqueueCalls[0].message).toBe('Queue this');
      expect(enqueueCalls[0].sourceAgentName).toBe('human');
      expect(injectSubSession).not.toHaveBeenCalled();
    });

    it('delivered:false without queued when no pendingMessageQueue', async () => {
      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;
      const injectSubSession = mock(async (_sid: string, _msg: string) => {});
      taskAgentManager = {
        ...createMockTaskAgentManager(null, mockTaskWithRun),
        injectSubSessionMessage: injectSubSession,
      };
      db = createMockDatabase(mockTaskWithRun);
      internalEventBus = {
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as InternalEventBus<DaemonInternalEventMap>;

      const mockActivate = mock(async () => {});
      const nodeExecutionRepo = makeNodeExecutionRepo([
        {
          id: 'exec-coder',
          workflowNodeId: 'node-1',
          agentName: 'Coder',
          agentSessionId: null,
        },
      ]);

      setupSpaceTaskMessageHandlers(
        mh.hub,
        taskAgentManager,
        db,
        internalEventBus,
        nodeExecutionRepo,
        undefined,
        mockActivate,
        undefined
      );

      const result = await call('space.task.sendMessage', {
        spaceId: 'space-1',
        taskId: 'task-1',
        message: 'Orphaned',
        target: { kind: 'node_agent', agentName: 'Coder' },
      });

      expect(result).toMatchObject({
        ok: true,
        routedTo: ['Coder'],
        delivered: false,
        activated: true,
      });
      expect((result as { queued?: boolean }).queued).toBeUndefined();
      expect(injectSubSession).not.toHaveBeenCalled();
    });

    it('nodeExecutionRepo undefined -> "Workflow agent targeting is unavailable" error', async () => {
      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;
      taskAgentManager = createMockTaskAgentManager(null, mockTaskWithRun);
      db = createMockDatabase(mockTaskWithRun);
      internalEventBus = {
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as InternalEventBus<DaemonInternalEventMap>;

      setupSpaceTaskMessageHandlers(hub, taskAgentManager, db, internalEventBus);

      await expect(
        call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: 'Hello',
          target: { kind: 'node_agent', agentName: 'Coder' },
        })
      ).rejects.toThrow('Workflow agent targeting is unavailable');
    });

    it('injectSubSessionMessage undefined -> "Workflow agent targeting is unavailable" error', async () => {
      const mh = createMockMessageHub();
      hub = mh.hub;
      handlers = mh.handlers;
      taskAgentManager = {};
      db = createMockDatabase(mockTaskWithRun);
      internalEventBus = {
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as InternalEventBus<DaemonInternalEventMap>;

      const nodeExecutionRepo = makeNodeExecutionRepo([
        { agentName: 'Coder', agentSessionId: 'session-1' },
      ]);

      setupSpaceTaskMessageHandlers(hub, taskAgentManager, db, internalEventBus, nodeExecutionRepo);

      await expect(
        call('space.task.sendMessage', {
          spaceId: 'space-1',
          taskId: 'task-1',
          message: 'Hello',
          target: { kind: 'node_agent', agentName: 'Coder' },
        })
      ).rejects.toThrow('Workflow agent targeting is unavailable');
    });
  });

  describe('channel-cycle reset on human touch in space.task.sendMessage', () => {
    const mockTaskWithRun: SpaceTask = {
      ...mockTaskWithSession,
      workflowRunId: 'run-cyc-1',
    };

    const mockTaskNoRun: SpaceTask = {
      ...mockTaskWithSession,
      workflowRunId: undefined,
    };

    function setupForReset(
      task: SpaceTask,
      opts: { withNodeExec?: boolean; resetRows?: number } = {}
    ) {
      const mh = createMockMessageHub();
      const localHub = mh.hub;
      const localHandlers = mh.handlers;
      const injectSubSession = mock(async (_sid: string, _msg: string) => {});
      const localTaskAgentManager: TaskAgentManagerInterface = {
        ...createMockTaskAgentManager(null, task),
        injectSubSessionMessage: injectSubSession,
      };
      const localDb = createMockDatabase(task);
      const localInternalEventBus = {
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as InternalEventBus<DaemonInternalEventMap>;
      const resetter: ChannelCycleResetter = {
        resetAllForRun: mock((_runId: string) => opts.resetRows ?? 2),
      };
      const nodeExec: NodeExecutionLookup | undefined = opts.withNodeExec
        ? {
            listByWorkflowRun: mock(() => [
              { agentName: 'Coder', agentSessionId: 'sess-coder', status: 'in_progress' },
            ]),
          }
        : undefined;

      setupSpaceTaskMessageHandlers(
        localHub,
        localTaskAgentManager,
        localDb,
        localInternalEventBus,
        nodeExec,
        resetter
      );

      return {
        handlers: localHandlers,
        taskAgentManager: localTaskAgentManager,
        injectSubSession,
        internalEventBus: localInternalEventBus,
        resetter,
      };
    }

    it('resets cycle counters after a successful @mention injection (no explicit target)', async () => {
      const {
        handlers: h,
        resetter,
        internalEventBus: dh,
      } = setupForReset(mockTaskWithRun, { withNodeExec: true });

      const result = await (h.get('space.task.sendMessage') as RequestHandler)({
        spaceId: 'space-1',
        taskId: 'task-1',
        message: '@Coder please continue the work',
      });

      expect(result).toMatchObject({ ok: true, routedTo: ['Coder'] });
      expect(resetter.resetAllForRun).toHaveBeenCalledTimes(1);
      expect(resetter.resetAllForRun).toHaveBeenCalledWith('run-cyc-1');

      const publishCalls = (dh.publish as ReturnType<typeof mock>).mock.calls;
      const cyclesResetCall = publishCalls.find((c) => c[0] === 'space.workflowRun.cyclesReset') as
        | [string, Record<string, unknown>]
        | undefined;
      expect(cyclesResetCall).toBeDefined();
      expect(cyclesResetCall![1]).toMatchObject({
        runId: 'run-cyc-1',
        reason: 'human_touch',
        taskId: 'task-1',
        rowsReset: 2,
      });
    });

    it('resets cycle counters after a successful @mention injection', async () => {
      const {
        handlers: h,
        injectSubSession,
        resetter,
        internalEventBus: dh,
      } = setupForReset(mockTaskWithRun, { withNodeExec: true });

      const result = await (h.get('space.task.sendMessage') as RequestHandler)({
        spaceId: 'space-1',
        taskId: 'task-1',
        message: '@Coder please fix',
      });

      expect(result).toMatchObject({ ok: true, routedTo: ['Coder'] });
      expect(injectSubSession).toHaveBeenCalledTimes(1);
      expect(resetter.resetAllForRun).toHaveBeenCalledTimes(1);
      expect(resetter.resetAllForRun).toHaveBeenCalledWith('run-cyc-1');

      const publishCalls = (dh.publish as ReturnType<typeof mock>).mock.calls;
      expect(publishCalls.some((c) => c[0] === 'space.workflowRun.cyclesReset')).toBe(true);
    });

    it('does NOT publish cyclesReset when rowsReset is 0 (no subscriber wakeups for no-op)', async () => {
      const {
        handlers: h,
        resetter,
        internalEventBus: dh,
      } = setupForReset(mockTaskWithRun, {
        withNodeExec: true,
        resetRows: 0,
      });

      const result = await (h.get('space.task.sendMessage') as RequestHandler)({
        spaceId: 'space-1',
        taskId: 'task-1',
        message: '@Coder please continue',
      });

      expect(result).toMatchObject({ ok: true });
      expect(resetter.resetAllForRun).toHaveBeenCalledTimes(1);
      const publishCalls = (dh.publish as ReturnType<typeof mock>).mock.calls;
      expect(publishCalls.some((c) => c[0] === 'space.workflowRun.cyclesReset')).toBe(false);
    });

    it('does NOT reset when @mention routing fails (all mentions unresolved)', async () => {
      const { handlers: h, resetter } = setupForReset(mockTaskWithRun, { withNodeExec: true });

      await expect(
        (h.get('space.task.sendMessage') as RequestHandler)({
          spaceId: 'space-1',
          taskId: 'task-1',
          message: '@Ghost please fix',
        })
      ).rejects.toThrow('@mention not found: Ghost');

      expect(resetter.resetAllForRun).not.toHaveBeenCalled();
    });

    it('swallows resetter errors and still returns success (best-effort side-effect)', async () => {
      const { handlers: h, resetter } = setupForReset(mockTaskWithRun, { withNodeExec: true });
      (resetter.resetAllForRun as ReturnType<typeof mock>).mockImplementation(() => {
        throw new Error('DB connection lost');
      });

      const result = await (h.get('space.task.sendMessage') as RequestHandler)({
        spaceId: 'space-1',
        taskId: 'task-1',
        message: '@Coder please continue',
      });

      expect(result).toMatchObject({ ok: true });
      expect(resetter.resetAllForRun).toHaveBeenCalledTimes(1);
    });

    it('acceptance: 4 autonomous cycles + human message -> cycles reset -> 5th cycle allowed', async () => {
      const sqlite = new BunDatabase(':memory:');
      createSpaceTables(sqlite);
      const now = Date.now();
      sqlite.exec(
        `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('sp1', 'sp1', '/tmp/ws-acc', 'Space', ${now}, ${now})`
      );
      sqlite.exec(
        `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES ('wf1', 'sp1', 'WF', ${now}, ${now})`
      );
      sqlite.exec(
        `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at) VALUES ('run-cyc-1', 'sp1', 'wf1', 'Run', 'in_progress', ${now}, ${now})`
      );
      const cycleRepo = new ChannelCycleRepository(sqlite);

      const CHANNEL_INDEX = 1;
      for (let i = 0; i < 4; i++) {
        cycleRepo.recordCycleEvent('run-cyc-1', CHANNEL_INDEX, now - i * 1000);
      }
      expect(cycleRepo.countRecentCycleEvents('run-cyc-1', CHANNEL_INDEX)).toBe(4);

      const mh = createMockMessageHub();
      const taskAgent = createMockTaskAgentManager(null, {
        ...mockTaskWithSession,
        workflowRunId: 'run-cyc-1',
      });
      const localDb = createMockDatabase({ ...mockTaskWithSession, workflowRunId: 'run-cyc-1' });
      const localInternalEventBus = {
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as InternalEventBus<DaemonInternalEventMap>;

      const nodeExecRepo = makeNodeExecutionRepo([
        { agentName: 'Coder', agentSessionId: 'session-coder-1', status: 'in_progress' },
      ]);
      const injectSubSession = mock(async (_sid: string, _msg: string) => {});
      const taskAgentWithInject = {
        ...taskAgent,
        injectSubSessionMessage: injectSubSession,
      };
      setupSpaceTaskMessageHandlers(
        mh.hub,
        taskAgentWithInject,
        localDb,
        localInternalEventBus,
        nodeExecRepo,
        cycleRepo
      );

      const result = await (mh.handlers.get('space.task.sendMessage') as RequestHandler)({
        spaceId: 'space-1',
        taskId: 'task-1',
        message: '@Coder hold on, I have feedback',
      });
      expect(result).toMatchObject({ ok: true });

      expect(cycleRepo.countRecentCycleEvents('run-cyc-1', CHANNEL_INDEX)).toBe(0);

      cycleRepo.recordCycleEvent('run-cyc-1', CHANNEL_INDEX, now);
      expect(cycleRepo.countRecentCycleEvents('run-cyc-1', CHANNEL_INDEX)).toBe(1);

      sqlite.close();
    });

    it('NOT human touch: agent-to-agent delivery via injectSubSessionMessage does NOT reset', async () => {
      const sqlite = new BunDatabase(':memory:');
      createSpaceTables(sqlite);
      const now = Date.now();
      sqlite.exec(
        `INSERT INTO spaces (id, slug, workspace_path, name, created_at, updated_at) VALUES ('sp1', 'sp1', '/tmp/ws-a2a', 'Space', ${now}, ${now})`
      );
      sqlite.exec(
        `INSERT INTO space_workflows (id, space_id, name, created_at, updated_at) VALUES ('wf1', 'sp1', 'WF', ${now}, ${now})`
      );
      sqlite.exec(
        `INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, status, created_at, updated_at) VALUES ('run-a2a', 'sp1', 'wf1', 'Run', 'in_progress', ${now}, ${now})`
      );
      const cycleRepo = new ChannelCycleRepository(sqlite);
      cycleRepo.recordCycleEvent('run-a2a', 0, now);
      cycleRepo.recordCycleEvent('run-a2a', 0, now);
      const before = cycleRepo.countRecentCycleEvents('run-a2a', 0);
      expect(before).toBe(2);

      const injectSubSession = mock(async (_sid: string, _msg: string) => {});
      const taskAgent: TaskAgentManagerInterface = {
        injectSubSessionMessage: injectSubSession,
      };

      await taskAgent.injectSubSessionMessage!('sess-some-agent', 'hello from an agent');

      expect(cycleRepo.countRecentCycleEvents('run-a2a', 0)).toBe(before);

      sqlite.close();
    });

    it('is a no-op (no error) when channelCycleResetter is not provided', async () => {
      const mh = createMockMessageHub();
      let taskAgent = createMockTaskAgentManager(null, mockTaskWithRun);
      const localDb = createMockDatabase(mockTaskWithRun);
      const localInternalEventBus = {
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as InternalEventBus<DaemonInternalEventMap>;
      const nodeExecRepo = makeNodeExecutionRepo([
        { agentName: 'Coder', agentSessionId: 'session-coder-1', status: 'in_progress' },
      ]);
      const injectSubSession = mock(async (_sid: string, _msg: string) => {});
      taskAgent = {
        ...taskAgent,
        injectSubSessionMessage: injectSubSession,
      };
      setupSpaceTaskMessageHandlers(
        mh.hub,
        taskAgent,
        localDb,
        localInternalEventBus,
        nodeExecRepo
      );

      const result = await (mh.handlers.get('space.task.sendMessage') as RequestHandler)({
        spaceId: 'space-1',
        taskId: 'task-1',
        message: '@Coder please continue',
      });

      expect(result).toMatchObject({ ok: true });
      const publishCalls = (localInternalEventBus.publish as ReturnType<typeof mock>).mock.calls;
      expect(publishCalls.some((c) => c[0] === 'space.workflowRun.cyclesReset')).toBe(false);
    });
  });

  describe('space.task.activateNodeAgent', () => {
    const mockTaskWithRun: SpaceTask = {
      ...mockTaskWithSession,
      workflowRunId: 'run-act-1',
    };

    function setupActivate(
      opts: {
        task?: SpaceTask | null;
        declared?: string[];
        liveSession?: { session: { id: string } } | null;
        ensureReturns?: boolean;
        includeQueue?: boolean;
      } = {}
    ) {
      const mh = createMockMessageHub();
      const declared = opts.declared ?? ['reviewer', 'coder'];
      const liveSession = opts.liveSession ?? null;

      const ensureCalls: Array<{
        taskId: string;
        agentName: string;
        workflowNodeId?: string;
      }> = [];
      const injectCalls: Array<{ sessionId: string; message: string }> = [];
      const enqueueCalls: Array<{
        targetAgentName: string;
        message: string;
        sourceAgentName?: string | null;
      }> = [];
      const getSubSessionCalls: Array<{
        taskId: string;
        agentName: string;
        workflowNodeId?: string;
      }> = [];

      const localTaskAgentManager: TaskAgentManagerInterface = {
        ...createMockTaskAgentManager(null, opts.task ?? mockTaskWithRun),
        injectSubSessionMessage: mock(async (sid: string, msg: string) => {
          injectCalls.push({ sessionId: sid, message: msg });
        }),
        getSubSessionByAgentName: mock(
          async (_taskId: string, agentName: string, workflowNodeId?: string) => {
            getSubSessionCalls.push({ taskId: _taskId, agentName, workflowNodeId });
            if (liveSession && declared.includes(agentName)) return liveSession;
            return null;
          }
        ),
        getWorkflowDeclaredAgentNamesForTask: mock(() => declared),
        ensureWorkflowNodeActivationForAgent: mock(
          async (taskId: string, agentName: string, options?: { workflowNodeId?: string }) => {
            ensureCalls.push({
              taskId,
              agentName,
              ...(options?.workflowNodeId ? { workflowNodeId: options.workflowNodeId } : {}),
            });
            return opts.ensureReturns ?? true;
          }
        ),
      };

      const localDb = createMockDatabase(
        opts.task === null ? null : (opts.task ?? mockTaskWithRun)
      );
      const localInternalEventBus = {
        publish: mock(async () => ({ delivered: 0, failures: [] })),
        publishAsync: mock(() => {}),
      } as unknown as InternalEventBus<DaemonInternalEventMap>;

      let pendingQueue: ReturnType<typeof mock> | undefined;
      let pendingMessageQueue: undefined | { enqueue: typeof pendingQueue };
      if (opts.includeQueue ?? true) {
        pendingQueue = mock(
          (input: {
            targetAgentName: string;
            message: string;
            sourceAgentName?: string | null;
          }) => {
            enqueueCalls.push({
              targetAgentName: input.targetAgentName,
              message: input.message,
              sourceAgentName: input.sourceAgentName,
            });
            return { record: { id: `pending-${enqueueCalls.length}` }, deduped: false };
          }
        );
        pendingMessageQueue = { enqueue: pendingQueue };
      }

      setupSpaceTaskMessageHandlers(
        mh.hub,
        localTaskAgentManager,
        localDb,
        localInternalEventBus,
        undefined,
        undefined,
        undefined,
        pendingMessageQueue as Parameters<typeof setupSpaceTaskMessageHandlers>[7]
      );

      return {
        handlers: mh.handlers,
        taskAgentManager: localTaskAgentManager,
        ensureCalls,
        injectCalls,
        enqueueCalls,
        getSubSessionCalls,
        internalEventBus: localInternalEventBus,
      };
    }

    it('registers space.task.activateNodeAgent', () => {
      const { handlers: h } = setupActivate();
      expect(h.has('space.task.activateNodeAgent')).toBe(true);
    });

    it('throws when spaceId is missing', async () => {
      const { handlers: h } = setupActivate();
      await expect(
        (h.get('space.task.activateNodeAgent') as RequestHandler)({
          taskId: 'task-1',
          agentName: 'reviewer',
        })
      ).rejects.toThrow('spaceId is required');
    });

    it('throws when taskId is missing', async () => {
      const { handlers: h } = setupActivate();
      await expect(
        (h.get('space.task.activateNodeAgent') as RequestHandler)({
          spaceId: 'space-1',
          agentName: 'reviewer',
        })
      ).rejects.toThrow('taskId is required');
    });

    it('throws when agentName is missing or empty', async () => {
      const { handlers: h } = setupActivate();
      await expect(
        (h.get('space.task.activateNodeAgent') as RequestHandler)({
          spaceId: 'space-1',
          taskId: 'task-1',
          agentName: '   ',
        })
      ).rejects.toThrow('agentName is required');
    });

    it('throws when agent is not workflow-declared', async () => {
      const { handlers: h } = setupActivate({ declared: ['reviewer'] });
      await expect(
        (h.get('space.task.activateNodeAgent') as RequestHandler)({
          spaceId: 'space-1',
          taskId: 'task-1',
          agentName: 'ghost-agent',
        })
      ).rejects.toThrow(/not declared/);
    });

    it('throws when message exceeds 100,000 characters', async () => {
      const { handlers: h } = setupActivate();
      await expect(
        (h.get('space.task.activateNodeAgent') as RequestHandler)({
          spaceId: 'space-1',
          taskId: 'task-1',
          agentName: 'reviewer',
          message: 'x'.repeat(100_001),
        })
      ).rejects.toThrow(/too long/);
    });

    it('short-circuits to live session when target is already spawned (returns sessionId)', async () => {
      const {
        handlers: h,
        ensureCalls,
        injectCalls,
        enqueueCalls,
      } = setupActivate({
        liveSession: { session: { id: 'sess-live-reviewer' } },
      });
      const result = (await (h.get('space.task.activateNodeAgent') as RequestHandler)({
        spaceId: 'space-1',
        taskId: 'task-1',
        agentName: 'reviewer',
        message: 'hi reviewer',
      })) as Record<string, unknown>;

      expect(result.sessionId).toBe('sess-live-reviewer');
      expect(result.activated).toBe(false);
      expect(result.queued).toBe(false);
      expect(injectCalls).toHaveLength(1);
      expect(injectCalls[0].sessionId).toBe('sess-live-reviewer');
      expect(injectCalls[0].message).toBe('[Message from human]: hi reviewer');
      expect(enqueueCalls).toHaveLength(0);
      expect(ensureCalls).toHaveLength(0);
    });

    it('throws and does not report success when activation is rejected (stale node id)', async () => {
      const { handlers: h, ensureCalls } = setupActivate({ ensureReturns: false });
      await expect(
        (h.get('space.task.activateNodeAgent') as RequestHandler)({
          spaceId: 'space-1',
          taskId: 'task-1',
          agentName: 'reviewer',
          message: 'wake up',
          workflowNodeId: 'node-that-does-not-declare-reviewer',
        })
      ).rejects.toThrow(/activate/);
      expect(ensureCalls).toHaveLength(1);
      expect(ensureCalls[0].workflowNodeId).toBe('node-that-does-not-declare-reviewer');
    });

    it('queues the message and triggers ensureWorkflowNodeActivationForAgent when no live session exists', async () => {
      const { handlers: h, ensureCalls, injectCalls, enqueueCalls } = setupActivate();
      const result = (await (h.get('space.task.activateNodeAgent') as RequestHandler)({
        spaceId: 'space-1',
        taskId: 'task-1',
        agentName: 'reviewer',
        message: 'wake up reviewer',
      })) as Record<string, unknown>;

      expect(result.sessionId).toBeNull();
      expect(result.activated).toBe(true);
      expect(result.queued).toBe(true);
      expect(result.queuedMessageId).toBe('pending-1');

      expect(injectCalls).toHaveLength(0);

      expect(enqueueCalls).toHaveLength(1);
      expect(enqueueCalls[0].targetAgentName).toBe('reviewer');
      expect(enqueueCalls[0].message).toBe('wake up reviewer');
      expect(enqueueCalls[0].sourceAgentName).toBe('human');

      expect(ensureCalls).toHaveLength(1);
      expect(ensureCalls[0].taskId).toBe('task-1');
      expect(ensureCalls[0].agentName).toBe('reviewer');
    });

    it('skips queueing when no message is provided but still triggers activation', async () => {
      const { handlers: h, ensureCalls, enqueueCalls } = setupActivate();
      const result = (await (h.get('space.task.activateNodeAgent') as RequestHandler)({
        spaceId: 'space-1',
        taskId: 'task-1',
        agentName: 'reviewer',
      })) as Record<string, unknown>;

      expect(result.sessionId).toBeNull();
      expect(result.queued).toBe(false);
      expect(result.queuedMessageId).toBeUndefined();
      expect(enqueueCalls).toHaveLength(0);
      expect(ensureCalls).toHaveLength(1);
    });

    it('forwards workflowNodeId to the live-session lookup and the activation kick', async () => {
      const { handlers: h, ensureCalls, getSubSessionCalls } = setupActivate();
      await (h.get('space.task.activateNodeAgent') as RequestHandler)({
        spaceId: 'space-1',
        taskId: 'task-1',
        agentName: 'reviewer',
        workflowNodeId: 'node-2',
      });

      expect(getSubSessionCalls[0].workflowNodeId).toBe('node-2');
      expect(ensureCalls).toHaveLength(1);
      expect(ensureCalls[0].workflowNodeId).toBe('node-2');
    });

    it('omits workflowNodeId from the activation options when the caller does not supply it', async () => {
      const { handlers: h, ensureCalls } = setupActivate();
      await (h.get('space.task.activateNodeAgent') as RequestHandler)({
        spaceId: 'space-1',
        taskId: 'task-1',
        agentName: 'reviewer',
      });
      expect(ensureCalls[0].workflowNodeId).toBeUndefined();
    });

    it('cross-space access throws Task not found', async () => {
      const { handlers: h } = setupActivate();
      await expect(
        (h.get('space.task.activateNodeAgent') as RequestHandler)({
          spaceId: 'space-other',
          taskId: 'task-1',
          agentName: 'reviewer',
        })
      ).rejects.toThrow('Task not found');
    });

    it('throws when task is archived', async () => {
      const { handlers: h } = setupActivate({
        task: { ...mockTaskWithRun, status: 'archived' },
      });
      await expect(
        (h.get('space.task.activateNodeAgent') as RequestHandler)({
          spaceId: 'space-1',
          taskId: 'task-1',
          agentName: 'reviewer',
        })
      ).rejects.toThrow('archived');
    });

    it('throws when task is done', async () => {
      const { handlers: h } = setupActivate({
        task: { ...mockTaskWithRun, status: 'done' },
      });
      await expect(
        (h.get('space.task.activateNodeAgent') as RequestHandler)({
          spaceId: 'space-1',
          taskId: 'task-1',
          agentName: 'reviewer',
        })
      ).rejects.toThrow(/done.*active task/);
    });

    it('throws when task is cancelled', async () => {
      const { handlers: h } = setupActivate({
        task: { ...mockTaskWithRun, status: 'cancelled' },
      });
      await expect(
        (h.get('space.task.activateNodeAgent') as RequestHandler)({
          spaceId: 'space-1',
          taskId: 'task-1',
          agentName: 'reviewer',
        })
      ).rejects.toThrow(/cancelled.*active task/);
    });

    it('throws when task is stopped with a resume hint', async () => {
      const { handlers: h } = setupActivate({
        task: { ...mockTaskWithRun, status: 'stopped' },
      });
      await expect(
        (h.get('space.task.activateNodeAgent') as RequestHandler)({
          spaceId: 'space-1',
          taskId: 'task-1',
          agentName: 'reviewer',
        })
      ).rejects.toThrow(/stopped — resume it before activating agents/);
    });
  });
});

describe('parseMentions', () => {
  it('extracts a single @mention', () => {
    expect(parseMentions('@Coder please fix')).toEqual(['Coder']);
  });

  it('extracts multiple distinct @mentions', () => {
    expect(parseMentions('@Coder and @Reviewer please coordinate')).toEqual(['Coder', 'Reviewer']);
  });

  it('deduplicates repeated @mentions', () => {
    expect(parseMentions('@Coder can you help @Coder')).toEqual(['Coder']);
  });

  it('preserves original casing', () => {
    expect(parseMentions('@CodeReviewer hello')).toEqual(['CodeReviewer']);
  });

  it('returns empty array when no @mentions', () => {
    expect(parseMentions('please fix the bug')).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseMentions('')).toEqual([]);
  });

  it('returns empty array for bare @ with no name', () => {
    expect(parseMentions('@ hello')).toEqual([]);
  });

  it('does not extract names starting with a digit after @', () => {
    expect(parseMentions('@123bot hello')).toEqual([]);
  });

  it('handles @mention with hyphens and underscores', () => {
    expect(parseMentions('@code-reviewer and @qa_agent')).toEqual(['code-reviewer', 'qa_agent']);
  });

  it('email false-positive: extracts @domain from emails (known limitation, degrades gracefully)', () => {
    const result = parseMentions('contact user@example.com for help');
    expect(result).toEqual(['example']);
  });

  it('@mention at start of string', () => {
    expect(parseMentions('@Planner start the task')).toEqual(['Planner']);
  });

  it('ignores @mention followed by a digit-only suffix when the name still starts with a letter', () => {
    expect(parseMentions('@Coder1 hello')).toEqual(['Coder1']);
  });
});
