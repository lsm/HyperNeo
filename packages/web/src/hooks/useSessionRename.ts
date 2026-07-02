/**
 * useSessionRename Hook
 *
 * Inline-rename state + optimistic commit pipeline for a session title. Centralizes
 * the edit affordance shared by every session-list surface (chat sidebar + the 3
 * space session rows) so each can edit a title in place without threading a rename
 * callback through its parent. Mirrors the optimistic-update + rollback + toast
 * pattern used elsewhere (e.g. auto-scroll toggle).
 *
 * While `isEditing`, render `<input {...inputProps} />` in place of the row; the
 * row's click-to-open is implicitly suppressed because the input replaces the
 * clickable element.
 *
 * @example
 * ```tsx
 * const { isEditing, startEditing, inputProps } = useSessionRename(session.id, session.title);
 * return isEditing ? (
 *   <input {...inputProps} />
 * ) : (
 *   <button onDblClick={startEditing}>{session.title}</button>
 * );
 * ```
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { JSX } from 'preact';
import { globalStore } from '../lib/global-store';
import { spaceStore } from '../lib/space-store';
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
  /** Seed the draft from the current title and enter edit mode. */
  startEditing: () => void;
  /** Spread onto the `<input>` rendered while editing. */
  inputProps: SessionRenameInputProps;
}

/**
 * Hook for managing inline session-title rename.
 *
 * @param sessionId - Session being renamed.
 * @param currentTitle - Latest known title for the session (drives skip/rollback).
 */
export function useSessionRename(sessionId: string, currentTitle: string): UseSessionRenameResult {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(currentTitle);
  const inputElRef = useRef<HTMLInputElement | null>(null);
  // Guards against double-commit when Enter/Esc unmount the input and a blur
  // event follows in the same edit cycle.
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
    // Empty or unchanged → no-op (treat as cancel).
    if (!trimmed || trimmed === currentTitle) return;

    // Optimistic title update first so the list reflects the new title immediately.
    // Title only — globalStore.updateSession shallow-merges, so partial metadata
    // here would wipe token/cost counts. The titleSetBy guardrail flag is applied
    // by the backend call below (and persisted via its merged metadata write).
    // Update both stores: chat rows read globalStore, space rows read spaceStore.
    globalStore.updateSession(sessionId, { title: trimmed });
    spaceStore.updateSession(sessionId, { title: trimmed });
    try {
      await updateSession(sessionId, { title: trimmed, metadata: { titleSetBy: 'user' } });
    } catch {
      // Roll back to the prior title and surface the failure.
      globalStore.updateSession(sessionId, { title: currentTitle });
      spaceStore.updateSession(sessionId, { title: currentTitle });
      toast.error('Failed to rename');
    }
  }, [draft, currentTitle, sessionId]);

  // Focus the input when entering edit mode; focus triggers onFocus → select-all.
  useEffect(() => {
    if (isEditing) inputElRef.current?.focus();
  }, [isEditing]);

  return {
    isEditing,
    startEditing,
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
          cancel();
        }
      },
      onFocus: (e: JSX.TargetedEvent<HTMLInputElement>) => e.currentTarget.select(),
    },
  };
}
