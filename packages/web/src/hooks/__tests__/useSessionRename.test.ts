/**
 * Tests for useSessionRename Hook
 *
 * Covers: startEditing seeds the draft; commit calls updateSession with the
 * trimmed title + titleSetBy metadata and applies the optimistic store update;
 * empty/unchanged draft is a no-op; Esc cancels and restores; a failed commit
 * rolls back the optimistic update and surfaces a toast error.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';

// vi.hoisted so the mock factories (which vitest hoists above imports) can
// reference stable mock functions.
const mocks = vi.hoisted(() => ({
  updateSession: vi.fn(),
  globalStoreUpdate: vi.fn(),
  spaceStoreUpdate: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../lib/api-helpers', () => ({ updateSession: mocks.updateSession }));
vi.mock('../../lib/global-store', () => ({
  globalStore: { updateSession: mocks.globalStoreUpdate },
}));
vi.mock('../../lib/space-store', () => ({
  spaceStore: { updateSession: mocks.spaceStoreUpdate },
}));
vi.mock('../../lib/toast', () => ({ toast: { error: mocks.toastError } }));

import { useSessionRename } from '../useSessionRename';

// Lightweight synthetic-event builders (tests bypass strict Preact event types).
const inputEvent = (value: string) => ({ currentTarget: { value } }) as any;
const keyEvent = (key: string) =>
  ({ key, preventDefault: () => {}, stopPropagation: () => {} }) as any;

describe('useSessionRename', () => {
  beforeEach(() => {
    mocks.updateSession.mockReset();
    mocks.globalStoreUpdate.mockReset();
    mocks.spaceStoreUpdate.mockReset();
    mocks.toastError.mockReset();
    mocks.updateSession.mockResolvedValue(undefined);
  });

  it('starts inactive, and startEditing seeds the draft from the current title', () => {
    const { result } = renderHook(() => useSessionRename('session-1', 'Original'));

    expect(result.current.isEditing).toBe(false);

    act(() => {
      result.current.startEditing();
    });

    expect(result.current.isEditing).toBe(true);
    expect(result.current.inputProps.value).toBe('Original');
  });

  it('exposed commit is a no-op without an active edit, even after an external title change', async () => {
    // The draft is seeded at mount; a title arriving later (e.g. auto-title
    // generation) does NOT re-seed it. Hosts call commit() from panel-open
    // paths, so it must not persist that stale draft as a user rename.
    const { result, rerender } = renderHook(({ title }) => useSessionRename('session-1', title), {
      initialProps: { title: 'Original' },
    });
    rerender({ title: 'Auto Generated' });

    await act(async () => {
      result.current.commit();
    });

    expect(result.current.isEditing).toBe(false);
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.globalStoreUpdate).not.toHaveBeenCalled();
  });

  it('commits on Enter: optimistic store update + updateSession with title and metadata', async () => {
    const { result } = renderHook(() => useSessionRename('session-1', 'Original'));

    act(() => {
      result.current.startEditing();
    });
    act(() => {
      result.current.inputProps.onInput(inputEvent('New Title'));
    });

    await act(async () => {
      result.current.inputProps.onKeyDown(keyEvent('Enter'));
    });

    expect(result.current.isEditing).toBe(false);
    // Optimistic store update carries the new title only (metadata is merged on
    // the backend; the store shallow-merges and would drop counts otherwise).
    expect(mocks.globalStoreUpdate).toHaveBeenCalledWith('session-1', { title: 'New Title' });
    // Both stores update optimistically: chat rows read globalStore, space rows
    // read spaceStore (which is otherwise fed only by the LiveQuery).
    expect(mocks.spaceStoreUpdate).toHaveBeenCalledWith('session-1', { title: 'New Title' });
    expect(mocks.updateSession).toHaveBeenCalledWith('session-1', {
      title: 'New Title',
      metadata: { titleSetBy: 'user' },
    });
  });

  it('commits on blur', async () => {
    const { result } = renderHook(() => useSessionRename('session-1', 'Original'));

    act(() => {
      result.current.startEditing();
    });
    act(() => {
      result.current.inputProps.onInput(inputEvent('Blurred Title'));
    });

    await act(async () => {
      result.current.inputProps.onBlur({} as any);
    });

    expect(mocks.updateSession).toHaveBeenCalledWith('session-1', {
      title: 'Blurred Title',
      metadata: { titleSetBy: 'user' },
    });
  });

  it('trims whitespace before committing', async () => {
    const { result } = renderHook(() => useSessionRename('session-1', 'Original'));

    act(() => {
      result.current.startEditing();
    });
    act(() => {
      result.current.inputProps.onInput(inputEvent('  Spaced  '));
    });

    await act(async () => {
      result.current.inputProps.onKeyDown(keyEvent('Enter'));
    });

    expect(mocks.updateSession).toHaveBeenCalledWith('session-1', {
      title: 'Spaced',
      metadata: { titleSetBy: 'user' },
    });
  });

  it('does not call updateSession when the title is unchanged', async () => {
    const { result } = renderHook(() => useSessionRename('session-1', 'Original'));

    act(() => {
      result.current.startEditing();
    });
    // Leave the draft as the current title.
    await act(async () => {
      result.current.inputProps.onKeyDown(keyEvent('Enter'));
    });

    expect(result.current.isEditing).toBe(false);
    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.globalStoreUpdate).not.toHaveBeenCalled();
  });

  it('does not call updateSession when the title is empty/whitespace', async () => {
    const { result } = renderHook(() => useSessionRename('session-1', 'Original'));

    act(() => {
      result.current.startEditing();
    });
    act(() => {
      result.current.inputProps.onInput(inputEvent('   '));
    });

    await act(async () => {
      result.current.inputProps.onKeyDown(keyEvent('Enter'));
    });

    expect(mocks.updateSession).not.toHaveBeenCalled();
    expect(mocks.globalStoreUpdate).not.toHaveBeenCalled();
  });

  it('Esc cancels, restores the draft, and does not commit', async () => {
    const { result } = renderHook(() => useSessionRename('session-1', 'Original'));

    act(() => {
      result.current.startEditing();
    });
    act(() => {
      result.current.inputProps.onInput(inputEvent('Discarded'));
    });

    await act(async () => {
      result.current.inputProps.onKeyDown(keyEvent('Escape'));
    });

    expect(result.current.isEditing).toBe(false);
    expect(result.current.inputProps.value).toBe('Original');
    expect(mocks.updateSession).not.toHaveBeenCalled();
  });

  it('rolls back the optimistic update and toasts on commit failure', async () => {
    mocks.updateSession.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useSessionRename('session-1', 'Original'));

    act(() => {
      result.current.startEditing();
    });
    act(() => {
      result.current.inputProps.onInput(inputEvent('New Title'));
    });

    await act(async () => {
      result.current.inputProps.onKeyDown(keyEvent('Enter'));
    });

    expect(result.current.isEditing).toBe(false);
    // Optimistic write, then rollback to the original title — in both stores.
    expect(mocks.globalStoreUpdate).toHaveBeenNthCalledWith(1, 'session-1', {
      title: 'New Title',
    });
    expect(mocks.globalStoreUpdate).toHaveBeenNthCalledWith(2, 'session-1', {
      title: 'Original',
    });
    expect(mocks.spaceStoreUpdate).toHaveBeenNthCalledWith(1, 'session-1', {
      title: 'New Title',
    });
    expect(mocks.spaceStoreUpdate).toHaveBeenNthCalledWith(2, 'session-1', {
      title: 'Original',
    });
    expect(mocks.toastError).toHaveBeenCalledWith('Failed to rename');
  });
});
