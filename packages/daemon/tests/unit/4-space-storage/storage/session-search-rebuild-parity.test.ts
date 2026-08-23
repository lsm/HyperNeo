import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { Session, SessionType } from '@hyperneo/shared';
import { extractVisibleSearchText } from '../../../../src/storage/message-search';
import {
  decideMessageSearchAdmission,
  MESSAGE_SEARCH_TERMINAL_SESSION_TTL_MS,
} from '../../../../src/storage/repositories/message-search-admission';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository';
import { Database } from '../../../../src/storage/sqlite-compat';

const TTL_MS = MESSAGE_SEARCH_TERMINAL_SESSION_TTL_MS;
const MINUTE_MS = 60 * 1000;
const NOW = 1_779_272_523_500;
const MESSAGE_TIMESTAMP_MS = Date.parse('2026-05-20T01:02:03.456Z');

interface SeededMessage {
  id: string;
  messageType: string;
  sdkMessage: string;
  sendStatus?: string | null;
  taskId?: string | null;
  sdkUuid?: string | null;
}

interface SeededTask {
  id: string;
  status: string;
  completedAt?: number | null;
  updatedAt?: number | null;
}

interface RebuildCase {
  session: {
    id: string;
    status: string;
    type?: string | null;
    lastActiveAt?: string;
    context?: Record<string, unknown> | null;
  };
  task?: SeededTask;
  messages: SeededMessage[];
  replacements?: Array<{ source: string; target: string; kind?: string }>;
}

function userTextMessage(uuid: string, text: string): Record<string, unknown> {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function userStringContentMessage(uuid: string, content: string): Record<string, unknown> {
  return { type: 'user', uuid, message: { role: 'user', content } };
}

function assistantBlocksMessage(
  uuid: string,
  blocks: Array<Record<string, unknown>>
): Record<string, unknown> {
  return { type: 'assistant', uuid, message: { role: 'assistant', content: blocks } };
}

function message(
  id: string,
  messageType: string,
  sdkMessage: Record<string, unknown> | string,
  overrides: Partial<SeededMessage> = {}
): SeededMessage {
  return {
    id,
    messageType,
    sdkMessage: typeof sdkMessage === 'string' ? sdkMessage : JSON.stringify(sdkMessage),
    sendStatus: 'consumed',
    sdkUuid:
      typeof sdkMessage === 'object' && typeof sdkMessage.uuid === 'string'
        ? sdkMessage.uuid
        : null,
    taskId: null,
    ...overrides,
  };
}

const MESSAGE_AXIS_CASE: RebuildCase = {
  session: { id: 'msg-axis-session', status: 'active', type: 'worker' },
  messages: [
    message('user-consumed', 'user', userTextMessage('uuid-consumed', 'parity marker consumed')),
    message('user-null-status', 'user', userTextMessage('uuid-null-status', 'parity marker null'), {
      sendStatus: null,
    }),
    message('user-enqueued', 'user', userTextMessage('uuid-enqueued', 'parity marker enqueued'), {
      sendStatus: 'enqueued',
    }),
    message(
      'user-submitted',
      'user',
      userTextMessage('uuid-submitted', 'parity marker submitted'),
      {
        sendStatus: 'submitted',
      }
    ),
    message('user-deferred', 'user', userTextMessage('uuid-deferred', 'parity marker deferred'), {
      sendStatus: 'deferred',
    }),
    message('user-failed', 'user', userTextMessage('uuid-failed', 'parity marker failed'), {
      sendStatus: 'failed',
    }),
    message(
      'assistant-text',
      'assistant',
      assistantBlocksMessage('uuid-assistant', [{ type: 'text', text: 'parity marker assistant' }])
    ),
    message(
      'assistant-thinking',
      'assistant',
      assistantBlocksMessage('uuid-thinking', [
        { type: 'thinking', thinking: 'parity marker thinking' },
      ])
    ),
    message(
      'assistant-tool-use-only',
      'assistant',
      assistantBlocksMessage('uuid-tool-only', [
        { type: 'tool_use', id: 'toolu-1', name: 'Bash', input: {} },
      ])
    ),
    message(
      'assistant-mixed',
      'assistant',
      assistantBlocksMessage('uuid-mixed', [
        { type: 'tool_use', id: 'toolu-2', name: 'Bash', input: {} },
        { type: 'text', text: 'parity marker mixed' },
      ])
    ),
    message(
      'user-string-content',
      'user',
      userStringContentMessage('uuid-string', 'parity marker string')
    ),
    message('user-string-whitespace', 'user', userStringContentMessage('uuid-ws', ' \t \n ')),
    message('user-empty-array', 'user', {
      type: 'user',
      uuid: 'uuid-empty',
      message: { role: 'user', content: [] },
    }),
    message('result-kind', 'result', { type: 'result', result: 'parity marker result' }),
    message(
      'superseded',
      'assistant',
      assistantBlocksMessage('uuid-superseded', [
        { type: 'text', text: 'parity marker superseded' },
      ])
    ),
    message(
      'superseder',
      'assistant',
      assistantBlocksMessage('uuid-superseder', [
        { type: 'text', text: 'parity marker superseder' },
      ])
    ),
    message(
      'self-edge',
      'assistant',
      assistantBlocksMessage('uuid-self', [{ type: 'text', text: 'parity marker self edge' }])
    ),
    message('invalid-json', 'user', '{not valid json'),
    message('system-text', 'system', {
      type: 'system',
      uuid: 'uuid-system',
      message: { role: 'system', content: [{ type: 'text', text: 'parity marker system' }] },
    }),
  ],
  replacements: [
    { source: 'superseder', target: 'uuid-superseded' },
    { source: 'self-edge', target: 'uuid-self' },
  ],
};

const SESSION_AXIS_CASES: RebuildCase[] = [
  {
    session: {
      id: 'ended-at-ttl',
      status: 'ended',
      lastActiveAt: new Date(NOW - TTL_MS).toISOString(),
    },
    messages: [
      message('m-ended-at-ttl', 'user', userTextMessage('u-ended-at-ttl', 'ttl boundary body')),
    ],
  },
  {
    session: {
      id: 'ended-past-ttl',
      status: 'ended',
      lastActiveAt: new Date(NOW - TTL_MS - 1).toISOString(),
    },
    messages: [
      message('m-ended-past-ttl', 'user', userTextMessage('u-ended-past', 'ttl expired body')),
    ],
  },
  {
    session: {
      id: 'ended-subsecond-older',
      status: 'ended',
      lastActiveAt: new Date(NOW - TTL_MS - 100).toISOString(),
    },
    messages: [
      message('m-subsecond-older', 'user', userTextMessage('u-sub-old', 'subsecond older body')),
    ],
  },
  {
    session: {
      id: 'ended-subsecond-newer',
      status: 'ended',
      lastActiveAt: new Date(NOW - TTL_MS + 100).toISOString(),
    },
    messages: [
      message('m-subsecond-newer', 'user', userTextMessage('u-sub-new', 'subsecond newer body')),
    ],
  },
  {
    session: { id: 'archived-session', status: 'archived', type: 'worker' },
    messages: [
      message('m-archived', 'user', userTextMessage('u-archived', 'archived session body')),
    ],
  },
  {
    session: { id: 'null-type-session', status: 'active', type: null },
    messages: [message('m-null-type', 'user', userTextMessage('u-null-type', 'null type body'))],
  },
  {
    session: { id: 'lobby-type-session', status: 'active', type: 'lobby' },
    messages: [message('m-lobby', 'user', userTextMessage('u-lobby', 'lobby type body'))],
  },
  {
    session: { id: 'room-chat-type-session', status: 'active', type: 'room_chat' },
    messages: [
      message('m-room-chat-type', 'user', userTextMessage('u-rct', 'room chat type body')),
    ],
  },
  {
    session: { id: 'planner-type-session', status: 'active', type: 'planner' },
    messages: [message('m-planner-type', 'user', userTextMessage('u-pt', 'planner type body'))],
  },
  {
    session: { id: 'coder-type-session', status: 'active', type: 'coder' },
    messages: [message('m-coder-type', 'user', userTextMessage('u-ct', 'coder type body'))],
  },
  {
    session: { id: 'leader-type-session', status: 'active', type: 'leader' },
    messages: [message('m-leader-type', 'user', userTextMessage('u-lt', 'leader type body'))],
  },
  {
    session: { id: 'general-type-session', status: 'active', type: 'general' },
    messages: [message('m-general-type', 'user', userTextMessage('u-gt', 'general type body'))],
  },
  {
    session: {
      id: 'room-id-session',
      status: 'active',
      type: 'worker',
      context: { roomId: 'room-9' },
    },
    messages: [message('m-room-id', 'user', userTextMessage('u-rid', 'room id body'))],
  },
  {
    session: { id: 'room:chat:room-1', status: 'active', type: 'room_chat' },
    messages: [message('m-room-prefix', 'user', userTextMessage('u-rp', 'room prefix body'))],
  },
  {
    session: { id: 'planner:room-1:task-1', status: 'active', type: 'space_chat' },
    messages: [message('m-planner-prefix', 'user', userTextMessage('u-pp', 'planner prefix body'))],
  },
  {
    session: { id: 'space-chat-type-session', status: 'active', type: 'space_chat' },
    messages: [
      message('m-space-chat-type', 'user', userTextMessage('u-sct', 'space chat type body')),
    ],
  },
  {
    session: { id: 'space-task-agent-type-session', status: 'active', type: 'space_task_agent' },
    messages: [message('m-sta-type', 'user', userTextMessage('u-stat', 'space task agent body'))],
  },
];

interface SpaceTaskCase {
  sessionId: string;
  task: SeededTask;
  messageId: string;
}

const SPACE_TASK_CASES: SpaceTaskCase[] = [
  {
    sessionId: 'space:space-1:task:task-inprogress:exec:exec-1',
    task: { id: 'task-inprogress', status: 'in_progress', updatedAt: NOW - TTL_MS - 1 },
    messageId: 'm-task-inprogress',
  },
  {
    sessionId: 'space:space-1:task:task-archived:exec:exec-1',
    task: { id: 'task-archived', status: 'archived', updatedAt: NOW },
    messageId: 'm-task-archived',
  },
  {
    sessionId: 'space:space-1:task:task-done-at-ttl:exec:exec-1',
    task: {
      id: 'task-done-at-ttl',
      status: 'done',
      completedAt: NOW - TTL_MS,
      updatedAt: NOW - TTL_MS,
    },
    messageId: 'm-task-done-at-ttl',
  },
  {
    sessionId: 'space:space-1:task:task-done-past-ttl:exec:exec-1',
    task: {
      id: 'task-done-past-ttl',
      status: 'done',
      completedAt: NOW - TTL_MS - 1,
      updatedAt: NOW - TTL_MS - 1,
    },
    messageId: 'm-task-done-past-ttl',
  },
  {
    sessionId: 'space:space-1:task:task-cancelled-fallback:exec:exec-1',
    task: {
      id: 'task-cancelled-fallback',
      status: 'cancelled',
      completedAt: null,
      updatedAt: NOW - TTL_MS - 1,
    },
    messageId: 'm-task-cancelled-fallback',
  },
  {
    sessionId: 'space:space-1:task:task-completed-null-times:exec:exec-1',
    task: {
      id: 'task-completed-null-times',
      status: 'completed',
      completedAt: null,
      updatedAt: null,
    },
    messageId: 'm-task-completed-null-times',
  },
];

function spaceTaskCaseToRebuildCase(spaceTaskCase: SpaceTaskCase): RebuildCase {
  return {
    session: { id: spaceTaskCase.sessionId, status: 'active', type: 'worker' },
    task: spaceTaskCase.task,
    messages: [
      message(
        spaceTaskCase.messageId,
        'user',
        userTextMessage(`u-${spaceTaskCase.messageId}`, `${spaceTaskCase.messageId} body`),
        { taskId: spaceTaskCase.task.id, sendStatus: 'consumed' }
      ),
    ],
  };
}

function allCases(): RebuildCase[] {
  return [
    MESSAGE_AXIS_CASE,
    ...SESSION_AXIS_CASES,
    ...SPACE_TASK_CASES.map(spaceTaskCaseToRebuildCase),
  ];
}

describe('SessionRepository session-rebuild search parity', () => {
  let db: Database;
  let repository: SessionRepository;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(`
			CREATE TABLE sessions (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				status TEXT NOT NULL,
				type TEXT,
				last_active_at TEXT NOT NULL,
				session_context TEXT,
				room_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.roomId') END) VIRTUAL,
				space_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.spaceId') END) VIRTUAL,
				task_id TEXT GENERATED ALWAYS AS (CASE WHEN json_valid(session_context) THEN json_extract(session_context, '$.taskId') END) VIRTUAL
			);
			CREATE TABLE sdk_messages (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				message_type TEXT NOT NULL,
				message_subtype TEXT,
				sdk_message TEXT NOT NULL,
				timestamp TEXT NOT NULL,
				send_status TEXT,
				task_id TEXT,
				sdk_uuid TEXT,
				replacement_metadata_normalized INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE sdk_message_replacements (
				source_message_id TEXT NOT NULL,
				session_id TEXT NOT NULL,
				task_id TEXT,
				target_uuid TEXT NOT NULL,
				kind TEXT NOT NULL,
				PRIMARY KEY (source_message_id, target_uuid, kind)
			);
			CREATE TABLE space_tasks (
				id TEXT PRIMARY KEY,
				space_id TEXT NOT NULL,
				task_number INTEGER NOT NULL,
				status TEXT NOT NULL,
				completed_at INTEGER,
				updated_at INTEGER
			);
			CREATE TABLE message_search_content (
				kind TEXT,
				source_id TEXT,
				message_id TEXT,
				session_id TEXT,
				task_id TEXT,
				space_id TEXT,
				task_number INTEGER,
				message_type TEXT,
				title TEXT,
				body TEXT,
				timestamp INTEGER
			);
			CREATE VIRTUAL TABLE message_search_fts USING fts5(title, body, content='message_search_content', content_rowid='rowid', detail=column, tokenize = 'unicode61');
			CREATE TRIGGER message_search_content_ai AFTER INSERT ON message_search_content BEGIN INSERT INTO message_search_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END;
			CREATE TRIGGER message_search_content_ad AFTER DELETE ON message_search_content BEGIN INSERT INTO message_search_fts(message_search_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body); END;
			CREATE TRIGGER message_search_content_au AFTER UPDATE OF title, body ON message_search_content BEGIN INSERT INTO message_search_fts(message_search_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body); INSERT INTO message_search_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body); END
		`);
    repository = new SessionRepository(db as any);
  });

  afterEach(() => {
    db.close();
  });

  function seedCase(rebuildCase: RebuildCase): void {
    db.prepare(
      `INSERT INTO sessions (id, title, status, type, last_active_at, session_context)
			 VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      rebuildCase.session.id,
      `Title ${rebuildCase.session.id}`,
      rebuildCase.session.status,
      rebuildCase.session.type ?? null,
      rebuildCase.session.lastActiveAt ?? new Date(NOW - TTL_MS + 60_000).toISOString(),
      rebuildCase.session.context ? JSON.stringify(rebuildCase.session.context) : null
    );
    if (rebuildCase.task) {
      db.prepare(
        `INSERT INTO space_tasks (id, space_id, task_number, status, completed_at, updated_at)
			 VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        rebuildCase.task.id,
        'space-1',
        7,
        rebuildCase.task.status,
        rebuildCase.task.completedAt ?? null,
        rebuildCase.task.updatedAt ?? null
      );
    }
    const insertMessage = db.prepare(
      `INSERT INTO sdk_messages (
				 id, session_id, message_type, sdk_message, timestamp, send_status, task_id, sdk_uuid,
				 replacement_metadata_normalized
			 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
    );
    for (const seededMessage of rebuildCase.messages) {
      insertMessage.run(
        seededMessage.id,
        rebuildCase.session.id,
        seededMessage.messageType,
        seededMessage.sdkMessage,
        '2026-05-20T01:02:03.456Z',
        seededMessage.sendStatus ?? null,
        seededMessage.taskId ?? null,
        seededMessage.sdkUuid ?? null
      );
    }
    const insertReplacement = db.prepare(
      `INSERT INTO sdk_message_replacements (source_message_id, session_id, target_uuid, kind)
			 VALUES (?, ?, ?, ?)`
    );
    for (const replacement of rebuildCase.replacements ?? []) {
      insertReplacement.run(
        replacement.source,
        rebuildCase.session.id,
        replacement.target,
        replacement.kind ?? 'superseded'
      );
    }
  }

  function driveRebuild(rebuildCase: RebuildCase): void {
    if (rebuildCase.session.status !== 'archived') {
      repository.updateSession(
        rebuildCase.session.id,
        { status: rebuildCase.session.status as Session['status'] },
        NOW
      );
      return;
    }
    repository.updateSession(
      rebuildCase.session.id,
      { type: (rebuildCase.session.type ?? 'worker') as SessionType },
      NOW
    );
  }

  function readSessionRow(rebuildCase: RebuildCase): {
    id: string;
    status: string;
    type: string | null;
    last_active_at: string;
    room_id: string | null;
  } {
    return db
      .prepare(`SELECT id, status, type, last_active_at, room_id FROM sessions WHERE id = ?`)
      .get(rebuildCase.session.id) as {
      id: string;
      status: string;
      type: string | null;
      last_active_at: string;
      room_id: string | null;
    };
  }

  function isSupersededPerFlushGate(
    rebuildCase: RebuildCase,
    seededMessage: SeededMessage,
    parsed: Record<string, unknown>
  ): boolean {
    const uuid = parsed.uuid;
    if (typeof uuid !== 'string' || uuid.length === 0) return false;
    return Boolean(
      db
        .prepare(
          `SELECT 1
			 FROM sdk_message_replacements replacement
			 WHERE replacement.session_id = ?
			   AND replacement.source_message_id != ?
			   AND replacement.target_uuid = ?
			 LIMIT 1`
        )
        .get(rebuildCase.session.id, seededMessage.id, uuid)
    );
  }

  function expectedAdmittedIds(rebuildCase: RebuildCase): string[] {
    const sessionRow = readSessionRow(rebuildCase);
    const taskRow = rebuildCase.task
      ? (db
          .prepare(`SELECT status, completed_at, updated_at FROM space_tasks WHERE id = ?`)
          .get(rebuildCase.task.id) as {
          status: string;
          completed_at: number | null;
          updated_at: number | null;
        } | null)
      : null;
    const admitted: string[] = [];
    for (const seededMessage of rebuildCase.messages) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(seededMessage.sdkMessage) as Record<string, unknown>;
      } catch {
        continue;
      }
      const linkedTask = seededMessage.taskId !== null && taskRow ? taskRow : null;
      const decision = decideMessageSearchAdmission({
        messageType: seededMessage.messageType,
        body: extractVisibleSearchText(parsed),
        now: NOW,
        eligibility: {
          session_id: sessionRow.id,
          session_status: sessionRow.status,
          session_type: sessionRow.type,
          session_last_active_at: sessionRow.last_active_at,
          session_room_id: sessionRow.room_id,
          task_status: linkedTask ? linkedTask.status : null,
          task_completed_at: linkedTask ? linkedTask.completed_at : null,
          task_updated_at: linkedTask ? linkedTask.updated_at : null,
        },
        isSuperseded: () => isSupersededPerFlushGate(rebuildCase, seededMessage, parsed),
        isSearchableUserStatus: () =>
          (seededMessage.sendStatus ?? 'consumed') === 'consumed' ||
          seededMessage.sendStatus === 'failed',
      });
      if (decision.action === 'index') admitted.push(seededMessage.id);
    }
    return admitted.sort();
  }

  function indexedIds(sessionId: string): string[] {
    return (
      db
        .prepare(
          `SELECT source_id FROM message_search_content WHERE kind = 'message' AND session_id = ? ORDER BY source_id`
        )
        .all(sessionId) as Array<{ source_id: string }>
    ).map((row) => row.source_id);
  }

  it('admits exactly the rows the extracted message-search gates admit across the policy matrix', () => {
    const cases = allCases();
    for (const rebuildCase of cases) seedCase(rebuildCase);

    const indexedBySession: Record<string, string[]> = {};
    const expectedBySession: Record<string, string[]> = {};
    for (const rebuildCase of cases) {
      driveRebuild(rebuildCase);
      indexedBySession[rebuildCase.session.id] = indexedIds(rebuildCase.session.id);
      expectedBySession[rebuildCase.session.id] = expectedAdmittedIds(rebuildCase);
    }

    expect(indexedBySession).toEqual(expectedBySession);
  });

  it('admits the message-axis rows the gates admit', () => {
    seedCase(MESSAGE_AXIS_CASE);
    driveRebuild(MESSAGE_AXIS_CASE);
    expect(indexedIds(MESSAGE_AXIS_CASE.session.id)).toEqual([
      'assistant-mixed',
      'assistant-text',
      'assistant-thinking',
      'self-edge',
      'superseder',
      'system-text',
      'user-consumed',
      'user-failed',
      'user-null-status',
      'user-string-content',
    ]);
  });

  it('re-evaluates retention against the injected clock on every rebuild', () => {
    const rebuildCase: RebuildCase = {
      session: {
        id: 'clock-session',
        status: 'ended',
        lastActiveAt: new Date(NOW - TTL_MS - 1).toISOString(),
      },
      messages: [message('m-clock', 'user', userTextMessage('u-clock', 'injected clock body'))],
    };
    seedCase(rebuildCase);

    repository.updateSession('clock-session', { status: 'ended' }, NOW);
    expect(indexedIds('clock-session')).toEqual([]);

    repository.updateSession('clock-session', { status: 'ended' }, NOW - 5 * MINUTE_MS);
    expect(indexedIds('clock-session')).toEqual(['m-clock']);

    repository.updateSession('clock-session', { status: 'ended' }, NOW);
    expect(indexedIds('clock-session')).toEqual([]);
  });

  it('projects session, task, and message columns onto admitted rows', () => {
    const rebuildCase = spaceTaskCaseToRebuildCase(SPACE_TASK_CASES[0]);
    seedCase(rebuildCase);
    driveRebuild(rebuildCase);

    expect(
      db
        .prepare(
          `SELECT kind, source_id, message_id, session_id, task_id, space_id, task_number,
				 message_type, title, body, timestamp
			 FROM message_search_content WHERE session_id = ?`
        )
        .get(rebuildCase.session.id)
    ).toEqual({
      kind: 'message',
      source_id: 'm-task-inprogress',
      message_id: 'u-m-task-inprogress',
      session_id: rebuildCase.session.id,
      task_id: 'task-inprogress',
      space_id: 'space-1',
      task_number: 7,
      message_type: 'user',
      title: `Title ${rebuildCase.session.id}`,
      body: 'm-task-inprogress body',
      timestamp: MESSAGE_TIMESTAMP_MS,
    });
  });
});
