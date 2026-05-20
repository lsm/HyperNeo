import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type {
	ActiveTurnSummary,
	ActivityEntry,
	LiveQueryDeltaEvent,
	LiveQuerySnapshotEvent,
} from '@neokai/shared';
import { useMessageHub } from './useMessageHub';

export interface SpaceTaskThreadMessageRow {
	id: string | number;
	sessionId: string | null;
	kind: 'task_agent' | 'node_agent';
	role: string;
	label: string;
	nodeExecutionId?: string | null;
	taskId: string;
	taskTitle: string;
	messageType: string;
	content: string;
	createdAt: number;
	/** Message origin from the DB (human, system). Used to classify sender in the thread UI. */
	origin?: string | null;
	/** User-message delivery state from sdk_messages.send_status, normalized for UI badges. */
	deliveryState?: 'delivered' | 'failed' | null;
	parentToolUseId?: string | null;
	/**
	 * Server-computed turn index (per session) for compact thread grouping.
	 * Present in compact query rows; absent in full rows.
	 */
	turnIndex?: number;
	/**
	 * Count of earlier non-terminal messages hidden by compact cap in this
	 * session-turn. Present in compact query rows; absent in full rows.
	 */
	turnHiddenMessageCount?: number;
	/**
	 * Total messages stored for this session — populated by the compact query
	 * variant when the server has sliced the result set. When equal to the
	 * number of delivered rows for this session, nothing was truncated.
	 *
	 * Absent (undefined) when the full/legacy query is used.
	 */
	sessionMessageCount?: number;
}

interface ActiveTurnEntryRow {
	id: string;
	sessionId: string;
	turnIndex: number;
	ts: number;
	entry: ActivityEntry | null;
}

export type SpaceTaskMessagesQueryVariant = 'compact' | 'full';

export interface UseSpaceTaskMessagesResult {
	rows: SpaceTaskThreadMessageRow[];
	/** Server-computed activity summary for the currently-active turn of each session. */
	activeTurnSummaries: ActiveTurnSummary[];
	isLoading: boolean;
	isReconnecting: boolean;
}

let _taskMessageSubCounter = 0;
function nextTaskMessageSubId(taskId: string): string {
	_taskMessageSubCounter += 1;
	return `space-task-messages-${taskId}-${_taskMessageSubCounter}`;
}

let _activeTurnSubCounter = 0;
function nextActiveTurnSubId(taskId: string): string {
	_activeTurnSubCounter += 1;
	return `space-task-active-turn-${taskId}-${_activeTurnSubCounter}`;
}

function sortRows(rows: SpaceTaskThreadMessageRow[]): SpaceTaskThreadMessageRow[] {
	return [...rows].sort((a, b) => {
		if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
		return String(a.id).localeCompare(String(b.id));
	});
}

function sortActiveTurnRows(rows: ActiveTurnEntryRow[]): ActiveTurnEntryRow[] {
	return [...rows].sort((a, b) => {
		if (a.sessionId !== b.sessionId) return a.sessionId.localeCompare(b.sessionId);
		if (a.ts !== b.ts) return a.ts - b.ts;
		return a.id.localeCompare(b.id);
	});
}

function applyDelta(
	currentRows: SpaceTaskThreadMessageRow[],
	event: LiveQueryDeltaEvent
): SpaceTaskThreadMessageRow[] {
	const next = new Map(currentRows.map((row) => [String(row.id), row]));
	for (const row of (event.removed ?? []) as SpaceTaskThreadMessageRow[]) {
		next.delete(String(row.id));
	}
	for (const row of (event.updated ?? []) as SpaceTaskThreadMessageRow[]) {
		next.set(String(row.id), row);
	}
	for (const row of (event.added ?? []) as SpaceTaskThreadMessageRow[]) {
		next.set(String(row.id), row);
	}
	return sortRows(Array.from(next.values()));
}

function applyActiveTurnDelta(
	currentRows: ActiveTurnEntryRow[],
	event: LiveQueryDeltaEvent
): ActiveTurnEntryRow[] {
	const next = new Map(currentRows.map((row) => [row.id, row]));
	for (const row of (event.removed ?? []) as ActiveTurnEntryRow[]) {
		next.delete(row.id);
	}
	for (const row of (event.updated ?? []) as ActiveTurnEntryRow[]) {
		next.set(row.id, row);
	}
	for (const row of (event.added ?? []) as ActiveTurnEntryRow[]) {
		next.set(row.id, row);
	}
	return sortActiveTurnRows(Array.from(next.values()));
}

function buildActiveTurnSummaries(rows: ActiveTurnEntryRow[]): ActiveTurnSummary[] {
	const bySession = new Map<string, ActiveTurnSummary>();
	for (const row of sortActiveTurnRows(rows)) {
		if (!row.sessionId || !row.entry) continue;
		let summary = bySession.get(row.sessionId);
		if (!summary) {
			summary = { sessionId: row.sessionId, turnIndex: row.turnIndex, entries: [] };
			bySession.set(row.sessionId, summary);
		}
		summary.entries.push(row.entry);
	}
	return Array.from(bySession.values());
}

export function useSpaceTaskMessages(
	taskId: string | null,
	variant: SpaceTaskMessagesQueryVariant = 'compact'
): UseSpaceTaskMessagesResult {
	const { request, onEvent, getHub, isConnected } = useMessageHub();
	const [rows, setRows] = useState<SpaceTaskThreadMessageRow[]>([]);
	const [activeTurnRows, setActiveTurnRows] = useState<ActiveTurnEntryRow[]>([]);
	/**
	 * The task id whose LiveQuery snapshot has been applied to `rows`.
	 * `null` means either no subscription is active or we are still waiting
	 * for the first snapshot of the current `taskId`. `isLoading` is derived
	 * from the mismatch between this and the incoming `taskId`, which keeps
	 * the loading state correct from the very first render — no useEffect
	 * transition is needed to flip it to `true`, so the empty-state branch
	 * can never flash on mount or on task switch.
	 */
	const [loadedForTaskId, setLoadedForTaskId] = useState<string | null>(null);
	const activeSubIdRef = useRef<string | null>(null);
	const activeTurnSubIdRef = useRef<string | null>(null);

	const queryName =
		variant === 'full' ? 'spaceTaskMessages.byTask' : 'spaceTaskMessages.byTask.compact';

	useEffect(() => {
		if (!taskId || !isConnected) {
			setRows([]);
			setActiveTurnRows([]);
			setLoadedForTaskId(null);
			activeSubIdRef.current = null;
			activeTurnSubIdRef.current = null;
			return;
		}

		const subscriptionId = nextTaskMessageSubId(taskId);
		const activeTurnSubscriptionId = nextActiveTurnSubId(taskId);
		const shouldSubscribeActiveTurn = variant === 'compact';
		activeSubIdRef.current = subscriptionId;
		activeTurnSubIdRef.current = shouldSubscribeActiveTurn ? activeTurnSubscriptionId : null;
		// Clear stale rows from a previous subscription synchronously. The
		// empty-state UI is still suppressed because `loadedForTaskId` is now
		// out of sync with `taskId`, so consumers see the loading state.
		setRows([]);
		setActiveTurnRows([]);
		setLoadedForTaskId(null);

		const unsubSnapshot = onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
			if (event.subscriptionId === activeSubIdRef.current) {
				setRows(sortRows((event.rows as SpaceTaskThreadMessageRow[]) ?? []));
				setLoadedForTaskId(taskId);
				return;
			}
			if (event.subscriptionId === activeTurnSubIdRef.current) {
				setActiveTurnRows(sortActiveTurnRows((event.rows as ActiveTurnEntryRow[]) ?? []));
			}
		});

		const unsubDelta = onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
			if (event.subscriptionId === activeSubIdRef.current) {
				setRows((prev) => applyDelta(prev, event));
				return;
			}
			if (event.subscriptionId === activeTurnSubIdRef.current) {
				setActiveTurnRows((prev) => applyActiveTurnDelta(prev, event));
			}
		});

		const subscribe = () => {
			const hub = getHub();
			if (!hub) return;
			hub
				.request('liveQuery.subscribe', {
					queryName,
					params: [taskId],
					subscriptionId,
				})
				.catch(() => {
					// Release the loading gate on subscribe failure so consumers can
					// surface the empty state (or, more likely, the reconnecting state
					// once the websocket drops) rather than stalling forever.
					if (activeSubIdRef.current === subscriptionId) {
						setLoadedForTaskId(taskId);
					}
				});
			if (shouldSubscribeActiveTurn) {
				hub
					.request('liveQuery.subscribe', {
						queryName: 'spaceTaskActiveTurn.byTask',
						params: [taskId],
						subscriptionId: activeTurnSubscriptionId,
					})
					.catch(() => {
						if (activeTurnSubIdRef.current === activeTurnSubscriptionId) {
							setActiveTurnRows([]);
						}
					});
			}
		};

		const unsubReconnect = getHub()?.onConnection((state) => {
			if (state !== 'connected') return;
			if (activeSubIdRef.current !== subscriptionId) return;
			setLoadedForTaskId(null);
			subscribe();
		});

		subscribe();

		return () => {
			unsubSnapshot();
			unsubDelta();
			unsubReconnect?.();
			activeSubIdRef.current = null;
			activeTurnSubIdRef.current = null;
			Promise.resolve(request('liveQuery.unsubscribe', { subscriptionId })).catch(() => {});
			if (shouldSubscribeActiveTurn) {
				Promise.resolve(
					request('liveQuery.unsubscribe', { subscriptionId: activeTurnSubscriptionId })
				).catch(() => {});
			}
		};
	}, [taskId, isConnected, onEvent, request, getHub, queryName, variant]);

	const sortedRows = useMemo(() => sortRows(rows), [rows]);
	const activeTurnSummaries = useMemo(
		() => buildActiveTurnSummaries(activeTurnRows),
		[activeTurnRows]
	);

	// Derived: we are loading whenever we have an active taskId but have not
	// yet applied a snapshot for it. Computing this (instead of tracking it
	// as separate state) means the very first render — before the effect
	// runs — already returns `isLoading=true`, which is what suppresses the
	// empty-state flash on slow networks and on task switch.
	const isLoading = taskId !== null && isConnected && loadedForTaskId !== taskId;

	return {
		rows: sortedRows,
		activeTurnSummaries,
		isLoading,
		isReconnecting: !isConnected && taskId !== null,
	};
}
