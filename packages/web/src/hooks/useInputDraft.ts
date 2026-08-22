import { useEffect, useRef, useCallback, useMemo } from 'preact/hooks';
import { useSignal, useSignalEffect } from '@preact/signals';
import { connectionManager } from '../lib/connection-manager';
import { connectionState } from '../lib/state';

export interface UseInputDraftResult {
  content: string;
  setContent: (content: string) => void;
  clear: () => void;
  holdDraftAdoption: <T>(fn: () => Promise<T>) => Promise<T>;
}

export function useInputDraft(sessionId: string, debounceMs = 250): UseInputDraftResult {
  const contentSignal = useSignal('');
  const draftSaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevSessionIdRef = useRef<string | null>(null);
  const currentSessionIdRef = useRef(sessionId);
  const initialLoadSettledRef = useRef<string | null>(null);
  const lastSeenContentRef = useRef<{
    sessionId: string | null;
    content: string;
    cleared?: boolean;
  }>({ sessionId: null, content: '' });
  const lastNonEmptyContentRef = useRef<{ sessionId: string | null; content: string }>({
    sessionId: null,
    content: '',
  });
  const lastLoadedDraftRef = useRef<string>('');
  const deferredVoiceAdoptRef = useRef<string | null>(null);
  const submissionHoldsRef = useRef(0);
  const loadRequestSeqRef = useRef(0);

  const loadDraft = useCallback(
    (
      targetSessionId: string,
      isCancelled: () => boolean,
      onResult?: (ok: boolean, applied?: boolean, draft?: string, voicePending?: string) => void,
      applyGuard?: () => boolean
    ): void => {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) {
        onResult?.(false);
        return;
      }
      const requestSeq = ++loadRequestSeqRef.current;
      hub
        .request<{
          session?: { metadata?: { inputDraft?: string; inputDraftVoicePending?: string } };
        }>('session.get', {
          sessionId: targetSessionId,
        })
        .then((response) => {
          if (isCancelled()) return;
          const draft = response.session?.metadata?.inputDraft ?? '';
          const applied =
            (applyGuard ? applyGuard() : true) && loadRequestSeqRef.current === requestSeq;
          if (applied) {
            contentSignal.value = draft;
            lastLoadedDraftRef.current = draft;
            if (draft.trim() !== '') {
              lastNonEmptyContentRef.current = { sessionId: targetSessionId, content: draft };
            }
          }
          onResult?.(
            true,
            applied,
            draft,
            response.session?.metadata?.inputDraftVoicePending ?? ''
          );
        })
        .catch(() => {
          if (isCancelled()) return;
          onResult?.(false);
        });
    },
    [contentSignal]
  );

  const issueAdoptionRefresh = useCallback(
    (targetSessionId: string): void => {
      if (submissionHoldsRef.current > 0) {
        deferredVoiceAdoptRef.current = targetSessionId;
        return;
      }
      const adoptable = (): boolean => {
        const current = contentSignal.peek();
        return current === '' || current === lastLoadedDraftRef.current;
      };
      if (!adoptable()) {
        deferredVoiceAdoptRef.current = targetSessionId;
        return;
      }
      loadDraft(
        targetSessionId,
        () => currentSessionIdRef.current !== targetSessionId,
        (ok, applied, draft, voicePending) => {
          if (currentSessionIdRef.current !== targetSessionId) return;
          if (!ok || !applied) {
            deferredVoiceAdoptRef.current = targetSessionId;
            return;
          }
          deferredVoiceAdoptRef.current = null;
          if (!draft) return;
          const pendingTrimmed = (voicePending ?? '').trim();
          if (pendingTrimmed !== '' && !draft.includes(pendingTrimmed)) {
            deferredVoiceAdoptRef.current = targetSessionId;
            return;
          }
          lastSeenContentRef.current = { sessionId: targetSessionId, content: draft };
          if (draftSaveTimeoutRef.current) {
            clearTimeout(draftSaveTimeoutRef.current);
            draftSaveTimeoutRef.current = null;
          }
          const hubNow = connectionManager.getHubIfConnected();
          if (!hubNow) {
            deferredVoiceAdoptRef.current = targetSessionId;
            return;
          }
          hubNow
            .request('session.update', {
              sessionId: targetSessionId,
              metadata: { inputDraft: draft },
            })
            .catch(() => {
              deferredVoiceAdoptRef.current = targetSessionId;
            });
        },
        adoptable
      );
    },
    [contentSignal, loadDraft]
  );

  const holdDraftAdoption = useCallback(
    async <T>(fn: () => Promise<T>): Promise<T> => {
      submissionHoldsRef.current += 1;
      try {
        return await fn();
      } finally {
        submissionHoldsRef.current -= 1;
        if (submissionHoldsRef.current === 0) {
          const live = currentSessionIdRef.current;
          if (live && deferredVoiceAdoptRef.current === live && contentSignal.peek() === '') {
            deferredVoiceAdoptRef.current = null;
            issueAdoptionRefresh(live);
          }
        }
      }
    },
    [contentSignal, issueAdoptionRefresh]
  );

  useEffect(() => {
    if (!sessionId) {
      contentSignal.value = '';
      return;
    }

    initialLoadSettledRef.current = null;
    currentSessionIdRef.current = sessionId;

    contentSignal.value = '';
    lastLoadedDraftRef.current = '';

    let cancelled = false;
    const adoptable = (): boolean => {
      const current = contentSignal.peek();
      return current === '' || current === lastLoadedDraftRef.current;
    };
    loadDraft(
      sessionId,
      () => cancelled,
      (_ok, applied, draft, voicePending) => {
        if (cancelled) return;
        const pendingTrimmed = (voicePending ?? '').trim();
        if (!applied) {
          if (pendingTrimmed !== '') {
            deferredVoiceAdoptRef.current = sessionId;
          }
          return;
        }
        initialLoadSettledRef.current = sessionId;
        if (pendingTrimmed !== '' && draft && !draft.includes(pendingTrimmed)) {
          deferredVoiceAdoptRef.current = sessionId;
        }
      },
      adoptable
    );
    return () => {
      cancelled = true;
    };
  }, [sessionId, contentSignal, loadDraft]);

  useEffect(() => {
    if (!sessionId) return;
    let unsubEvent: (() => void) | null = null;
    const register = (): void => {
      if (unsubEvent) return;
      const hub = connectionManager.getHubIfConnected();
      if (!hub) return;
      unsubEvent = hub.onEvent(
        'session.voiceLanded',
        (data: { sessionId?: string }, context?: { channel?: string }) => {
          if (context?.channel !== `session:${sessionId}`) return;
          if (currentSessionIdRef.current !== sessionId) return;
          issueAdoptionRefresh(sessionId);
        }
      );
    };
    register();
    const unsubscribeConnection = connectionState.subscribe(() => {
      if (unsubEvent) {
        unsubEvent();
        unsubEvent = null;
      }
      register();
      if (deferredVoiceAdoptRef.current === sessionId) {
        deferredVoiceAdoptRef.current = null;
        issueAdoptionRefresh(sessionId);
      }
    });
    return () => {
      unsubscribeConnection();
      if (unsubEvent) unsubEvent();
    };
  }, [sessionId, issueAdoptionRefresh]);

  useSignalEffect(() => {
    const content = contentSignal.value;

    if (!sessionId) return;
    if (draftSaveTimeoutRef.current) {
      clearTimeout(draftSaveTimeoutRef.current);
      draftSaveTimeoutRef.current = null;
    }
    if (prevSessionIdRef.current && prevSessionIdRef.current !== sessionId) {
      const prevSessionId = prevSessionIdRef.current;
      const last = lastSeenContentRef.current;
      const flushContent = last.sessionId === prevSessionId ? last.content.trim() : '';
      const wasCleared = last.sessionId === prevSessionId && !!last.cleared;
      prevSessionIdRef.current = sessionId;
      if (!flushContent && !wasCleared) return;
      const hub = connectionManager.getHubIfConnected();
      if (!hub) return;
      hub
        .request('session.update', {
          sessionId: prevSessionId,
          metadata: {
            inputDraft: flushContent || null,
          },
        })
        .catch(() => {});
      return;
    }
    prevSessionIdRef.current = sessionId;

    const trimmedContent = content.trim();

    if (trimmedContent === '') {
      if (initialLoadSettledRef.current !== sessionId) return;
      lastSeenContentRef.current = { sessionId, content: '', cleared: true };
      const hub = connectionManager.getHubIfConnected();
      if (hub) {
        const settleCleared = (): void => {
          if (lastSeenContentRef.current.sessionId === sessionId) {
            lastSeenContentRef.current = { sessionId, content: '' };
          }
        };
        const clearTyping = (): void => {
          hub
            .request('session.update', {
              sessionId,
              metadata: {
                inputDraft: null,
              },
            })
            .then(settleCleared)
            .catch(() => {});
        };
        const prior = lastNonEmptyContentRef.current;
        if (prior && prior.sessionId === sessionId && prior.content.trim() !== '') {
          hub
            .request<{ cleared?: boolean }>('session.clearInputDraftIf', {
              sessionId,
              expected: prior.content,
            })
            .then((res) => {
              if (res?.cleared) {
                settleCleared();
                return;
              }
              clearTyping();
            })
            .catch(() => {
              clearTyping();
            });
        } else {
          clearTyping();
        }
      }
      if (deferredVoiceAdoptRef.current === sessionId) {
        deferredVoiceAdoptRef.current = null;
        issueAdoptionRefresh(sessionId);
      }
      return;
    }

    initialLoadSettledRef.current = sessionId;
    lastSeenContentRef.current = { sessionId, content };
    lastNonEmptyContentRef.current = { sessionId, content };
    draftSaveTimeoutRef.current = setTimeout(async () => {
      if (contentSignal.peek() !== content) return;
      const hub = connectionManager.getHubIfConnected();
      if (!hub) return;

      try {
        await hub.request('session.update', {
          sessionId,
          metadata: {
            inputDraft: trimmedContent,
          },
        });
      } catch {}
    }, debounceMs);

    return () => {
      if (draftSaveTimeoutRef.current) {
        clearTimeout(draftSaveTimeoutRef.current);
        draftSaveTimeoutRef.current = null;
      }
    };
  });

  const setContent = useCallback(
    (newContent: string) => {
      contentSignal.value = newContent;
    },
    [contentSignal]
  );

  const clear = useCallback(() => {
    contentSignal.value = '';
  }, [contentSignal]);

  return useMemo(
    () => ({
      get content() {
        return contentSignal.value;
      },
      setContent,
      clear,
      holdDraftAdoption,
    }),
    [contentSignal, setContent, clear, holdDraftAdoption]
  );
}
