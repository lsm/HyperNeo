import type { MessageFeedArgs } from '../../storage/sdk-message-feed-read.ts';
import { readSessionListMetadata } from '../../storage/repositories/session-list-live-read.ts';
import type { LiveQueryEvaluation } from '../../storage/live-query.ts';
import { Logger } from '../logger.ts';
import type {
  MessageHub,
  LiveQuerySubscribeRequest,
  LiveQuerySnapshotEvent,
  LiveQueryDeltaEvent,
  LiveQuerySubscribeResponse,
  LiveQueryUnsubscribeRequest,
  LiveQueryUnsubscribeResponse,
} from '@hyperneo/shared';
import type { LiveQueryEngine, LiveQueryHandle, QueryDiff } from '../../storage/live-query.ts';
import type { Database as BunDatabase } from '../../storage/sqlite-compat.ts';
import { NAMED_QUERY_REGISTRY } from '../live-query/registry.ts';
import {
  BACKGROUND_TASK_METADATA_SQL,
  mapMessageRow,
  mapThinMessageRow,
  mayChangeBackgroundTaskMetadata,
  MAX_MESSAGES_BY_SESSION_WINDOW,
  MESSAGES_BY_SESSION_SQL,
} from '../live-query/queries/messages.ts';
import {
  MAX_SPACE_TASK_MESSAGES_COMPACT_WINDOW,
  SPACE_TASK_MESSAGES_COMPACT_TOOL_SUMMARY_LIMIT,
} from '../live-query/queries/compact-task-messages.ts';
import type { NamedQuery } from '../live-query/types.ts';
import { ensureTaskMessageRows } from '../../storage/schema/task-message-rows.ts';
import { MessageHubHandlerError, ErrorCode, createEventMessage } from '@hyperneo/shared';
import { SPACE_TASK_MESSAGES_COMPACT_RECENT_TURNS } from '../live-query/queries/task-message-window.ts';
import { SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL } from '../live-query/queries/task-active-turn.ts';

export { NAMED_QUERY_REGISTRY };

export { MESSAGES_BY_SESSION_SQL };

export { BACKGROUND_TASK_METADATA_SQL };

export { SPACE_TASK_ACTIVE_TURN_ENTRIES_BY_TASK_SQL };

/** @public */
export { SPACE_TASK_MESSAGES_COMPACT_TOOL_SUMMARY_LIMIT };

/** @public */
export { SPACE_TASK_MESSAGES_COMPACT_RECENT_TURNS };

export type { NamedQuery };

const MESSAGE_FEED_QUERIES = new Set(['messages.bySession', 'messages.bySession.compact']);

const log = new Logger('live-query-handlers');

export function setupLiveQueryHandlers(
  messageHub: MessageHub,
  liveQueries: LiveQueryEngine,
  db: BunDatabase,
  readMessageFeed?: (args: MessageFeedArgs) => Promise<LiveQueryEvaluation>,
  readSessionList?: (includeArchived: number) => Promise<LiveQueryEvaluation>
): () => void {
  const subscriptions = new Map<string, Map<string, LiveQueryHandle<Record<string, unknown>>>>();

  const sessionsListBase = NAMED_QUERY_REGISTRY.get('sessions.list')!;
  const activeRegistry = new Map(NAMED_QUERY_REGISTRY);

  const stmtBackgroundTaskMetadata = readMessageFeed
    ? undefined
    : db.prepare(BACKGROUND_TASK_METADATA_SQL);
  for (const [queryName, mapRow] of [
    ['messages.bySession', mapMessageRow],
    ['messages.bySession.compact', mapThinMessageRow],
  ] as const) {
    activeRegistry.set(queryName, {
      ...NAMED_QUERY_REGISTRY.get(queryName)!,
      metadataScopeFilter: mayChangeBackgroundTaskMetadata,
      mapResult: (_rawRows, params) => {
        const sessionId = params[0];
        if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
        const rows = stmtBackgroundTaskMetadata!.all(
          sessionId,
          sessionId,
          sessionId,
          sessionId,
          sessionId,
          sessionId,
          sessionId
        ) as Record<string, unknown>[];
        return {
          backgroundTaskMessages: rows.map(mapRow).reverse(),
        };
      },
    });
  }

  activeRegistry.set('sessions.list', {
    ...sessionsListBase,
    mapResult: () => readSessionListMetadata(db),
  });

  const stmtRoom = db.prepare('SELECT id FROM rooms WHERE id = ?');
  const stmtGroup = db.prepare('SELECT ref_id, group_type FROM session_groups WHERE id = ?');
  const stmtTask = db.prepare('SELECT room_id FROM tasks WHERE id = ?');
  const stmtSpace = db.prepare('SELECT id FROM spaces WHERE id = ?');
  const stmtSession = readMessageFeed
    ? undefined
    : db.prepare('SELECT id FROM sessions WHERE id = ?');

  messageHub.onRequest('liveQuery.subscribe', async (data, context) => {
    const { queryName, subscriptionId } = data as LiveQuerySubscribeRequest;
    const params = [...((data as LiveQuerySubscribeRequest).params ?? [])];
    const { clientId, sessionId } = context;

    if (!clientId) {
      throw new Error('liveQuery.subscribe requires a WebSocket connection (clientId absent)');
    }

    const router = messageHub.getRouter();

    const namedQuery = activeRegistry.get(queryName);
    const asyncFeed = !!readMessageFeed && MESSAGE_FEED_QUERIES.has(queryName);
    const asyncSessionList = !!readSessionList && queryName === 'sessions.list';
    const asyncEvaluation = asyncFeed || asyncSessionList;
    if (!namedQuery) {
      throw new Error(`Unknown query name: "${queryName}"`);
    }

    if (queryName === 'spaceTaskMessages.byTask.compact' && params.length === 1) {
      params.push(MAX_SPACE_TASK_MESSAGES_COMPACT_WINDOW);
    }

    if (params.length !== namedQuery.paramCount) {
      throw new Error(
        `Query "${queryName}" expects ${namedQuery.paramCount} parameter(s), got ${params.length}`
      );
    }

    if (queryName === 'sessionGroupMessages.byGroup') {
      const groupId = params[0] as string;
      const group = stmtGroup.get(groupId) as { ref_id: string; group_type: string } | null;
      if (!group) {
        throw new Error(`Unauthorized: session group "${groupId}" not found`);
      }
      if (group.group_type === 'task') {
        const task = stmtTask.get(group.ref_id) as { room_id: string } | null;
        if (!task) {
          throw new Error(`Unauthorized: task "${group.ref_id}" not found`);
        }
        if (!stmtRoom.get(task.room_id)) {
          throw new Error(`Unauthorized: room "${task.room_id}" not found`);
        }
      }
    } else if (
      queryName === 'spaceTaskActivity.byTask' ||
      queryName === 'spaceTaskMessages.byTask' ||
      queryName === 'spaceTaskMessages.byTask.compact' ||
      queryName === 'spaceTaskActiveTurn.byTask'
    ) {
      const taskId = params[0] as string;
      let spaceTask: { space_id: string } | null = null;
      try {
        spaceTask = db
          .prepare('SELECT space_id FROM space_tasks WHERE id = ? AND space_id IS NOT NULL')
          .get(taskId) as {
          space_id: string;
        } | null;
      } catch {
        spaceTask = null;
      }
      if (!spaceTask) {
        throw new Error(`Unauthorized: space task "${taskId}" not found`);
      }
      if (queryName === 'spaceTaskMessages.byTask.compact') {
        const limit = params[1];
        if (
          typeof limit !== 'number' ||
          !Number.isInteger(limit) ||
          limit <= 0 ||
          limit > MAX_SPACE_TASK_MESSAGES_COMPACT_WINDOW
        ) {
          throw new Error(
            `Unauthorized: spaceTaskMessages.byTask.compact limit must be an integer in [1, ${MAX_SPACE_TASK_MESSAGES_COMPACT_WINDOW}], got ${String(limit)}`
          );
        }
      }
      if (
        queryName === 'spaceTaskMessages.byTask.compact' ||
        queryName === 'spaceTaskActiveTurn.byTask'
      ) {
        ensureTaskMessageRows(db, taskId);
      }
    } else if (
      queryName === 'spaceSessions.bySpace' ||
      queryName === 'mcpEnablement.bySpace' ||
      queryName === 'spaceWorkspaces.bySpace'
    ) {
      const spaceId = params[0] as string;
      if (!stmtSpace.get(spaceId)) {
        throw new Error(`Unauthorized: space "${spaceId}" not found`);
      }
    } else if (MESSAGE_FEED_QUERIES.has(queryName)) {
      const targetSessionId = params[0] as string;
      if (typeof targetSessionId !== 'string' || targetSessionId.length === 0) {
        throw new Error(`Unauthorized: ${queryName} requires a non-empty sessionId`);
      }
      if (!asyncFeed && !stmtSession!.get(targetSessionId)) {
        throw new Error(`Unauthorized: session "${targetSessionId}" not found`);
      }
      const limit = params[1];
      if (
        typeof limit !== 'number' ||
        !Number.isInteger(limit) ||
        limit <= 0 ||
        limit > MAX_MESSAGES_BY_SESSION_WINDOW
      ) {
        throw new Error(
          `Unauthorized: ${queryName} limit must be an integer in [1, ${MAX_MESSAGES_BY_SESSION_WINDOW}], got ${String(limit)}`
        );
      }
    }

    let clientSubs = subscriptions.get(clientId);
    if (!clientSubs) {
      clientSubs = new Map();
      subscriptions.set(clientId, clientSubs);
    }

    const existing = clientSubs.get(subscriptionId);
    const isReplacement = !!existing;
    if (existing) {
      log.debug(
        `liveQuery.subscribe: replacing subscription ${subscriptionId} for client ${clientId}`
      );
      existing.dispose();
      clientSubs.delete(subscriptionId);
      router?.releaseClientSubscription(clientId);
    }

    if (router && !isReplacement) {
      const capacity = router.checkSubscriptionCapacity(clientId);
      if (!capacity.ok) {
        throw new MessageHubHandlerError(
          `liveQuery.subscribe: subscription cap reached for client (${capacity.current}/${capacity.limit}); subscribe to fewer queries or close other views`,
          ErrorCode.TOO_MANY_SUBSCRIPTIONS
        );
      }
    }

    const { sql } = namedQuery;
    const mapRow = asyncEvaluation ? undefined : namedQuery.mapRow;
    const applyMapRow = (row: Record<string, unknown>) => (mapRow ? mapRow(row) : row);
    const applyMapRows = (rows: Record<string, unknown>[]) => rows.map(applyMapRow);

    let snapshotDeliveryFailed = false;
    let snapshotTooLarge = false;

    let handle: LiveQueryHandle<Record<string, unknown>> | undefined;
    const release = () => {
      handle?.dispose();
      if (subscriptions.get(clientId) !== clientSubs || clientSubs.get(subscriptionId) !== handle)
        return;
      clientSubs.delete(subscriptionId);
      if (!clientSubs.size) subscriptions.delete(clientId);
      router?.releaseClientSubscription(clientId);
    };
    router?.addClientSubscription(clientId);
    const register = liveQueries.subscribe.bind(
      liveQueries,
      sql,
      params,
      (diff: QueryDiff<Record<string, unknown>>) => {
        const deliveryTrace = MESSAGE_FEED_QUERIES.has(queryName)
          ? {
              clientId,
              subscriptionId,
              queryName,
              sessionId: params[0],
              phase: diff.type,
              version: diff.version,
              rowCount: diff.rows.length,
              rowIds: diff.type === 'snapshot' ? diff.rows.map((row) => row.id) : undefined,
              addedIds: diff.added?.map((row) => row.id),
              removedIds: diff.removed?.map((row) => row.id),
              updatedIds: diff.updated?.map((row) => row.id),
            }
          : undefined;
        if (deliveryTrace) log.debugWithMetadata(deliveryTrace, 'liveQuery.emitted');
        const router = messageHub.getRouter();
        if (!router) {
          if (deliveryTrace) {
            log.debugWithMetadata(
              { ...deliveryTrace, outcome: 'router_unavailable' },
              'liveQuery.delivery'
            );
          }
          log.warn(
            `liveQuery: router unavailable; skipping event (clientId=${clientId}, subscriptionId=${subscriptionId})`
          );
          if (diff.type === 'snapshot') {
            snapshotDeliveryFailed = true;
          }
          return;
        }

        const metadata = diff.metadata;

        let message: ReturnType<typeof createEventMessage>;

        if (diff.type === 'snapshot') {
          const eventData: LiveQuerySnapshotEvent = {
            subscriptionId,
            rows: applyMapRows(diff.rows),
            version: diff.version,
            ...(metadata ? { metadata } : {}),
          };
          message = createEventMessage({
            method: 'liveQuery.snapshot',
            data: eventData,
            sessionId,
          });
        } else {
          const eventData: LiveQueryDeltaEvent = {
            subscriptionId,
            added: diff.added ? applyMapRows(diff.added) : undefined,
            removed: diff.removed ? applyMapRows(diff.removed) : undefined,
            updated: diff.updated ? applyMapRows(diff.updated) : undefined,
            rowCount: diff.rows.length,
            version: diff.version,
            ...(metadata ? { metadata } : {}),
          };
          message = createEventMessage({
            method: 'liveQuery.delta',
            data: eventData,
            sessionId,
          });
        }

        const delivery = router.sendToClientDetailed(clientId, message);
        if (deliveryTrace) {
          log.debugWithMetadata(
            { ...deliveryTrace, outcome: delivery.ok ? 'sent' : delivery.reason },
            'liveQuery.delivery'
          );
        }
        if (!delivery.ok && delivery.reason === 'message_too_large') {
          const errorMessage = createEventMessage({
            method: 'liveQuery.error',
            data: {
              subscriptionId,
              code: 'MESSAGE_TOO_LARGE',
              message: 'Live query update is too large to send; load a smaller window',
              phase: diff.type,
            },
            sessionId,
          });
          router.sendToClient(clientId, errorMessage);
          if (diff.type === 'snapshot') {
            snapshotTooLarge = true;
          } else {
            release();
          }
          return;
        }
        if (!delivery.ok) {
          if (diff.type === 'snapshot') {
            snapshotDeliveryFailed = true;
            log.warn(
              `liveQuery: snapshot delivery failed for client ${clientId}; subscription ${subscriptionId} will be disposed`
            );
          } else {
            log.warn(
              `liveQuery: delta delivery failed for client ${clientId}; disposing subscription ${subscriptionId}`
            );
            release();
          }
        }
      },
      {
        debounceMs: namedQuery.debounceMs,
        evaluateAsync: asyncSessionList
          ? () => readSessionList!(params[0] as number)
          : asyncFeed
            ? () =>
                readMessageFeed!({
                  sessionId: params[0] as string,
                  limit: params[1] as number,
                  feed: queryName === 'messages.bySession.compact' ? 'compact' : 'full',
                })
            : undefined,
        onError: (error) => {
          release();
          router?.sendToClient(
            clientId,
            createEventMessage({
              method: 'liveQuery.error',
              sessionId,
              data: {
                subscriptionId,
                code: 'QUERY_FAILED',
                message: error.message,
                phase: 'delta',
              },
            })
          );
        },
        getMetadata: asyncEvaluation ? undefined : namedQuery.mapResult,
        scopeFilter: namedQuery.buildScopeFilter?.(params, db),
        metadataScopeFilter: namedQuery.metadataScopeFilter,
        rowFingerprint: namedQuery.rowFingerprint,
        expandRows: namedQuery.expandRows
          ? (rows, params) => namedQuery.expandRows!(rows, params, db)
          : undefined,
      }
    );

    try {
      handle = register();
      clientSubs.set(subscriptionId, handle);
      await handle.ready;
      if (clientSubs.get(subscriptionId) !== handle)
        throw new Error('Live query subscription disposed');

      if (snapshotTooLarge) {
        throw new Error('MESSAGE_TOO_LARGE: Live query snapshot exceeds the outbound size limit');
      }

      if (snapshotDeliveryFailed) {
        throw new MessageHubHandlerError(
          'Live query snapshot delivery failed; subscription was not established',
          ErrorCode.INTERNAL_ERROR
        );
      }
    } catch (error) {
      if (handle) release();
      else router?.releaseClientSubscription(clientId);
      throw error;
    }
    log.debug(
      `liveQuery.subscribe: registered subscription ${subscriptionId} for client ${clientId}, query=${queryName}`
    );

    return { ok: true } satisfies LiveQuerySubscribeResponse;
  });

  messageHub.onRequest('liveQuery.unsubscribe', (data, context) => {
    const { subscriptionId } = data as LiveQueryUnsubscribeRequest;
    const { clientId } = context;

    if (!clientId) {
      throw new Error('liveQuery.unsubscribe requires a WebSocket connection (clientId absent)');
    }

    const clientSubs = subscriptions.get(clientId);
    const handle = clientSubs?.get(subscriptionId);
    if (handle) {
      handle.dispose();
      clientSubs!.delete(subscriptionId);
      if (clientSubs!.size === 0) subscriptions.delete(clientId);
      messageHub.getRouter()?.releaseClientSubscription(clientId);
      log.debug(
        `liveQuery.unsubscribe: disposed subscription ${subscriptionId} for client ${clientId}`
      );
    } else {
      log.debug(
        `liveQuery.unsubscribe: subscription ${subscriptionId} not found for client ${clientId}`
      );
    }

    return { ok: true } satisfies LiveQueryUnsubscribeResponse;
  });

  const unsubDisconnect = messageHub.onClientDisconnect((disconnectedClientId) => {
    const clientSubs = subscriptions.get(disconnectedClientId);
    if (!clientSubs || clientSubs.size === 0) return;

    log.debug(
      `liveQuery: client ${disconnectedClientId} disconnected; disposing ${clientSubs.size} subscription(s)`
    );
    for (const [, handle] of clientSubs) {
      handle.dispose();
    }
    subscriptions.delete(disconnectedClientId);
  });

  return () => {
    for (const [, clientSubs] of subscriptions) {
      for (const [, handle] of clientSubs) {
        handle.dispose();
      }
    }
    subscriptions.clear();
    unsubDisconnect();
  };
}
