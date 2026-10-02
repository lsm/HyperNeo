import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import { useEffect, useRef, useState } from 'preact/hooks';
import superpipe, { type PipelineAPI } from 'superpipe';
import { connectionManager } from '../lib/connection-manager.ts';
import {
  admitPublicationCursor,
  readNeoPublications,
  type PublicationRead,
} from './publication-client.ts';

export type NeoPublicationState = {
  conversationId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'unavailable';
  items: readonly NeoPublication[];
  nextAfter: number;
  hasMore: boolean;
  hasEarlier: boolean;
};
const empty = (conversationId: string | null): NeoPublicationState => ({
  conversationId,
  status: 'idle',
  items: [],
  nextAfter: 0,
  hasMore: false,
  hasEarlier: false,
});

export function publicationConversationId(sessionId: string | null): string | null {
  if (!sessionId?.startsWith('neo:')) return null;
  const conversationId = sessionId.slice(4);
  return 'value' in admitPublicationCursor({ conversationId, after: 0, limit: 50 })
    ? conversationId
    : null;
}

export function admitPublicationUpdate(
  state: NeoPublicationState,
  response: PublicationRead
): { value: Extract<PublicationRead, { state: 'ready' }> } | { reason: NeoPublicationState } {
  if (response.state === 'stale') return { reason: state };
  const ids = new Set(state.items.map((item) => item.publicationId));
  return response.state === 'ready' && response.items.every((item) => !ids.has(item.publicationId))
    ? { value: response }
    : { reason: { ...state, status: 'unavailable' } };
}

export function appendPublicationWindow(
  state: NeoPublicationState,
  page: Extract<PublicationRead, { state: 'ready' }>
): NeoPublicationState {
  const all = [...state.items, ...page.items];
  return {
    ...state,
    status: 'ready',
    items: all.slice(-500),
    nextAfter: page.nextAfter,
    hasMore: page.items.length === 50,
    hasEarlier: state.hasEarlier || all.length > 500,
  };
}

export function placePublicationTail(
  state: NeoPublicationState,
  page: Extract<PublicationRead, { state: 'ready' }>
): NeoPublicationState {
  return {
    ...state,
    status: 'ready',
    items: page.items,
    nextAfter: page.nextAfter,
    hasMore: false,
    hasEarlier: page.items.length === 50,
  };
}

export function prependPublicationWindow(
  state: NeoPublicationState,
  page: Extract<PublicationRead, { state: 'ready' }>
): NeoPublicationState {
  const all = [...page.items, ...state.items];
  const kept = all.slice(0, 500);
  return {
    ...state,
    status: 'ready',
    items: kept,
    nextAfter: all.length > 500 ? (kept.at(-1)?.sequence ?? 0) : state.nextAfter,
    hasMore: state.hasMore || all.length > 500,
    hasEarlier: page.items.length === 50,
  };
}

const placePublications = (name: string, place: typeof appendPublicationWindow) =>
  (superpipe({})(name) as PipelineAPI)
    .input(['state', 'response'])
    .pipe(admitPublicationUpdate, ['state', 'response'], 'result:page')
    .pipe(place, ['state', 'page'], 'page')
    .end('page') as (state: NeoPublicationState, response: PublicationRead) => NeoPublicationState;
const applyTail = placePublications('neo-publication-tail', placePublicationTail);
const applyEarlier = placePublications('neo-publication-earlier', prependPublicationWindow);

const applyPage = (superpipe({})('neo-publication-state') as PipelineAPI)
  .input(['state', 'response'])
  .pipe(admitPublicationUpdate, ['state', 'response'], 'result:page')
  .pipe(appendPublicationWindow, ['state', 'page'], 'page')
  .end('page') as (state: NeoPublicationState, response: PublicationRead) => NeoPublicationState;

export function useNeoPublications(rootSessionId: string | null) {
  const conversationId = publicationConversationId(rootSessionId);
  const root = useRef(conversationId);
  root.current = conversationId;
  const refresh = useRef(() => {});
  const earlier = useRef(() => {});
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<NeoPublicationState>(() => empty(conversationId));

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let pending = false;
    let value = empty(conversationId);
    let unsubscribe = () => {};
    let reconnect = () => {};
    const current = () => !disposed && root.current === conversationId;
    const publish = (next: NeoPublicationState) => {
      if (!current()) return;
      value = next;
      setState(next);
    };
    publish(value);
    refresh.current = () => {
      if (current()) setAttempt((number) => number + 1);
    };
    if (!conversationId)
      return () => {
        disposed = true;
      };

    void connectionManager
      .getHub()
      .then((hub) => {
        if (!current()) return;
        const update = async () => {
          if (!current()) return;
          if (inFlight) {
            pending = true;
            return;
          }
          inFlight = true;
          pending = false;
          const before = value;
          const tail = before.items.length === 0 && before.nextAfter === 0;
          publish({ ...value, status: 'loading' });
          const result = await readNeoPublications(
            tail
              ? { conversationId, after: 0, before: Number.MAX_SAFE_INTEGER, limit: 50 }
              : { conversationId, after: before.nextAfter, limit: 50 },
            async () => hub,
            current
          );
          if (!current()) return;
          publish((tail ? applyTail : applyPage)(before, result));
          inFlight = false;
          if (pending && value.status === 'ready') void update();
        };
        earlier.current = () => {
          const oldest = value.items[0]?.sequence;
          if (!current() || inFlight || !value.hasEarlier || !oldest) return;
          inFlight = true;
          const before = value;
          publish({ ...value, status: 'loading' });
          void readNeoPublications(
            { conversationId, after: 0, before: oldest, limit: 50 },
            async () => hub,
            current
          ).then((result) => {
            if (!current()) return;
            publish(applyEarlier(before, result));
            inFlight = false;
            if (pending && value.status === 'ready') void update();
          });
        };
        refresh.current = () => {
          void update();
        };
        unsubscribe = hub.onEvent('neo.changed', refresh.current);
        reconnect = hub.onConnection((connection) => {
          if (connection === 'connected') void update();
        });
        void update();
      })
      .catch(() => {
        publish({ ...value, status: 'unavailable' });
      });
    return () => {
      disposed = true;
      earlier.current = () => {};
      unsubscribe();
      reconnect();
    };
  }, [conversationId, attempt]);

  return {
    ...(state.conversationId === conversationId ? state : empty(conversationId)),
    refresh: () => refresh.current(),
    loadEarlier: () => earlier.current(),
  };
}
