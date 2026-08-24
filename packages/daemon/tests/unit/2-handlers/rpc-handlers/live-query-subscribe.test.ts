import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@hyperneo/shared';
import { ErrorCode, MessageHubHandlerError } from '@hyperneo/shared';
import { setupLiveQueryHandlers } from '../../../../src/lib/rpc-handlers/live-query-handlers';
import { LiveQueryEngine } from '../../../../src/storage/live-query';
import type { ReactiveDatabase } from '../../../../src/storage/reactive-database';
import { createReactiveDatabase } from '../../../../src/storage/reactive-database';
import { createTables } from '../../../../src/storage/schema';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';

type RequestHandler = (data: unknown, context: Partial<CallCtx>) => Promise<unknown> | unknown;
type CallCtx = {
  clientId?: string;
  sessionId: string;
  messageId: string;
  method: string;
  timestamp: string;
};

interface SentMessage {
  clientId: string;
  message: {
    method: string;
    data: {
      subscriptionId: string;
      rows?: unknown[];
      added?: unknown[];
      removed?: unknown[];
      updated?: unknown[];
      version: number;
    };
  };
}

function createMockSetup(opts: { subscriptionCap?: number } = {}) {
  const handlers = new Map<string, RequestHandler>();
  let disconnectHandler: ((clientId: string) => void) | null = null;
  const sentMessages: SentMessage[] = [];
  let sendToClientResult:
    | { ok: true }
    | { ok: false; reason: 'send_failed' | 'message_too_large' } = { ok: true };
  let routerEnabled = true;

  const subscriptionCap = opts.subscriptionCap ?? Number.POSITIVE_INFINITY;
  const subscriptionCounts = new Map<string, number>();

  const mockRouter = {
    sendToClient: mock((clientId: string, message: unknown) => {
      sentMessages.push({ clientId, message: message as SentMessage['message'] });
      return sendToClientResult;
    }),
    sendToClientDetailed: mock((clientId: string, message: unknown) => {
      sentMessages.push({ clientId, message: message as SentMessage['message'] });
      return sendToClientResult;
    }),
    checkSubscriptionCapacity: mock((clientId: string) => {
      const current = subscriptionCounts.get(clientId) ?? 0;
      if (current >= subscriptionCap) {
        return { ok: false, reason: 'too_many_subscriptions', limit: subscriptionCap, current };
      }
      return { ok: true };
    }),
    addClientSubscription: mock((clientId: string) => {
      subscriptionCounts.set(clientId, (subscriptionCounts.get(clientId) ?? 0) + 1);
    }),
    releaseClientSubscription: mock((clientId: string) => {
      const current = subscriptionCounts.get(clientId);
      if (current === undefined) return;
      if (current <= 1) subscriptionCounts.delete(clientId);
      else subscriptionCounts.set(clientId, current - 1);
    }),
    getClientSubscriptionCount: mock((clientId: string) => subscriptionCounts.get(clientId) ?? 0),
  };

  const hub = {
    onRequest: mock((method: string, handler: RequestHandler) => {
      handlers.set(method, handler);
      return () => handlers.delete(method);
    }),
    getRouter: mock(() => (routerEnabled ? mockRouter : null)),
    onClientDisconnect: mock((handler: (clientId: string) => void) => {
      disconnectHandler = handler;
      return () => {
        disconnectHandler = null;
      };
    }),
  } as unknown as MessageHub;

  const callHandler = async (
    method: string,
    data: unknown,
    ctx: Partial<CallCtx> = {}
  ): Promise<unknown> => {
    const handler = handlers.get(method);
    if (!handler) throw new Error(`No handler registered for method: ${method}`);
    const fullCtx: CallCtx = {
      clientId: 'client-1',
      namespaceId: 'global',
      sessionId: 'global',
      messageId: 'msg-1',
      method,
      timestamp: new Date().toISOString(),
      ...ctx,
    };
    return handler(data, fullCtx);
  };

  return {
    hub,
    sentMessages,
    callHandler,
    fireDisconnect: (clientId: string) => disconnectHandler?.(clientId),
    setSendResult: (result: boolean) => {
      sendToClientResult = result ? { ok: true } : { ok: false, reason: 'send_failed' };
    },
    setDetailedSendResult: (result: typeof sendToClientResult) => {
      sendToClientResult = result;
    },
    setRouterEnabled: (enabled: boolean) => {
      routerEnabled = enabled;
    },
    mockRouter,
  };
}

function createDb() {
  const db = new BunDatabase(':memory:');
  createTables(db);
  db.exec(`
		CREATE TABLE IF NOT EXISTS spaces (
			id TEXT PRIMARY KEY,
			slug TEXT,
			workspace_path TEXT NOT NULL,
			name TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS space_workflow_runs (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			workflow_id TEXT NOT NULL,
			title TEXT NOT NULL,
			description TEXT,
			status TEXT NOT NULL,
			config TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		);
		CREATE TABLE IF NOT EXISTS space_tasks (
			id TEXT PRIMARY KEY,
			space_id TEXT NOT NULL,
			task_number INTEGER NOT NULL DEFAULT 1,
			title TEXT NOT NULL,
			description TEXT NOT NULL DEFAULT '',
			status TEXT NOT NULL DEFAULT 'pending',
			priority TEXT NOT NULL DEFAULT 'normal',
			assigned_agent TEXT,
			custom_agent_id TEXT,
			agent_name TEXT,
			completion_summary TEXT,
			workflow_run_id TEXT,
			workflow_node_id TEXT,
			task_agent_session_id TEXT,
			post_approval_session_id TEXT,
			depends_on TEXT NOT NULL DEFAULT '[]',
			current_step TEXT,
			error TEXT,
			result TEXT,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)
	`);
  return db;
}

function insertRoom(db: BunDatabase, roomId: string) {
  const now = Date.now();
  db.exec(
    `INSERT OR IGNORE INTO rooms (id, name, created_at, updated_at) VALUES ('${roomId}', 'Test Room', ${now}, ${now})`
  );
}

function insertTask(db: BunDatabase, taskId: string, roomId: string) {
  const now = Date.now();
  db.exec(
    `INSERT OR IGNORE INTO tasks (id, room_id, title, description, status, priority, task_type, created_at, updated_at)
		 VALUES ('${taskId}', '${roomId}', 'Test Task', '', 'pending', 'normal', 'coding', ${now}, ${now})`
  );
}

function insertSessionGroup(
  db: BunDatabase,
  groupId: string,
  refId: string,
  groupType: string = 'task'
) {
  const now = Date.now();
  db.exec(
    `INSERT OR IGNORE INTO session_groups (id, group_type, ref_id, version, created_at)
		 VALUES ('${groupId}', '${groupType}', '${refId}', 1, ${now})`
  );
}

function insertMcpServer(db: BunDatabase, id: string, name: string, enabled = true) {
  const now = Date.now();
  db.exec(
    `INSERT INTO app_mcp_servers (id, name, source_type, enabled, source, created_at, updated_at)
		 VALUES ('${id}', '${name}', 'stdio', ${enabled ? 1 : 0}, 'user', ${now}, ${now})`
  );
}

function insertWorkflowRun(db: BunDatabase, runId: string) {
  const now = Date.now();
  db.exec(
    `INSERT OR IGNORE INTO space_workflow_runs (
			id, space_id, workflow_id, title, description, status, config, created_at, updated_at
		) VALUES (
			'${runId}', 'space-test-1', 'workflow-test-1', 'Test Run', '', 'in_progress', '{}', ${now}, ${now}
		)`
  );
}

function insertSpaceTask(db: BunDatabase, id: string, spaceId: string = 'space-test-1') {
  const now = Date.now();
  db.exec(
    `INSERT OR IGNORE INTO space_tasks (
			id, space_id, task_number, title, description, status, priority, assigned_agent, agent_name,
			workflow_run_id, workflow_node_id, task_agent_session_id, depends_on, created_at, updated_at
		) VALUES (
			'${id}', '${spaceId}', 1, 'Test Task', '', 'in_progress', 'normal', 'coder', NULL,
			NULL, NULL, NULL, '[]', ${now}, ${now}
		)`
  );
}

describe('setupLiveQueryHandlers', () => {
  let db: BunDatabase;
  let reactiveDb: ReactiveDatabase;
  let engine: LiveQueryEngine;
  let setup: ReturnType<typeof createMockSetup>;
  const roomId = 'room-test-1';
  const taskId = 'task-test-1';

  beforeEach(() => {
    db = createDb();
    reactiveDb = createReactiveDatabase({ getDatabase: () => db } as never);
    engine = new LiveQueryEngine(db, reactiveDb);
    setup = createMockSetup();
    setupLiveQueryHandlers(setup.hub, engine, db);
    insertRoom(db, roomId);
    insertTask(db, taskId, roomId);
  });

  afterEach(() => {
    engine.dispose();
    db.close();
  });

  test('subscribe: absent clientId throws', async () => {
    await expect(
      setup.callHandler(
        'liveQuery.subscribe',
        { queryName: 'mcpServers.global', params: [], subscriptionId: 'sub-1' },
        { clientId: undefined }
      )
    ).rejects.toThrow('clientId absent');
  });

  test('unsubscribe: absent clientId throws', async () => {
    await expect(
      setup.callHandler(
        'liveQuery.unsubscribe',
        { subscriptionId: 'sub-1' },
        { clientId: undefined }
      )
    ).rejects.toThrow('clientId absent');
  });

  test('subscribe: unknown query name throws', async () => {
    await expect(
      setup.callHandler('liveQuery.subscribe', {
        queryName: 'nonexistent.query',
        params: ['x'],
        subscriptionId: 'sub-1',
      })
    ).rejects.toThrow('Unknown query name');
  });

  test('retired Room-scoped query names are unknown', async () => {
    for (const queryName of [
      'tasks.byRoom',
      'tasks.byRoom.all',
      'goals.byRoom',
      'mcpEnablement.byRoom',
      'skills.byRoom',
    ]) {
      await expect(
        setup.callHandler('liveQuery.subscribe', {
          queryName,
          params: [roomId],
          subscriptionId: `legacy-${queryName}`,
        })
      ).rejects.toThrow(`Unknown query name: "${queryName}"`);
    }
  });

  test('subscribe: mismatched params count throws', async () => {
    await expect(
      setup.callHandler('liveQuery.subscribe', {
        queryName: 'mcpServers.global',
        params: ['extra'],
        subscriptionId: 'sub-1',
      })
    ).rejects.toThrow('expects 0 parameter(s), got 1');
  });

  test('subscribe messages.bySession: rejects a window above the server cap', async () => {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata)
       VALUES (?, ?, ?, ?, 'active', '{}', '{}')`
    ).run('session-window-cap', 'Window Cap', now, now);

    await expect(
      setup.callHandler('liveQuery.subscribe', {
        queryName: 'messages.bySession',
        params: ['session-window-cap', 201],
        subscriptionId: 'sub-window-cap',
      })
    ).rejects.toThrow('limit must be an integer in [1, 200]');
  });

  test('subscribe spaceTaskActivity.byTask: nonexistent task rejected', async () => {
    await expect(
      setup.callHandler('liveQuery.subscribe', {
        queryName: 'spaceTaskActivity.byTask',
        params: ['space-task-does-not-exist'],
        subscriptionId: 'sub-1',
      })
    ).rejects.toThrow('Unauthorized');
  });

  test('subscribe spaceTaskMessages.byTask.compact: nonexistent task rejected', async () => {
    await expect(
      setup.callHandler('liveQuery.subscribe', {
        queryName: 'spaceTaskMessages.byTask.compact',
        params: ['space-task-does-not-exist', 20],
        subscriptionId: 'sub-1',
      })
    ).rejects.toThrow('Unauthorized');
  });

  test('subscribe spaceTaskMessages.byTask.compact: rejects invalid window limit', async () => {
    insertSpaceTask(db, taskId);
    await expect(
      setup.callHandler('liveQuery.subscribe', {
        queryName: 'spaceTaskMessages.byTask.compact',
        params: [taskId, 0],
        subscriptionId: 'sub-1',
      })
    ).rejects.toThrow('limit');
    await expect(
      setup.callHandler('liveQuery.subscribe', {
        queryName: 'spaceTaskMessages.byTask.compact',
        params: [taskId, 101],
        subscriptionId: 'sub-2',
      })
    ).rejects.toThrow('limit');
  });

  test('spaceTaskMessage.get returns the full sdk_message for a task row', async () => {
    insertSpaceTask(db, taskId);
    const messageId = 'msg-get-1';
    const sdkMessage = JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'full text' }] },
    });
    const now = Date.now();
    db.exec(
      `INSERT INTO sdk_messages (
        id, session_id, message_type, sdk_message, timestamp, send_status, origin,
        is_renderable, is_terminal, task_id
      ) VALUES (
        '${messageId}', 'sess-get-1', 'assistant', '${sdkMessage.replace(/'/g, "''")}',
        '${new Date(now).toISOString()}', 'consumed', 'system',
        1, 0, '${taskId}'
      )`
    );
    const result = (await setup.callHandler('spaceTaskMessage.get', {
      taskId,
      messageId,
    })) as { sdkMessage: string };
    expect(result.sdkMessage).toBe(sdkMessage);
  });

  test('spaceTaskMessage.get rejects a missing task or message', async () => {
    await expect(
      setup.callHandler('spaceTaskMessage.get', { taskId: 'missing-task', messageId: 'msg-1' })
    ).rejects.toThrow('Unauthorized');
  });

  test('spaceTaskMessage.get reconstructs GitHub event rows for expansion', async () => {
    insertSpaceTask(db, taskId);
    const nowTs = Date.now();
    db.exec(
      `INSERT INTO space_github_events (
        id, space_id, task_id, source, delivery_id, event_type, action, repo_owner,
        repo_name, pr_number, pr_url, actor, actor_type, summary, external_url,
        occurred_at, dedupe_key, raw_payload, state, created_at, updated_at
      ) VALUES (
        'gh-expand-1', 'space-test-1', '${taskId}', 'webhook', 'del-1', 'pull_request',
        'closed', 'lsm', 'HyperNeo', 2901, 'https://github.com/lsm/HyperNeo/pull/2901',
        'lsm', 'user', 'PR merged', 'https://github.com/lsm/HyperNeo/pull/2901',
        ${nowTs}, 'dedupe-gh-expand-1', '{}', 'delivered', ${nowTs}, ${nowTs}
      )`
    );
    const result = (await setup.callHandler('spaceTaskMessage.get', {
      taskId,
      messageId: 'gh-expand-1',
    })) as { sdkMessage: string };
    expect(JSON.parse(result.sdkMessage)).toEqual({
      type: 'user',
      uuid: 'gh-expand-1',
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '[GitHub] PR merged\nhttps://github.com/lsm/HyperNeo/pull/2901',
          },
        ],
      },
    });
  });

  test('subscribe actorMessages.byWorkflowRun: mismatched run params rejected', async () => {
    insertWorkflowRun(db, 'workflow-run-valid');
    await expect(
      setup.callHandler('liveQuery.subscribe', {
        queryName: 'actorMessages.byWorkflowRun',
        params: ['workflow-run-valid', 'workflow-run-other', 'workflow-run-valid'],
        subscriptionId: 'sub-actor-run',
      })
    ).rejects.toThrow('requires matching workflow run ids');
  });

  test('subscribe actorMessages.byWorkflowRun: nonexistent run rejected', async () => {
    await expect(
      setup.callHandler('liveQuery.subscribe', {
        queryName: 'actorMessages.byWorkflowRun',
        params: ['workflow-run-missing', 'workflow-run-missing', 'workflow-run-missing'],
        subscriptionId: 'sub-actor-run-missing',
      })
    ).rejects.toThrow('Unauthorized');
  });

  test('subscribe sessionGroupMessages.byGroup: nonexistent group rejected', async () => {
    await expect(
      setup.callHandler('liveQuery.subscribe', {
        queryName: 'sessionGroupMessages.byGroup',
        params: ['group-does-not-exist'],
        subscriptionId: 'sub-1',
      })
    ).rejects.toThrow('Unauthorized');
  });

  test('subscribe sessionGroupMessages.byGroup: group with missing task rejected', async () => {
    insertSessionGroup(db, 'grp-1', 'nonexistent-task', 'task');
    await expect(
      setup.callHandler('liveQuery.subscribe', {
        queryName: 'sessionGroupMessages.byGroup',
        params: ['grp-1'],
        subscriptionId: 'sub-1',
      })
    ).rejects.toThrow('Unauthorized');
  });

  test('subscribe sessionGroupMessages.byGroup: task with missing room rejected', async () => {
    const orphanTask = 'orphan-task-1';
    const missingRoom = 'missing-room-1';
    const now = Date.now();
    db.exec(
      `INSERT INTO tasks (id, room_id, title, description, status, priority, task_type, created_at, updated_at)
			 VALUES ('${orphanTask}', '${missingRoom}', 'Orphan Task', '', 'pending', 'normal', 'coding', ${now}, ${now})`
    );
    insertSessionGroup(db, 'grp-2', orphanTask, 'task');

    await expect(
      setup.callHandler('liveQuery.subscribe', {
        queryName: 'sessionGroupMessages.byGroup',
        params: ['grp-2'],
        subscriptionId: 'sub-1',
      })
    ).rejects.toThrow('Unauthorized');
  });

  test('subscribe sessionGroupMessages.byGroup: valid legacy task group allowed', async () => {
    insertSessionGroup(db, 'grp-valid', taskId, 'task');
    const result = await setup.callHandler('liveQuery.subscribe', {
      queryName: 'sessionGroupMessages.byGroup',
      params: ['grp-valid'],
      subscriptionId: 'sub-msg',
    });
    expect(result).toEqual({ ok: true });
    expect(setup.sentMessages[0].message.method).toBe('liveQuery.snapshot');
  });

  test('subscribe sessionGroupMessages.byGroup: non-task group_type allowed without task lookup', async () => {
    insertSessionGroup(db, 'grp-other', 'some-ref', 'workflow');
    const result = await setup.callHandler('liveQuery.subscribe', {
      queryName: 'sessionGroupMessages.byGroup',
      params: ['grp-other'],
      subscriptionId: 'sub-other',
    });
    expect(result).toEqual({ ok: true });
  });

  test('subscribe: snapshot delivered immediately on subscribe', async () => {
    insertMcpServer(db, 'mcp-1', 'alpha');
    const result = await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-1',
    });
    expect(result).toEqual({ ok: true });
    expect(setup.sentMessages.length).toBe(1);
    const msg = setup.sentMessages[0];
    expect(msg.clientId).toBe('client-1');
    expect(msg.message.method).toBe('liveQuery.snapshot');
    expect(msg.message.data.subscriptionId).toBe('sub-1');
    expect(Array.isArray(msg.message.data.rows)).toBe(true);
    expect(typeof msg.message.data.version).toBe('number');
  });

  test('oversized snapshot reports an error and rejects the subscription', async () => {
    setup.setDetailedSendResult({ ok: false, reason: 'message_too_large' });
    await expect(
      setup.callHandler('liveQuery.subscribe', {
        queryName: 'mcpServers.global',
        params: [],
        subscriptionId: 'sub-large',
      })
    ).rejects.toThrow('MESSAGE_TOO_LARGE');

    expect(setup.sentMessages.map((sent) => sent.message.method)).toEqual([
      'liveQuery.snapshot',
      'liveQuery.error',
    ]);

    setup.setDetailedSendResult({ ok: true });
    insertMcpServer(db, 'mcp-after-large', 'after-large');
    reactiveDb.notifyChange('app_mcp_servers');
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(setup.sentMessages.some((sent) => sent.message.method === 'liveQuery.delta')).toBe(
      false
    );
  });

  test('full lifecycle: subscribe, delta, unsubscribe', async () => {
    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-lc',
    });
    expect(setup.sentMessages[0].message.method).toBe('liveQuery.snapshot');

    insertMcpServer(db, 'mcp-new-1', 'new-server');
    reactiveDb.notifyChange('app_mcp_servers');
    await new Promise((r) => setTimeout(r, 10));
    expect(setup.sentMessages.length).toBeGreaterThanOrEqual(1);

    const unsubResult = await setup.callHandler('liveQuery.unsubscribe', {
      subscriptionId: 'sub-lc',
    });
    expect(unsubResult).toEqual({ ok: true });
  });

  test('snapshot always delivered before any delta', async () => {
    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-order',
    });
    expect(setup.sentMessages[0].message.method).toBe('liveQuery.snapshot');
    for (let i = 1; i < setup.sentMessages.length; i++) {
      expect(setup.sentMessages[i].message.method).toBe('liveQuery.delta');
    }
  });

  test('subscriptionId collision replaces prior subscription', async () => {
    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-collision',
    });
    expect(setup.sentMessages.length).toBe(1);

    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-collision',
    });
    expect(setup.sentMessages.length).toBe(2);
    expect(setup.sentMessages[1].message.method).toBe('liveQuery.snapshot');
  });

  test('unsubscribe: unknown subscriptionId returns ok', async () => {
    const result = await setup.callHandler('liveQuery.unsubscribe', {
      subscriptionId: 'non-existent-sub',
    });
    expect(result).toEqual({ ok: true });
  });

  test('client disconnect disposes all subscriptions for that client', async () => {
    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-a',
    });
    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-b',
    });
    expect(setup.sentMessages.length).toBe(2);

    setup.fireDisconnect('client-1');
    const result = await setup.callHandler('liveQuery.unsubscribe', {
      subscriptionId: 'sub-a',
    });
    expect(result).toEqual({ ok: true });
  });

  test('onClientDisconnect is registered exactly once at setup', async () => {
    expect(setup.hub.onClientDisconnect).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) {
      await setup.callHandler('liveQuery.subscribe', {
        queryName: 'mcpServers.global',
        params: [],
        subscriptionId: `sub-cycle-${i}`,
      });
      await setup.callHandler('liveQuery.unsubscribe', {
        subscriptionId: `sub-cycle-${i}`,
      });
    }
    expect(setup.hub.onClientDisconnect).toHaveBeenCalledTimes(1);
  });

  test('subscribe: snapshot delivery failure returns ok gracefully', async () => {
    setup.setSendResult(false);
    const result = await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-fail',
    });
    expect(result).toEqual({ ok: true });
  });

  test('subscribe: null router during snapshot disposes handle and returns ok', async () => {
    setup.setRouterEnabled(false);
    const result = await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-no-router',
    });
    expect(setup.sentMessages.length).toBe(0);
    expect(result).toEqual({ ok: true });

    setup.setRouterEnabled(true);
    const result2 = await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-no-router',
    });
    expect(result2).toEqual({ ok: true });
    expect(setup.sentMessages.length).toBe(1);
    expect(setup.sentMessages[0].message.method).toBe('liveQuery.snapshot');
  });

  test('version is monotonically increasing across snapshot and deltas', async () => {
    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-version',
    });
    const snapshotVersion = setup.sentMessages[0].message.data.version;
    expect(typeof snapshotVersion).toBe('number');

    insertMcpServer(db, 'mcp-v2', 'server-v2');
    reactiveDb.notifyChange('app_mcp_servers');
    await new Promise((r) => setTimeout(r, 10));

    insertMcpServer(db, 'mcp-v3', 'server-v3');
    reactiveDb.notifyChange('app_mcp_servers');
    await new Promise((r) => setTimeout(r, 10));

    const deltas = setup.sentMessages
      .slice(1)
      .filter((m) => m.message.method === 'liveQuery.delta');
    expect(deltas.length).toBeGreaterThanOrEqual(1);

    let prevVersion = snapshotVersion;
    for (const delta of deltas) {
      const v = delta.message.data.version;
      expect(v).toBeGreaterThanOrEqual(prevVersion);
      prevVersion = v;
    }
  });

  test('sessions.list metadata reflects the maintained counter across mutations', async () => {
    const insertSession = (
      id: string,
      type: string,
      status: string,
      context: string | null
    ): void => {
      const now = new Date().toISOString();
      db.prepare(
        `INSERT INTO sessions (id, title, created_at, last_active_at, status, config, metadata, type, session_context)
         VALUES (?, '', ?, ?, ?, '{}', '{}', ?, ?)`
      ).run(id, now, now, status, type, context);
    };
    const metadataOf = (index: number) =>
      (
        setup.sentMessages[index].message.data as {
          metadata?: { totalCount: number; archivedCount: number };
        }
      ).metadata;

    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'sessions.list',
      params: [0],
      subscriptionId: 'sub-sessions-list',
    });
    expect(metadataOf(0)).toEqual({ totalCount: 0, archivedCount: 0 });

    insertSession('h1', 'worker', 'active', null);
    reactiveDb.notifyChange('sessions', { sessionId: 'h1' });
    await new Promise((r) => setTimeout(r, 200));
    expect(metadataOf(setup.sentMessages.length - 1)).toEqual({ totalCount: 1, archivedCount: 0 });

    insertSession('sp1', 'worker', 'active', '{"spaceId":"sp-1"}');
    const beforeExcluded = setup.sentMessages.length;
    reactiveDb.notifyChange('sessions', { sessionId: 'sp1' });
    await new Promise((r) => setTimeout(r, 200));
    expect(setup.sentMessages.length).toBe(beforeExcluded);

    insertSession('h2', 'worker', 'archived', null);
    reactiveDb.notifyChange('sessions', { sessionId: 'h2' });
    await new Promise((r) => setTimeout(r, 200));
    expect(metadataOf(setup.sentMessages.length - 1)).toEqual({ totalCount: 2, archivedCount: 1 });

    db.prepare(`UPDATE sessions SET status = 'active' WHERE id = 'h2'`).run();
    reactiveDb.notifyChange('sessions', { sessionId: 'h2' });
    await new Promise((r) => setTimeout(r, 200));
    expect(metadataOf(setup.sentMessages.length - 1)).toEqual({ totalCount: 2, archivedCount: 0 });
  });
});

describe('setupLiveQueryHandlers: per-client subscription cap', () => {
  let db: BunDatabase;
  let reactiveDb: ReactiveDatabase;
  let engine: LiveQueryEngine;
  let setup: ReturnType<typeof createMockSetup>;

  beforeEach(() => {
    db = createDb();
    reactiveDb = createReactiveDatabase({ getDatabase: () => db } as never);
    engine = new LiveQueryEngine(db, reactiveDb);
    setup = createMockSetup({ subscriptionCap: 2 });
    setupLiveQueryHandlers(setup.hub, engine, db);
    insertMcpServer(db, 'mcp-1', 'alpha');
  });

  afterEach(() => {
    engine.dispose();
    db.close();
  });

  test('refuses the over-cap subscribe with a structured TOO_MANY_SUBSCRIPTIONS error', async () => {
    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-1',
    });
    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-2',
    });

    const err = await setup
      .callHandler('liveQuery.subscribe', {
        queryName: 'mcpServers.global',
        params: [],
        subscriptionId: 'sub-3',
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MessageHubHandlerError);
    expect((err as MessageHubHandlerError).code).toBe(ErrorCode.TOO_MANY_SUBSCRIPTIONS);
  });

  test('prior subscriptions remain intact after an over-cap refusal (graceful, no teardown)', async () => {
    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-1',
    });
    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-2',
    });

    await expect(
      setup.callHandler('liveQuery.subscribe', {
        queryName: 'mcpServers.global',
        params: [],
        subscriptionId: 'sub-3',
      })
    ).rejects.toThrow();

    expect(setup.mockRouter.getClientSubscriptionCount('client-1')).toBe(2);

    setup.sentMessages.length = 0;
    insertMcpServer(db, 'mcp-2', 'beta');
    reactiveDb.notifyChange('app_mcp_servers');
    await new Promise((r) => setTimeout(r, 10));

    const deltas = setup.sentMessages.filter((m) => m.message.method === 'liveQuery.delta');
    expect(deltas.length).toBe(2);
  });

  test('unsubscribe frees a slot so a new subscribe succeeds again', async () => {
    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-1',
    });
    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-2',
    });
    expect(setup.mockRouter.getClientSubscriptionCount('client-1')).toBe(2);

    await setup.callHandler('liveQuery.unsubscribe', { subscriptionId: 'sub-1' });
    expect(setup.mockRouter.getClientSubscriptionCount('client-1')).toBe(1);

    const result = await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-3',
    });
    expect(result).toEqual({ ok: true });
    expect(setup.mockRouter.getClientSubscriptionCount('client-1')).toBe(2);
  });

  test('replacement of an existing subscriptionId is allowed at the cap (no fan-out increase)', async () => {
    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-1',
    });
    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-2',
    });
    expect(setup.mockRouter.getClientSubscriptionCount('client-1')).toBe(2);

    const replaced = await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-1',
    });
    expect(replaced).toEqual({ ok: true });
    expect(setup.mockRouter.getClientSubscriptionCount('client-1')).toBe(2);

    const err = await setup
      .callHandler('liveQuery.subscribe', {
        queryName: 'mcpServers.global',
        params: [],
        subscriptionId: 'sub-new',
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MessageHubHandlerError);
    expect((err as MessageHubHandlerError).code).toBe(ErrorCode.TOO_MANY_SUBSCRIPTIONS);
    expect(setup.mockRouter.getClientSubscriptionCount('client-1')).toBe(2);
  });

  test('a snapshot-delivery failure aborts without consuming a subscription slot', async () => {
    setup.setDetailedSendResult({ ok: false, reason: 'send_failed' });

    const result = await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-1',
    });

    expect(result).toEqual({ ok: true });
    expect(setup.mockRouter.getClientSubscriptionCount('client-1')).toBe(0);
  });

  test('a delta message_too_large failure releases the tracked slot (async release path)', async () => {
    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-1',
    });
    expect(setup.mockRouter.getClientSubscriptionCount('client-1')).toBe(1);

    setup.setDetailedSendResult({ ok: false, reason: 'message_too_large' });
    insertMcpServer(db, 'mcp-2', 'beta');
    reactiveDb.notifyChange('app_mcp_servers');
    await new Promise((r) => setTimeout(r, 10));

    expect(setup.mockRouter.getClientSubscriptionCount('client-1')).toBe(0);
  });

  test('a delta send_failed failure releases the tracked slot (async release path)', async () => {
    await setup.callHandler('liveQuery.subscribe', {
      queryName: 'mcpServers.global',
      params: [],
      subscriptionId: 'sub-1',
    });
    expect(setup.mockRouter.getClientSubscriptionCount('client-1')).toBe(1);

    setup.setDetailedSendResult({ ok: false, reason: 'send_failed' });
    insertMcpServer(db, 'mcp-3', 'gamma');
    reactiveDb.notifyChange('app_mcp_servers');
    await new Promise((r) => setTimeout(r, 10));

    expect(setup.mockRouter.getClientSubscriptionCount('client-1')).toBe(0);
  });
});
