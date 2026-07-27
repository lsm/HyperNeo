import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { signal } from '@preact/signals';
import type { AgentMemoryEntry } from '@hyperneo/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mockMemories: ReturnType<typeof signal<AgentMemoryEntry[]>>;
let mockLoading: ReturnType<typeof signal<boolean>>;
let mockLoaded: ReturnType<typeof signal<boolean>>;
let mockError: ReturnType<typeof signal<string | null>>;
let mockQuery: ReturnType<typeof signal<string>>;
const mockAttach = vi.fn();
const mockDetach = vi.fn();
const mockSearch = vi.fn();
const mockWrite = vi.fn();
const mockDeleteMemory = vi.fn();
const mockReload = vi.fn();

vi.mock('../../../lib/memory-store', () => ({
  get memoryStore() {
    return {
      memories: mockMemories,
      isLoading: mockLoading,
      loaded: mockLoaded,
      error: mockError,
      query: mockQuery,
      attach: mockAttach,
      detach: mockDetach,
      search: mockSearch,
      write: mockWrite,
      deleteMemory: mockDeleteMemory,
      reload: mockReload,
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
    mockAttach.mockReset();
    mockDetach.mockReset();
    mockSearch.mockReset();
    mockWrite.mockReset();
    mockDeleteMemory.mockReset();
    mockReload.mockReset();
    mockAttach.mockResolvedValue(undefined);
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
    // loaded=false with isLoading still false is the brief window before attach
    // flips the loading flag — the spinner must win, not the empty state.
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
      expect(mockWrite).toHaveBeenCalledWith({
        key: 'new-key',
        content: 'A useful fact.',
        tags: ['project', 'feedback'],
      })
    );
  });

  it('warns (and relabels save) when creating with an existing key', async () => {
    mockMemories.value = [makeMemory('alpha')];

    render(<SpaceMemories spaceId="space-1" />);
    fireEvent.click(screen.getByTestId('memory-create-button'));
    const keyInput = await screen.findByTestId('memory-key-input');
    fireEvent.input(keyInput, { target: { value: 'alpha' } });

    expect(await screen.findByTestId('memory-duplicate-key-warning')).toBeTruthy();
    expect(screen.getByTestId('memory-save-button').textContent).toBe('Overwrite Memory');
  });

  it('blocks create when required fields are empty', async () => {
    render(<SpaceMemories spaceId="space-1" />);

    fireEvent.click(screen.getByTestId('memory-create-button'));
    await screen.findByTestId('memory-key-input');
    fireEvent.click(screen.getByTestId('memory-save-button'));

    expect(screen.getByTestId('memory-editor-error')).toBeTruthy();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('edits an existing memory with a locked key', async () => {
    mockMemories.value = [makeMemory('alpha', { content: 'old body', tags: ['x'] })];

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
        tags: ['x'],
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

  it('surfaces a retry control when loading fails', () => {
    mockError.value = 'Failed to load memories';

    render(<SpaceMemories spaceId="space-1" />);

    expect(screen.getByText('Failed to load memories')).toBeTruthy();
    fireEvent.click(screen.getByText('Retry'));
    expect(mockReload).toHaveBeenCalled();
  });
});
