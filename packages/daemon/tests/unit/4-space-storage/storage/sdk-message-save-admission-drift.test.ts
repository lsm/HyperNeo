import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { HyperNeoActionMessage } from '@hyperneo/shared';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  SDKMessageRepository,
  type SendStatus,
} from '../../../../src/storage/repositories/sdk-message-repository';
import { Database as BunDatabase } from '../../../../src/storage/sqlite-compat';
import { createSpaceTables } from '../../helpers/space-test-db';

const NOW = '2026-01-01T00:00:00.000Z';

function linkTaskSession(db: BunDatabase, sessionId: string, taskId: string): void {
  db.prepare(
    `INSERT INTO sessions
       (id, title, created_at, last_active_at, status, config, metadata, type, session_context)
     VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'space_task_agent', ?)`
  ).run(sessionId, sessionId, NOW, NOW, JSON.stringify({ taskId }));
}

function linkPlainSession(db: BunDatabase, sessionId: string): void {
  db.prepare(
    `INSERT INTO sessions
       (id, title, created_at, last_active_at, status, config, metadata, type)
     VALUES (?, ?, ?, ?, 'active', '{}', '{}', 'worker')`
  ).run(sessionId, sessionId, NOW, NOW);
}

function userMessage(uuid: string, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'user',
    uuid,
    message: { role: 'user', content: [{ type: 'text', text: `text-${uuid}` }] },
    ...extra,
  } as unknown as SDKMessage;
}

function toolResultUserMessage(uuid: string): SDKMessage {
  return {
    type: 'user',
    uuid,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'toolu-1', content: 'result' }],
    },
  } as unknown as SDKMessage;
}

function assistantMessage(uuid: string): SDKMessage {
  return {
    type: 'assistant',
    uuid,
    message: { role: 'assistant', content: [{ type: 'text', text: `text-${uuid}` }] },
  } as unknown as SDKMessage;
}

function resultMessage(uuid: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    uuid,
    is_error: false,
    result: 'done',
  } as unknown as SDKMessage;
}

function actionMessage(uuid: string, timestamp: number): HyperNeoActionMessage {
  return {
    type: 'hyperneo_action',
    uuid,
    session_id: 'sess-action',
    action: 'sdk_resume_choice',
    resolved: false,
    timestamp,
  };
}

describe('save-admission drift matrix (chain B1)', () => {
  let db: BunDatabase;
  let repo: SDKMessageRepository;

  beforeEach(() => {
    db = new BunDatabase(':memory:');
    createSpaceTables(db);
    repo = new SDKMessageRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function rowOf(id: string): {
    send_status: string;
    is_renderable: number;
    is_terminal: number;
    conversation_turn_index: number | null;
    consumed_seq: number | null;
    task_id: string | null;
    sdk_uuid: string | null;
  } {
    return db
      .prepare(
        `SELECT send_status, is_renderable, is_terminal, conversation_turn_index,
                consumed_seq, task_id, sdk_uuid
           FROM sdk_messages WHERE id = ?`
      )
      .get(id) as ReturnType<typeof rowOf>;
  }

  function idBySdkUuid(uuid: string): string {
    return (
      db.prepare(`SELECT id FROM sdk_messages WHERE sdk_uuid = ?`).get(uuid) as { id: string }
    ).id;
  }

  function badgeOf(sessionId: string): number {
    return (
      db.prepare(`SELECT visible_message_count AS n FROM sessions WHERE id = ?`).get(sessionId) as {
        n: number;
      }
    ).n;
  }

  function edgesOf(sourceId: string): Array<{ target_uuid: string; kind: string }> {
    return db
      .prepare(
        `SELECT target_uuid, kind FROM sdk_message_replacements
          WHERE source_message_id = ? ORDER BY kind, target_uuid`
      )
      .all(sourceId) as Array<{ target_uuid: string; kind: string }>;
  }

  function nextConsumedSeqValue(): number {
    return (
      db.prepare(`SELECT next_seq FROM delivery_consumed_seq WHERE singleton = 1`).get() as {
        next_seq: number;
      }
    ).next_seq;
  }

  describe('SDKMessage pair: saveSDKMessage x saveUserMessageCore across the five send statuses', () => {
    const SID = 'sess-matrix';
    const TASK = 'task-matrix';

    function seedAnchorTurn(): void {
      repo.saveUserMessageCore(SID, userMessage('seed-anchor'), 'consumed');
    }

    const CELLS: Array<{
      label: string;
      saveProbe: () => { id: string; countsTowardsBadge: boolean | null };
      sendStatus: string;
      turn: number;
      badge: number;
    }> = [
      {
        label:
          "saveSDKMessage — one fixed-status row: no status param, badge sendStatus null, schema default 'consumed'",
        saveProbe: () => {
          expect(
            repo.saveSDKMessage(SID, userMessage('probe-sdk', { supersedes: ['edge-a'] }))
          ).toBe(true);
          return { id: idBySdkUuid('probe-sdk'), countsTowardsBadge: null };
        },
        sendStatus: 'consumed',
        turn: 2,
        badge: 2,
      },
      {
        label: "saveUserMessageCore 'deferred'",
        saveProbe: () =>
          repo.saveUserMessageCore(
            SID,
            userMessage('probe-core', { supersedes: ['edge-a'] }),
            'deferred'
          ),
        sendStatus: 'deferred',
        turn: 1,
        badge: 1,
      },
      {
        label: "saveUserMessageCore 'enqueued'",
        saveProbe: () =>
          repo.saveUserMessageCore(
            SID,
            userMessage('probe-core', { supersedes: ['edge-a'] }),
            'enqueued'
          ),
        sendStatus: 'enqueued',
        turn: 1,
        badge: 1,
      },
      {
        label: "saveUserMessageCore 'submitted'",
        saveProbe: () =>
          repo.saveUserMessageCore(
            SID,
            userMessage('probe-core', { supersedes: ['edge-a'] }),
            'submitted'
          ),
        sendStatus: 'submitted',
        turn: 1,
        badge: 1,
      },
      {
        label: "saveUserMessageCore 'consumed'",
        saveProbe: () =>
          repo.saveUserMessageCore(
            SID,
            userMessage('probe-core', { supersedes: ['edge-a'] }),
            'consumed'
          ),
        sendStatus: 'consumed',
        turn: 2,
        badge: 2,
      },
      {
        label: "saveUserMessageCore 'failed'",
        saveProbe: () =>
          repo.saveUserMessageCore(
            SID,
            userMessage('probe-core', { supersedes: ['edge-a'] }),
            'failed'
          ),
        sendStatus: 'failed',
        turn: 2,
        badge: 2,
      },
    ];

    test.each(CELLS)('%s', (cell) => {
      linkTaskSession(db, SID, TASK);
      seedAnchorTurn();

      const { id, countsTowardsBadge } = cell.saveProbe();
      const row = rowOf(id);

      expect(row.send_status).toBe(cell.sendStatus);
      expect(row.is_renderable).toBe(1);
      expect(row.is_terminal).toBe(0);
      expect(row.task_id).toBe(TASK);
      expect(row.conversation_turn_index).toBe(cell.turn);
      expect(row.consumed_seq).toBeNull();
      expect(badgeOf(SID)).toBe(cell.badge);
      expect(edgesOf(id)).toEqual([{ target_uuid: 'edge-a', kind: 'superseded' }]);
      if (countsTowardsBadge !== null) {
        expect(countsTowardsBadge).toBe(cell.badge === 2);
      }
    });
  });

  describe('conversation-turn anchor scope', () => {
    test('anchor allocation reads MAX across the whole task; non-anchor reads MAX within the session', () => {
      linkTaskSession(db, 'sess-a', 'task-scope');
      linkTaskSession(db, 'sess-b', 'task-scope');
      repo.saveUserMessageCore('sess-a', userMessage('anchor-a'), 'consumed');

      repo.saveSDKMessage('sess-b', assistantMessage('non-anchor-b'));
      expect(rowOf(idBySdkUuid('non-anchor-b')).conversation_turn_index).toBe(0);

      repo.saveUserMessageCore('sess-b', userMessage('anchor-b'), 'consumed');
      expect(rowOf(idBySdkUuid('anchor-b')).conversation_turn_index).toBe(2);
    });

    test('non-user types never anchor on either variant, even at consumed status', () => {
      linkTaskSession(db, 'sess-type', 'task-type');
      repo.saveUserMessageCore('sess-type', userMessage('anchor-1'), 'consumed');

      repo.saveSDKMessage('sess-type', assistantMessage('assistant-sdk'));
      repo.saveUserMessageCore('sess-type', assistantMessage('assistant-core'), 'consumed');

      expect(rowOf(idBySdkUuid('assistant-sdk')).conversation_turn_index).toBe(1);
      expect(rowOf(idBySdkUuid('assistant-core')).conversation_turn_index).toBe(1);
    });

    test('a non-renderable user row counts toward the badge but does not anchor a turn', () => {
      linkTaskSession(db, 'sess-tool', 'task-tool');
      repo.saveUserMessageCore('sess-tool', userMessage('anchor-tool'), 'consumed');
      expect(badgeOf('sess-tool')).toBe(1);

      repo.saveUserMessageCore('sess-tool', toolResultUserMessage('tool-core'), 'consumed');
      repo.saveSDKMessage('sess-tool', toolResultUserMessage('tool-sdk'));

      expect(rowOf(idBySdkUuid('tool-core')).conversation_turn_index).toBe(1);
      expect(rowOf(idBySdkUuid('tool-sdk')).conversation_turn_index).toBe(1);
      expect(badgeOf('sess-tool')).toBe(3);
    });

    test('rows in sessions without a task keep a NULL conversation_turn_index', () => {
      linkPlainSession(db, 'sess-plain');
      repo.saveUserMessageCore('sess-plain', userMessage('anchor-plain'), 'consumed');
      repo.saveSDKMessage('sess-plain', assistantMessage('assistant-plain'));

      expect(rowOf(idBySdkUuid('anchor-plain')).conversation_turn_index).toBeNull();
      expect(rowOf(idBySdkUuid('assistant-plain')).conversation_turn_index).toBeNull();
    });
  });

  describe('replacement-edge recording', () => {
    test('retracted edges are recorded only under the model_refusal_fallback subtype, on both variants', () => {
      linkTaskSession(db, 'sess-refusal', 'task-refusal');

      const gatedCore = repo.saveUserMessageCore(
        'sess-refusal',
        userMessage('core-refusal', {
          subtype: 'model_refusal_fallback',
          supersedes: ['sup-1'],
          retracted_message_uuids: ['ret-1'],
        }),
        'deferred'
      ).id;
      expect(edgesOf(gatedCore)).toEqual([
        { target_uuid: 'ret-1', kind: 'retracted' },
        { target_uuid: 'sup-1', kind: 'superseded' },
      ]);

      repo.saveSDKMessage(
        'sess-refusal',
        userMessage('sdk-refusal', {
          subtype: 'model_refusal_fallback',
          retracted_message_uuids: ['ret-2'],
        })
      );
      expect(edgesOf(idBySdkUuid('sdk-refusal'))).toEqual([
        { target_uuid: 'ret-2', kind: 'retracted' },
      ]);

      const ungatedCore = repo.saveUserMessageCore(
        'sess-refusal',
        userMessage('core-plain', { retracted_message_uuids: ['ret-3'] }),
        'consumed'
      ).id;
      expect(edgesOf(ungatedCore)).toEqual([]);

      repo.saveSDKMessage(
        'sess-refusal',
        userMessage('sdk-plain', { retracted_message_uuids: ['ret-4'] })
      );
      expect(edgesOf(idBySdkUuid('sdk-plain'))).toEqual([]);
    });

    test('duplicate and malformed supersedes entries collapse to one edge per target', () => {
      linkTaskSession(db, 'sess-dedupe', 'task-dedupe');

      repo.saveSDKMessage(
        'sess-dedupe',
        userMessage('sdk-dedupe', { supersedes: ['dup-1', 'dup-1', '', 42, 'dup-2'] })
      );
      expect(edgesOf(idBySdkUuid('sdk-dedupe'))).toEqual([
        { target_uuid: 'dup-1', kind: 'superseded' },
        { target_uuid: 'dup-2', kind: 'superseded' },
      ]);

      const coreDedupe = repo.saveUserMessageCore(
        'sess-dedupe',
        userMessage('core-dedupe', { supersedes: ['dup-3', 'dup-3', null] }),
        'enqueued'
      ).id;
      expect(edgesOf(coreDedupe)).toEqual([{ target_uuid: 'dup-3', kind: 'superseded' }]);
    });
  });

  describe('consumed_seq admission divergence', () => {
    test('saveSDKMessage allocates from delivery_consumed_seq at insert for terminal results only', () => {
      linkTaskSession(db, 'sess-term', 'task-term');

      repo.saveSDKMessage('sess-term', assistantMessage('assistant-term'));
      expect(rowOf(idBySdkUuid('assistant-term')).consumed_seq).toBeNull();
      expect(nextConsumedSeqValue()).toBe(1);

      repo.saveSDKMessage('sess-term', resultMessage('result-1'));
      repo.saveSDKMessage('sess-term', resultMessage('result-2'));
      expect(rowOf(idBySdkUuid('result-1')).consumed_seq).toBe(2);
      expect(rowOf(idBySdkUuid('result-2')).consumed_seq).toBe(3);
      expect(nextConsumedSeqValue()).toBe(3);
    });

    test('saveUserMessageCore leaves consumed_seq NULL at insert for every status, terminal input included', () => {
      linkTaskSession(db, 'sess-core-seq', 'task-core-seq');

      const statuses: SendStatus[] = ['deferred', 'enqueued', 'submitted', 'consumed', 'failed'];
      for (const status of statuses) {
        const id = repo.saveUserMessageCore(
          'sess-core-seq',
          userMessage(`core-seq-${status}`),
          status
        ).id;
        expect(rowOf(id).consumed_seq).toBeNull();
      }

      const syntheticTerminal = repo.saveUserMessageCore(
        'sess-core-seq',
        resultMessage('core-result'),
        'consumed'
      ).id;
      expect(rowOf(syntheticTerminal).is_terminal).toBe(1);
      expect(rowOf(syntheticTerminal).consumed_seq).toBeNull();
      expect(nextConsumedSeqValue()).toBe(1);
    });

    test('the consumed flip allocates the sequence; the failed flip does not', () => {
      linkTaskSession(db, 'sess-flip', 'task-flip');

      const consumedId = repo.saveUserMessageCore(
        'sess-flip',
        userMessage('flip-consumed'),
        'deferred'
      ).id;
      const failedId = repo.saveUserMessageCore(
        'sess-flip',
        userMessage('flip-failed'),
        'enqueued'
      ).id;

      repo.updateMessageStatus([consumedId], 'consumed');
      repo.updateMessageStatus([failedId], 'failed');

      expect(rowOf(consumedId).consumed_seq).toBe(2);
      expect(rowOf(failedId).consumed_seq).toBeNull();
      expect(nextConsumedSeqValue()).toBe(2);
    });
  });

  describe('saveHyperNeoActionMessage fixed-shape admission (disjoint HyperNeoActionMessage input)', () => {
    const ACTION_TS = Date.parse('2026-02-03T04:05:06.000Z');

    test('stores the fixed row shape with schema-default send_status and render/terminal defaults', () => {
      linkTaskSession(db, 'sess-action', 'task-action');

      const id = repo.saveHyperNeoActionMessage('sess-action', actionMessage('act-1', ACTION_TS));

      const row = db
        .prepare(
          `SELECT message_type, message_subtype, sdk_message, timestamp, send_status, origin,
                  is_renderable, is_terminal, task_id, sdk_uuid, replacement_metadata_normalized
             FROM sdk_messages WHERE id = ?`
        )
        .get(id) as {
        message_type: string;
        message_subtype: string;
        sdk_message: string;
        timestamp: string;
        send_status: string;
        origin: string | null;
        is_renderable: number;
        is_terminal: number;
        task_id: string | null;
        sdk_uuid: string | null;
        replacement_metadata_normalized: number;
      };
      expect(row.message_type).toBe('hyperneo_action');
      expect(row.message_subtype).toBe('sdk_resume_choice');
      expect(JSON.parse(row.sdk_message)).toEqual(actionMessage('act-1', ACTION_TS));
      expect(row.timestamp).toBe('2026-02-03T04:05:06.000Z');
      expect(row.send_status).toBe('consumed');
      expect(row.origin).toBeNull();
      expect(row.is_renderable).toBe(1);
      expect(row.is_terminal).toBe(0);
      expect(row.task_id).toBe('task-action');
      expect(row.sdk_uuid).toBe('act-1');
      expect(row.replacement_metadata_normalized).toBe(1);
    });

    test('never anchors a turn: joins the session current turn after an anchor exists', () => {
      linkTaskSession(db, 'sess-action-turn', 'task-action-turn');
      repo.saveUserMessageCore('sess-action-turn', userMessage('anchor-action'), 'consumed');

      repo.saveHyperNeoActionMessage('sess-action-turn', actionMessage('act-turn', ACTION_TS));

      expect(rowOf(idBySdkUuid('act-turn')).conversation_turn_index).toBe(1);
    });

    test('a lone action in a fresh task session lands on turn 0, not a new turn', () => {
      linkTaskSession(db, 'sess-action-alone', 'task-action-alone');

      repo.saveHyperNeoActionMessage('sess-action-alone', actionMessage('act-alone', ACTION_TS));

      expect(rowOf(idBySdkUuid('act-alone')).conversation_turn_index).toBe(0);
    });

    test('a non-task session keeps a NULL task_id and turn index', () => {
      linkPlainSession(db, 'sess-action-plain');

      repo.saveHyperNeoActionMessage('sess-action-plain', actionMessage('act-plain', ACTION_TS));

      const row = rowOf(idBySdkUuid('act-plain'));
      expect(row.task_id).toBeNull();
      expect(row.conversation_turn_index).toBeNull();
    });

    test('counts toward the badge on every save', () => {
      linkTaskSession(db, 'sess-action-badge', 'task-action-badge');
      expect(badgeOf('sess-action-badge')).toBe(0);

      repo.saveHyperNeoActionMessage('sess-action-badge', actionMessage('act-badge-1', ACTION_TS));
      repo.saveHyperNeoActionMessage('sess-action-badge', actionMessage('act-badge-2', ACTION_TS));

      expect(badgeOf('sess-action-badge')).toBe(2);
    });
  });
});
