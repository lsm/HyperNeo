import { useEffect, useRef } from 'preact/hooks';
import { connectionManager } from '../lib/connection-manager.ts';
import { connectionState } from '../lib/state.ts';

export function useNeoVoiceRecovery(
  sessionId: string | null,
  draftValue: string,
  readDraft: () => string,
  writeDraft: (text: string) => void
): void {
  const readRef = useRef(readDraft);
  readRef.current = readDraft;
  const writeRef = useRef(writeDraft);
  writeRef.current = writeDraft;
  const adoptedRef = useRef<{ sessionId: string; draft: string } | null>(null);
  const ownerRef = useRef(sessionId);
  if (ownerRef.current !== sessionId) {
    ownerRef.current = sessionId;
    adoptedRef.current = null;
  }

  const clearDaemonDraft = (): Promise<void> => {
    const adopted = adoptedRef.current;
    if (!sessionId || !adopted || adopted.sessionId !== sessionId) return Promise.resolve();
    if (readRef.current().trim() !== '') return Promise.resolve();
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return Promise.resolve();
    return hub
      .request<{ cleared?: boolean }>('session.clearInputDraftIf', {
        sessionId,
        expected: adopted.draft,
      })
      .then((result) => {
        if (result?.cleared !== false && adoptedRef.current === adopted) adoptedRef.current = null;
      })
      .catch(() => {});
  };

  useEffect(() => {
    const adopted = adoptedRef.current;
    if (!sessionId || !adopted || adopted.sessionId !== sessionId) return;
    if (draftValue.trim() !== '') return;
    void clearDaemonDraft();
  }, [draftValue, sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let unsubEvent: (() => void) | null = null;

    const adopt = async (): Promise<void> => {
      const hub = connectionManager.getHubIfConnected();
      if (!hub) return;
      try {
        const response = await hub.request<{ session?: { metadata?: { inputDraft?: string } } }>(
          'session.get',
          { sessionId }
        );
        if (cancelled) return;
        const composed = (response.session?.metadata?.inputDraft ?? '').trim();
        if (!composed) return;
        const adopted = adoptedRef.current;
        if (adopted && adopted.sessionId === sessionId && adopted.draft === composed) return;
        if (readRef.current().trim() !== '') return;
        adoptedRef.current = { sessionId, draft: composed };
        writeRef.current(composed);
        await hub.request('session.update', {
          sessionId,
          metadata: { inputDraft: composed },
        });
      } catch {
        return;
      }
    };

    const register = (): void => {
      if (unsubEvent) return;
      const hub = connectionManager.getHubIfConnected();
      if (!hub) return;
      unsubEvent = hub.onEvent(
        'session.voiceLanded',
        (data: { sessionId?: string }, context?: { channel?: string }) => {
          if (context?.channel !== `session:${sessionId}`) return;
          void adopt();
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
      void adopt();
      void clearDaemonDraft();
    });
    void adopt();

    return () => {
      cancelled = true;
      unsubscribeConnection();
      if (unsubEvent) unsubEvent();
    };
  }, [sessionId]);
}
