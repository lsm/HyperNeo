import { useEffect, useRef, useState } from 'preact/hooks';
import type { AgentMemoryEntry } from '@hyperneo/shared';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal';
import { memoryStore } from '../../lib/memory-store';
import { toast } from '../../lib/toast';
import { cn } from '../../lib/utils';
import {
  FLAT_SURFACE,
  GLASS_CONTENT_CONTAINER_CLASS,
  GLASS_PRIMARY_BUTTON_CLASS,
  GLASS_SURFACE,
} from './glass-workspace';
import { SpaceMemoryEditor } from './SpaceMemoryEditor';

const SEARCH_DEBOUNCE_MS = 250;

interface SpaceMemoriesProps {
  spaceId: string;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

interface MemoryCardProps {
  memory: AgentMemoryEntry;
  onEdit: (memory: AgentMemoryEntry) => void;
  onDelete: (memory: AgentMemoryEntry) => void;
}

function MemoryCard({ memory, onEdit, onDelete }: MemoryCardProps) {
  return (
    <div
      class={cn(
        'group relative flex min-h-[12rem] flex-col rounded-2xl border p-5 transition duration-200 hover:-translate-y-0.5 hover:border-white/25',
        FLAT_SURFACE
      )}
    >
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <span class="block truncate font-mono text-sm font-semibold text-gray-100">
            {memory.key}
          </span>
          <p class="mt-1.5 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-5 text-gray-300">
            {memory.content}
          </p>
          <div class="mt-2.5 flex flex-wrap items-center gap-1.5 text-[11px] text-gray-500">
            <span>Updated {formatDate(memory.updatedAt)}</span>
            {memory.accessCount > 0 && <span>· {memory.accessCount} reads</span>}
            {memory.tags.map((tag) => (
              <span
                key={tag}
                class="rounded-full border border-white/10 bg-white/[0.04] px-2 py-0.5 text-gray-400"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
        <div class="flex flex-shrink-0 items-center gap-1 opacity-60 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={() => onEdit(memory)}
            class="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-white/5 hover:text-gray-200"
            aria-label={`Edit memory ${memory.key}`}
            data-testid={`memory-edit-${memory.key}`}
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
              />
            </svg>
          </button>
          <button
            type="button"
            onClick={() => onDelete(memory)}
            class="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-white/5 hover:text-red-400"
            aria-label={`Delete memory ${memory.key}`}
            data-testid={`memory-delete-${memory.key}`}
          >
            <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

function MemoryIcon() {
  return (
    <svg class="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-width={2}
        d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z"
      />
    </svg>
  );
}

export function SpaceMemories({ spaceId }: SpaceMemoriesProps) {
  const memories = memoryStore.memories.value;
  const loaded = memoryStore.loaded.value;
  const error = memoryStore.error.value;
  const hasMore = memoryStore.hasMore.value;
  const loadingMore = memoryStore.isLoadingMore.value;
  const searchActive = memoryStore.query.value.trim() !== '';

  const [searchInput, setSearchInput] = useState('');
  const [editorMemory, setEditorMemory] = useState<AgentMemoryEntry | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deletingMemory, setDeletingMemory] = useState<AgentMemoryEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteSpaceRef = useRef<string | null>(null);

  useEffect(() => {
    setSearchInput('');
    setEditorMemory(null);
    setEditorOpen(false);
    setDeletingMemory(null);
    setDeleteError(null);
    setDeleting(false);
    deleteSpaceRef.current = spaceId;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    memoryStore.attach(spaceId).catch(() => {
      // Error surfaced via memoryStore.error signal.
    });
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      memoryStore.detach();
    };
  }, [spaceId]);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  const handleSearchInput = (value: string) => {
    setSearchInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      memoryStore.search(value).catch(() => {
        // Error surfaced via memoryStore.error signal.
      });
    }, SEARCH_DEBOUNCE_MS);
  };

  const handleCreate = () => {
    setEditorMemory(null);
    setEditorOpen(true);
  };

  const handleEdit = (memory: AgentMemoryEntry) => {
    setEditorMemory(memory);
    setEditorOpen(true);
  };

  const handleEditorClose = () => {
    setEditorOpen(false);
    setEditorMemory(null);
  };

  const handleDeleteClick = (memory: AgentMemoryEntry) => {
    setDeletingMemory(memory);
    setDeleteError(null);
  };

  const handleDeleteConfirm = async () => {
    if (!deletingMemory) return;
    const key = deletingMemory.key;
    const startedSpace = deleteSpaceRef.current;
    setDeleting(true);
    setDeleteError(null);
    try {
      await memoryStore.deleteMemory(key);
      if (deleteSpaceRef.current !== startedSpace) return;
      setDeletingMemory(null);
      toast.success(`Memory "${key}" deleted`);
    } catch (err) {
      if (deleteSpaceRef.current !== startedSpace) return;
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete memory');
    } finally {
      if (deleteSpaceRef.current === startedSpace) setDeleting(false);
    }
  };

  const handleRetry = () => {
    memoryStore.reload().catch(() => {
      // Error surfaced via memoryStore.error signal.
    });
  };

  if (!loaded && !error) {
    return (
      <div class="h-full overflow-y-auto">
        <div class="mx-auto w-full max-w-6xl px-4 pb-10 pt-4 sm:px-8">
          <div
            class={cn(
              'flex min-h-[12rem] items-center justify-center rounded-2xl border p-6',
              FLAT_SURFACE
            )}
          >
            <span class="text-xs text-gray-400 animate-pulse">Loading memories...</span>
          </div>
        </div>
      </div>
    );
  }

  const trimmedSearch = searchInput.trim();

  return (
    <div class="flex h-full min-h-0 flex-col overflow-hidden">
      <div class="flex-1 overflow-y-auto">
        <div class={GLASS_CONTENT_CONTAINER_CLASS}>
          <section
            class={cn(
              'mb-5 flex flex-col gap-4 rounded-2xl border p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6',
              GLASS_SURFACE
            )}
            data-testid="space-memories-introduction"
            aria-label="Memories workspace summary"
          >
            <div class="max-w-2xl">
              <div class="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-amber-200/80">
                <span class="h-1.5 w-1.5 rounded-full bg-amber-300" />
                Persistent recall
              </div>
              <h2 class="mt-2 text-lg font-semibold tracking-tight text-gray-50">
                Memories · {memories.length}
                {hasMore ? '+' : ''} {searchActive ? 'results' : 'stored'}
              </h2>
              <p class="mt-1 text-sm leading-5 text-gray-300">
                Persistent facts, conventions, and decisions this space's agents can recall. Search
                uses the hybrid keyword + semantic backend.
              </p>
            </div>
            <button
              type="button"
              onClick={handleCreate}
              class={GLASS_PRIMARY_BUTTON_CLASS}
              data-testid="memory-create-button"
            >
              New Memory
            </button>
          </section>

          <div class={cn('relative mb-4 rounded-2xl border p-1.5', GLASS_SURFACE)}>
            <svg
              class="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              aria-hidden="true"
            >
              <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
              />
            </svg>
            <input
              type="text"
              value={searchInput}
              onInput={(e) => handleSearchInput((e.target as HTMLInputElement).value)}
              placeholder="Search memories…"
              class="w-full rounded-xl border border-white/10 bg-dark-950/80 py-2.5 pl-10 pr-9 text-sm text-gray-100 placeholder-gray-500 transition focus:border-blue-500/60 focus:outline-none"
              aria-label="Search memories"
              data-testid="memory-search-input"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => handleSearchInput('')}
                class="absolute right-3 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-500 transition hover:text-gray-300"
                aria-label="Clear search"
              >
                <svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    stroke-width={2}
                    d="M6 18L18 6M6 6l12 12"
                  />
                </svg>
              </button>
            )}
          </div>

          {error && (
            <div
              class={cn(
                'mb-5 flex flex-shrink-0 items-center justify-between gap-3 rounded-2xl border border-red-300/20 p-4 text-sm text-red-200',
                FLAT_SURFACE
              )}
            >
              <span>{error}</span>
              <Button size="xs" variant="ghost" onClick={handleRetry}>
                Retry
              </Button>
            </div>
          )}

          {memories.length === 0 ? (
            <div
              class={cn(
                'flex flex-1 flex-col items-center justify-center rounded-2xl border border-dashed p-12 text-center',
                FLAT_SURFACE
              )}
            >
              <div class="mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-white/[0.05]">
                <MemoryIcon />
              </div>
              {trimmedSearch ? (
                <>
                  <p class="text-sm font-medium text-gray-200">
                    No memories match "{trimmedSearch}".
                  </p>
                  <p class="mt-1 text-xs text-gray-400">
                    Try a different query or clear the search.
                  </p>
                </>
              ) : (
                <>
                  <p class="text-sm font-medium text-gray-200">No memories stored yet.</p>
                  <p class="mt-1 text-xs text-gray-400">
                    Create a memory your agents can recall during sessions.
                  </p>
                  <div class="mt-4">
                    <Button size="sm" variant="secondary" onClick={handleCreate}>
                      New Memory
                    </Button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <div class="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(22rem,100%),1fr))]">
              {memories.map((memory) => (
                <MemoryCard
                  key={memory.key}
                  memory={memory}
                  onEdit={handleEdit}
                  onDelete={handleDeleteClick}
                />
              ))}
            </div>
          )}

          {hasMore && (
            <div class="mt-5 flex justify-center">
              <Button
                size="sm"
                variant="secondary"
                onClick={() => memoryStore.loadMore().catch(() => {})}
                loading={loadingMore}
                data-testid="memory-load-more"
              >
                Load more
              </Button>
            </div>
          )}
        </div>
      </div>

      {editorOpen && (
        <SpaceMemoryEditor
          memory={editorMemory}
          existingKeys={memories.map((memory) => memory.key)}
          onClose={handleEditorClose}
        />
      )}

      {deletingMemory && (
        <ConfirmModal
          isOpen
          onClose={() => {
            if (deleting) return;
            setDeletingMemory(null);
            setDeleteError(null);
          }}
          onConfirm={handleDeleteConfirm}
          title="Delete Memory"
          message={`Delete the memory "${deletingMemory.key}"? This action cannot be undone.`}
          confirmText="Delete"
          confirmButtonVariant="danger"
          isLoading={deleting}
          error={deleteError}
        />
      )}
    </div>
  );
}
