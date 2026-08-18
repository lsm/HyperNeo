import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { globalStore } from '../lib/global-store';
import { spaceStore } from '../lib/space-store';
import { applyOptimisticSessionInfo } from '../lib/session-store';
import { updateSession } from '../lib/api-helpers';
import { toast } from '../lib/toast';

export interface SessionRenameInputProps {
  ref: (el: HTMLInputElement | null) => void;
  value: string;
  onInput: (e: JSX.TargetedEvent<HTMLInputElement>) => void;
  onBlur: (e: JSX.TargetedEvent<HTMLInputElement>) => void;
  onKeyDown: (e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => void;
  onFocus: (e: JSX.TargetedEvent<HTMLInputElement>) => void;
}

export interface UseSessionRenameResult {
  isEditing: boolean;
  startEditing: () => void;
  commit: () => void;
  inputProps: SessionRenameInputProps;
}

export function useSessionRename(sessionId: string, currentTitle: string): UseSessionRenameResult {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(currentTitle);
  const inputElRef = useRef<HTMLInputElement | null>(null);
  const settledRef = useRef(false);

  const startEditing = useCallback(() => {
    setDraft(currentTitle);
    settledRef.current = false;
    setIsEditing(true);
  }, [currentTitle]);

  const cancel = useCallback(() => {
    if (settledRef.current) return;
    settledRef.current = true;
    setDraft(currentTitle);
    setIsEditing(false);
  }, [currentTitle]);

  const commit = useCallback(async () => {
    if (settledRef.current) return;
    settledRef.current = true;
    setIsEditing(false);

    const trimmed = draft.trim();
    if (!trimmed || trimmed === currentTitle) return;

    globalStore.updateSession(sessionId, { title: trimmed });
    spaceStore.updateSession(sessionId, { title: trimmed });
    applyOptimisticSessionInfo(sessionId, { title: trimmed });
    try {
      await updateSession(sessionId, { title: trimmed, metadata: { titleSetBy: 'user' } });
    } catch {
      globalStore.updateSession(sessionId, { title: currentTitle });
      spaceStore.updateSession(sessionId, { title: currentTitle });
      applyOptimisticSessionInfo(sessionId, { title: currentTitle }, trimmed);
      toast.error('Failed to rename');
    }
  }, [draft, currentTitle, sessionId]);

  useEffect(() => {
    if (isEditing) inputElRef.current?.focus();
  }, [isEditing]);

  return {
    isEditing,
    startEditing,
    commit: () => {
      if (!isEditing) return;
      void commit();
    },
    inputProps: {
      ref: (el: HTMLInputElement | null) => {
        inputElRef.current = el;
      },
      value: draft,
      onInput: (e: JSX.TargetedEvent<HTMLInputElement>) => setDraft(e.currentTarget.value),
      onBlur: () => void commit(),
      onKeyDown: (e: JSX.TargetedKeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          void commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          cancel();
        }
      },
      onFocus: (e: JSX.TargetedEvent<HTMLInputElement>) => e.currentTarget.select(),
    },
  };
}
