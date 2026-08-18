import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';

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
    expect(mocks.globalStoreUpdate).toHaveBeenCalledWith('session-1', { title: 'New Title' });
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
