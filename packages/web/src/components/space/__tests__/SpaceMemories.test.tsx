import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { AgentMemoryEntry } from '@hyperneo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mockMemories: ReturnType<typeof signal<AgentMemoryEntry[]>>;
let mockLoading: ReturnType<typeof signal<boolean>>;
let mockLoaded: ReturnType<typeof signal<boolean>>;
let mockError: ReturnType<typeof signal<string | null>>;
let mockQuery: ReturnType<typeof signal<string>>;
let mockHasMore: ReturnType<typeof signal<boolean>>;
let mockIsLoadingMore: ReturnType<typeof signal<boolean>>;
const mockAttach = vi.fn();
const mockDetach = vi.fn();
const mockSearch = vi.fn();
const mockWrite = vi.fn();
const mockDeleteMemory = vi.fn();
const mockReload = vi.fn();
const mockLoadMore = vi.fn();
const mockExists = vi.fn();
const mockCreate = vi.fn();

vi.mock('../../../lib/memory-store', () => ({
  get memoryStore() {
    return {
      memories: mockMemories,
      isLoading: mockLoading,
      loaded: mockLoaded,
      error: mockError,
      query: mockQuery,
      hasMore: mockHasMore,
      isLoadingMore: mockIsLoadingMore,
      attach: mockAttach,
      detach: mockDetach,
      search: mockSearch,
      write: mockWrite,
      create: mockCreate,
      deleteMemory: mockDeleteMemory,
      reload: mockReload,
      loadMore: mockLoadMore,
      exists: mockExists,
    };
  },
}));

vi.mock('../../../lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

mockMemories = signal<AgentMemoryEntry[]>([]);
mockLoading = signal(false);
mockLoaded = signal(true);
mockError = signal(null);
mockQuery = signal('');
mockHasMore = signal(false);
mockIsLoadingMore = signal(false);

import { SpaceMemories } from '../SpaceMemories';

function makeMemory(key: string, overrides: Partial<AgentMemoryEntry> = {}): AgentMemoryEntry {
  return {
    key,
    spaceId: 'space-1',
    content: `Content for ${key}`,
    tags: [],
    createdBySession: null,
    createdAt: 1000,
    updatedAt: 2000,
    accessCount: 0,
    lastAccessedAt: null,
    ...overrides,
  };
}

describe('SpaceMemories', () => {
  beforeEach(() => {
    cleanup();
    mockMemories.value = [];
    mockLoading.value = false;
    mockLoaded.value = true;
    mockError.value = null;
    mockQuery.value = '';
    mockHasMore.value = false;
    mockIsLoadingMore.value = false;
    mockAttach.mockReset();
    mockDetach.mockReset();
    mockSearch.mockReset();
    mockWrite.mockReset();
    mockDeleteMemory.mockReset();
    mockReload.mockReset();
    mockLoadMore.mockReset();
    mockExists.mockReset();
    mockCreate.mockReset();
    mockAttach.mockResolvedValue(undefined);
    mockLoadMore.mockResolvedValue(undefined);
    mockExists.mockResolvedValue(false);
    mockCreate.mockResolvedValue(makeMemory('whatever'));
    mockSearch.mockResolvedValue(undefined);
    mockReload.mockResolvedValue(undefined);
    mockWrite.mockResolvedValue(makeMemory('whatever'));
    mockDeleteMemory.mockResolvedValue(true);
  });

  afterEach(() => {
    cleanup();
  });

  it('attaches on mount and detaches on unmount', () => {
    const { unmount } = render(<SpaceMemories spaceId="space-1" />);

    expect(mockAttach).toHaveBeenCalledWith('space-1');
    unmount();
    expect(mockDetach).toHaveBeenCalled();
  });

  it('re-attaches when the space changes', () => {
    const { rerender } = render(<SpaceMemories spaceId="space-1" />);

    rerender(<SpaceMemories spaceId="space-2" />);
    expect(mockAttach).toHaveBeenCalledWith('space-2');
  });

  it('renders a loading state before the first load returns', () => {
    mockLoading.value = true;
    mockLoaded.value = false;

    render(<SpaceMemories spaceId="space-1" />);

    expect(screen.getByText('Loading memories...')).toBeTruthy();
  });

  it('does not flash the empty state before the first load returns', () => {
    mockLoading.value = false;
    mockLoaded.value = false;

    render(<SpaceMemories spaceId="space-1" />);

    expect(screen.getByText('Loading memories...')).toBeTruthy();
    expect(screen.queryByText('No memories stored yet.')).toBeNull();
  });

  it('renders the header with a stored count', () => {
    mockMemories.value = [makeMemory('alpha'), makeMemory('beta')];

    render(<SpaceMemories spaceId="space-1" />);

    expect(screen.getByText('Memories · 2 stored')).toBeTruthy();
    expect(screen.getByTestId('memory-create-button')).toBeTruthy();
    expect(screen.getByTestId('space-memories-introduction')).toBeTruthy();
  });

  it('renders a result count while a search is active', () => {
    mockMemories.value = [makeMemory('alpha')];
    mockQuery.value = 'alpha';

    render(<SpaceMemories spaceId="space-1" />);

    expect(screen.getByText('Memories · 1 results')).toBeTruthy();
  });

  it('lists stored memories', () => {
    mockMemories.value = [makeMemory('alpha', { content: 'Alpha content', tags: ['convention'] })];

    render(<SpaceMemories spaceId="space-1" />);

    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('Alpha content')).toBeTruthy();
    expect(screen.getByText('convention')).toBeTruthy();
  });

  it('shows an empty state when there are no memories', () => {
    render(<SpaceMemories spaceId="space-1" />);

    expect(screen.getByText('No memories stored yet.')).toBeTruthy();
  });

  it('shows a no-match state while searching with empty results', () => {
    mockMemories.value = [];

    render(<SpaceMemories spaceId="space-1" />);
    fireEvent.input(screen.getByTestId('memory-search-input'), { target: { value: 'xyz' } });

    expect(screen.getByText('No memories match "xyz".')).toBeTruthy();
  });

  it('debounces typed queries to the store search', async () => {
    render(<SpaceMemories spaceId="space-1" />);

    fireEvent.input(screen.getByTestId('memory-search-input'), {
      target: { value: 'convention' },
    });
    expect(mockSearch).not.toHaveBeenCalled();

    await waitFor(() => expect(mockSearch).toHaveBeenCalledWith('convention'));
  });

  it('creates a memory through the editor', async () => {
    render(<SpaceMemories spaceId="space-1" />);

    fireEvent.click(screen.getByTestId('memory-create-button'));
    const keyInput = await screen.findByTestId('memory-key-input');
    fireEvent.input(keyInput, { target: { value: 'new-key' } });
    fireEvent.input(screen.getByTestId('memory-content-input'), {
      target: { value: 'A useful fact.' },
    });
    fireEvent.input(screen.getByTestId('memory-tags-input'), {
      target: { value: 'project, feedback' },
    });
    fireEvent.click(screen.getByTestId('memory-save-button'));

    await waitFor(() =>
      expect(mockCreate).toHaveBeenCalledWith({
        key: 'new-key',
        content: 'A useful fact.',
        tags: ['project', 'feedback'],
      })
    );
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('surfaces an atomic create conflict as an error', async () => {
    mockCreate.mockRejectedValue(new Error('A memory with the key "sneaky" already exists.'));

    render(<SpaceMemories spaceId="space-1" />);
    fireEvent.click(screen.getByTestId('memory-create-button'));
    const keyInput = await screen.findByTestId('memory-key-input');
    fireEvent.input(keyInput, { target: { value: 'sneaky' } });
    fireEvent.input(screen.getByTestId('memory-content-input'), { target: { value: 'Body.' } });
    fireEvent.click(screen.getByTestId('memory-save-button'));

    await waitFor(() =>
      expect(screen.getByTestId('memory-editor-error').textContent).toContain('already exists')
    );
  });

  it('does not close a newly-opened editor when a stale save resolves after a space switch', async () => {
    const { rerender } = render(<SpaceMemories spaceId="space-1" />);

    let resolveStaleSave!: (entry: AgentMemoryEntry) => void;
    mockCreate.mockImplementation(
      () =>
        new Promise<AgentMemoryEntry>((resolve) => {
          resolveStaleSave = resolve;
        })
    );
    fireEvent.click(screen.getByTestId('memory-create-button'));
    const keyInputA = await screen.findByTestId('memory-key-input');
    fireEvent.input(keyInputA, { target: { value: 'a-key' } });
    fireEvent.input(screen.getByTestId('memory-content-input'), { target: { value: 'A body.' } });
    fireEvent.click(screen.getByTestId('memory-save-button'));

    mockCreate.mockResolvedValue(makeMemory('whatever'));
    rerender(<SpaceMemories spaceId="space-2" />);
    await waitFor(() => expect(screen.queryByTestId('memory-key-input')).toBeNull());

    fireEvent.click(screen.getByTestId('memory-create-button'));
    const keyInputB = await screen.findByTestId('memory-key-input');
    fireEvent.input(keyInputB, { target: { value: 'b-key' } });

    resolveStaleSave(makeMemory('a-key'));
    await waitFor(() =>
      expect((screen.getByTestId('memory-key-input') as HTMLInputElement).value).toBe('b-key')
    );
  });

  it('blocks create when the key already exists', async () => {
    mockMemories.value = [makeMemory('alpha')];

    render(<SpaceMemories spaceId="space-1" />);
    fireEvent.click(screen.getByTestId('memory-create-button'));
    const keyInput = await screen.findByTestId('memory-key-input');
    fireEvent.input(keyInput, { target: { value: 'alpha' } });
    fireEvent.input(screen.getByTestId('memory-content-input'), { target: { value: 'Body.' } });

    expect(await screen.findByTestId('memory-duplicate-key-warning')).toBeTruthy();
    fireEvent.click(screen.getByTestId('memory-save-button'));

    await waitFor(() => expect(screen.getByTestId('memory-editor-error')).toBeTruthy());
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('flags a duplicate found via the authoritative (read-only) check', async () => {
    mockExists.mockResolvedValue(true);

    render(<SpaceMemories spaceId="space-1" />);
    fireEvent.click(screen.getByTestId('memory-create-button'));
    const keyInput = await screen.findByTestId('memory-key-input');
    fireEvent.input(keyInput, { target: { value: 'hidden-key' } });

    expect(await screen.findByTestId('memory-duplicate-key-warning')).toBeTruthy();
    expect(mockExists).toHaveBeenCalledWith('hidden-key');
  });

  it('rejects tag lists exceeding the 50-tag limit', async () => {
    render(<SpaceMemories spaceId="space-1" />);
    fireEvent.click(screen.getByTestId('memory-create-button'));
    const keyInput = await screen.findByTestId('memory-key-input');
    fireEvent.input(keyInput, { target: { value: 'many-tags' } });
    fireEvent.input(screen.getByTestId('memory-content-input'), { target: { value: 'Body.' } });
    const manyTags = Array.from({ length: 51 }, (_, i) => `t${i}`).join(', ');
    fireEvent.input(screen.getByTestId('memory-tags-input'), { target: { value: manyTags } });
    fireEvent.click(screen.getByTestId('memory-save-button'));

    await waitFor(() =>
      expect(screen.getByTestId('memory-editor-error').textContent).toContain('at most 50 tags')
    );
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('offers load-more when a full page is available', () => {
    mockMemories.value = [makeMemory('alpha')];
    mockHasMore.value = true;

    render(<SpaceMemories spaceId="space-1" />);

    const loadMore = screen.getByTestId('memory-load-more');
    fireEvent.click(loadMore);
    expect(mockLoadMore).toHaveBeenCalled();
  });

  it('blocks create when required fields are empty', async () => {
    render(<SpaceMemories spaceId="space-1" />);

    fireEvent.click(screen.getByTestId('memory-create-button'));
    await screen.findByTestId('memory-key-input');
    fireEvent.click(screen.getByTestId('memory-save-button'));

    expect(screen.getByTestId('memory-editor-error')).toBeTruthy();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('edits an existing memory with a locked key, preserving unchanged tags', async () => {
    mockMemories.value = [makeMemory('alpha', { content: 'old body', tags: ['x,y'] })];

    render(<SpaceMemories spaceId="space-1" />);
    fireEvent.click(screen.getByTestId('memory-edit-alpha'));

    const keyInput = await screen.findByTestId('memory-key-input');
    expect((keyInput as HTMLInputElement).disabled).toBe(true);
    fireEvent.input(screen.getByTestId('memory-content-input'), {
      target: { value: 'updated body' },
    });
    fireEvent.click(screen.getByTestId('memory-save-button'));

    await waitFor(() =>
      expect(mockWrite).toHaveBeenCalledWith({
        key: 'alpha',
        content: 'updated body',
        tags: undefined,
      })
    );
  });

  it('resends parsed tags when the user edits them', async () => {
    mockMemories.value = [makeMemory('alpha', { content: 'old body', tags: ['old'] })];

    render(<SpaceMemories spaceId="space-1" />);
    fireEvent.click(screen.getByTestId('memory-edit-alpha'));
    await screen.findByTestId('memory-key-input');
    fireEvent.input(screen.getByTestId('memory-tags-input'), {
      target: { value: 'new1, new2' },
    });
    fireEvent.click(screen.getByTestId('memory-save-button'));

    await waitFor(() =>
      expect(mockWrite).toHaveBeenCalledWith({
        key: 'alpha',
        content: 'old body',
        tags: ['new1', 'new2'],
      })
    );
  });

  it('confirms before deleting a memory', async () => {
    mockMemories.value = [makeMemory('alpha')];

    render(<SpaceMemories spaceId="space-1" />);
    fireEvent.click(screen.getByTestId('memory-delete-alpha'));

    expect(mockDeleteMemory).not.toHaveBeenCalled();
    expect(screen.getByText('Delete Memory')).toBeTruthy();

    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => expect(mockDeleteMemory).toHaveBeenCalledWith('alpha'));
  });

  it('does not close a newly-opened delete modal when a stale delete resolves after a space switch', async () => {
    mockMemories.value = [makeMemory('x')];
    const { rerender } = render(<SpaceMemories spaceId="space-A" />);

    let resolveStaleDelete!: (result: { deleted: boolean }) => void;
    mockDeleteMemory.mockImplementation(
      () =>
        new Promise<{ deleted: boolean }>((resolve) => {
          resolveStaleDelete = resolve;
        })
    );
    fireEvent.click(screen.getByTestId('memory-delete-x'));
    fireEvent.click(screen.getByText('Delete'));

    mockMemories.value = [makeMemory('y')];
    mockDeleteMemory.mockResolvedValue(true);
    rerender(<SpaceMemories spaceId="space-B" />);
    await waitFor(() => expect(screen.queryByText('Delete Memory')).toBeNull());

    fireEvent.click(screen.getByTestId('memory-delete-y'));
    expect(screen.getByText('Delete Memory')).toBeTruthy();

    resolveStaleDelete({ deleted: true });
    await waitFor(() => expect(screen.getByText('Delete Memory')).toBeTruthy());
  });

  it('surfaces a retry control when loading fails', () => {
    mockError.value = 'Failed to load memories';

    render(<SpaceMemories spaceId="space-1" />);

    expect(screen.getByText('Failed to load memories')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry'));
    expect(mockReload).toHaveBeenCalled();
  });
});
