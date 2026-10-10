import type { NeoConversationAsk } from '@hyperneo/shared/types/neo-conversation-ask';
import { useEffect, useRef, useState } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import { connectionManager } from '../lib/connection-manager.ts';
import { readNeoConversationAsks, type ConversationAskRead } from './conversation-ask-client.ts';
import { publicationConversationId } from './useNeoPublications.ts';

export type NeoAskState = {
  conversationId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  items: readonly NeoConversationAsk[];
  nextAfter: number;
  hasMore: boolean;
  hasEarlier: boolean;
};
const LIMIT = 50;
const WINDOW = 500;
const empty = (conversationId: string | null): NeoAskState => ({
  conversationId,
  status: 'idle',
  items: [],
  nextAfter: 0,
  hasMore: false,
  hasEarlier: false,
});

export function admitAskPage(
  state: NeoAskState,
  response: ConversationAskRead
): { value: Extract<ConversationAskRead, { state: 'ready' }> } | { reason: NeoAskState } {
  if (response.state === 'ready') {
    const ids = new Set(state.items.map((item) => item.requestId));
    if (response.items.every((item) => !ids.has(item.requestId))) return { value: response };
  } else if (response.state === 'stale') return { reason: state };
  return { reason: { ...state, status: 'unavailable' } };
}

export function appendAskWindow(
  state: NeoAskState,
  page: Extract<ConversationAskRead, { state: 'ready' }>
): NeoAskState {
  const all = [...state.items, ...page.items];
  return {
    ...state,
    status: 'ready',
    items: all.slice(-WINDOW),
    nextAfter: page.nextAfter,
    hasMore: page.items.length === LIMIT,
    hasEarlier: state.hasEarlier || all.length > WINDOW,
  };
}

export function placeAskTail(
  state: NeoAskState,
  page: Extract<ConversationAskRead, { state: 'ready' }>
): NeoAskState {
  return {
    ...state,
    status: 'ready',
    items: page.items,
    nextAfter: page.nextAfter,
    hasMore: false,
    hasEarlier: page.items.length === LIMIT,
  };
}

export function markUndeliveredAsks(
  state: NeoAskState,
  response: ConversationAskRead
): NeoAskState {
  if (response.state !== 'ready') return state;
  const failed = new Set(
    response.items.filter((item) => item.delivery?.state === 'failed').map((item) => item.requestId)
  );
  if (!state.items.some((item) => failed.has(item.requestId) && !item.delivery)) return state;
  return {
    ...state,
    items: state.items.map((item) =>
      failed.has(item.requestId) && !item.delivery
        ? { ...item, delivery: { state: 'failed' as const } }
        : item
    ),
  };
}

export function prependAskWindow(
  state: NeoAskState,
  page: Extract<ConversationAskRead, { state: 'ready' }>
): NeoAskState {
  const all = [...page.items, ...state.items];
  const kept = all.slice(0, WINDOW);
  return {
    ...state,
    status: 'ready',
    items: kept,
    nextAfter: all.length > WINDOW ? (kept.at(-1)?.sequence ?? 0) : state.nextAfter,
    hasMore: state.hasMore || all.length > WINDOW,
    hasEarlier: page.items.length === LIMIT,
  };
}

const placeAsks = (name: string, place: typeof appendAskWindow) =>
  (superpipe({})(name) as PipelineAPI)
    .input(['state', 'response'])
    .pipe(admitAskPage, ['state', 'response'], 'result:page')
    .pipe(place, ['state', 'page'], 'page')
    .end('page') as (state: NeoAskState, response: ConversationAskRead) => NeoAskState;
const applyAskTail = placeAsks('neo-conversation-ask-tail', placeAskTail);
const applyEarlierAsks = placeAsks('neo-conversation-ask-earlier', prependAskWindow);

const applyAskPage = (superpipe({})('neo-conversation-ask-state') as PipelineAPI)
  .input(['state', 'response'])
  .pipe(admitAskPage, ['state', 'response'], 'result:page')
  .pipe(appendAskWindow, ['state', 'page'], 'page')
  .end('page') as (state: NeoAskState, response: ConversationAskRead) => NeoAskState;

export function useNeoConversationAsks(rootSessionId: string | null) {
  const conversationId = publicationConversationId(rootSessionId);
  const root = useRef(conversationId);
  root.current = conversationId;
  const held = useRef<NeoAskState | null>(null);
  const advance = useRef<() => void>(() => {});
  const earlier = useRef<() => void>(() => {});
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<NeoAskState>(() => empty(conversationId));

  useEffect(() => {
    const carried = held.current;
    let disposed = false;
    let inFlight = false;
    let pending = false;
    let value = carried?.conversationId === conversationId ? carried : empty(conversationId);
    let unsubscribe = () => {};
    let reconnect = () => {};
    const current = () => !disposed && root.current === conversationId;
    const publish = (next: NeoAskState) => {
      if (!current()) return;
      value = next;
      held.current = next;
      setState(next);
    };
    if (!conversationId)
      return () => {
        disposed = true;
      };

    void connectionManager
      .getHub()
      .then((hub) => {
        if (!current()) return;
        const update = async (changed = false) => {
          if (!current()) return;
          if (inFlight) {
            pending = true;
            return;
          }
          inFlight = true;
          pending = false;
          const before = value;
          const tail = before.items.length === 0 && before.nextAfter === 0;
          publish({ ...before, status: 'loading' });
          const response = await readNeoConversationAsks(
            tail
              ? { conversationId, after: 0, before: Number.MAX_SAFE_INTEGER, limit: LIMIT }
              : { conversationId, after: before.nextAfter, limit: LIMIT },
            async () => hub,
            current
          );
          if (!current()) return;
          publish((tail ? applyAskTail : applyAskPage)(before, response));
          if (changed && !tail && value.status === 'ready' && value.items.length > 0) {
            const recent = await readNeoConversationAsks(
              { conversationId, after: 0, before: Number.MAX_SAFE_INTEGER, limit: LIMIT },
              async () => hub,
              current
            );
            if (!current()) return;
            publish(markUndeliveredAsks(value, recent));
          }
          inFlight = false;
          if (pending && value.status === 'ready') void update(true);
        };
        const loadEarlier = async () => {
          const oldest = value.items[0]?.sequence;
          if (!current() || inFlight || !value.hasEarlier || !oldest) return;
          inFlight = true;
          const before = value;
          publish({ ...before, status: 'loading' });
          const response = await readNeoConversationAsks(
            { conversationId, after: 0, before: oldest, limit: LIMIT },
            async () => hub,
            current
          );
          if (!current()) return;
          publish(applyEarlierAsks(before, response));
          inFlight = false;
          if (pending && value.status === 'ready') void update();
        };
        advance.current = () => void update();
        earlier.current = () => void loadEarlier();
        unsubscribe = hub.onEvent('neo.changed', () => void update(true));
        reconnect = hub.onConnection((connection) => {
          if (connection === 'connected') void update(true);
        });
        void update();
      })
      .catch(() => {
        publish({ ...value, status: 'unavailable' });
      });
    return () => {
      disposed = true;
      advance.current = () => {};
      earlier.current = () => {};
      unsubscribe();
      reconnect();
    };
  }, [conversationId, attempt]);

  return {
    ...(state.conversationId === conversationId ? state : empty(conversationId)),
    nextPage: () => advance.current(),
    loadEarlier: () => earlier.current(),
    retry: () => setAttempt((number) => number + 1),
  };
}
