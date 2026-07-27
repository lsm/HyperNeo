/**
 * SpaceMemories Component
 *
 * Browse and manage a space's agent memories: list, hybrid search, create,
 * edit, and delete. Delegates all data access to the `agentMemory.*` RPCs via
 * `memoryStore`.
 *
 * Space-scoped only — per-agent (mine / space / all) filtering lands with the
 * per-agent namespacing task.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import type { AgentMemoryEntry } from '@hyperneo/shared';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal';
import { memoryStore } from '../../lib/memory-store';
import { toast } from '../../lib/toast';
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
    <div class="group border-b border-white/10 py-3 last:border-b-0">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <span class="block truncate font-mono text-sm font-medium text-gray-100">
            {memory.key}
          </span>
          <p class="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-xs leading-5 text-gray-400">
            {memory.content}
          </p>
          <div class="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-gray-600">
            <span>Updated {formatDate(memory.updatedAt)}</span>
            {memory.accessCount > 0 && <span>· {memory.accessCount} reads</span>}
            {memory.tags.map((tag) => (
              <span key={tag} class="rounded border border-white/10 px-1.5 py-0.5 text-gray-500">
                {tag}
              </span>
            ))}
          </div>
        </div>
        <div class="flex flex-shrink-0 items-center gap-1 opacity-70 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onClick={() => onEdit(memory)}
            class="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-white/5 hover:text-gray-300"
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
            class="rounded-md p-1.5 text-gray-500 transition-colors hover:bg-white/5 hover:text-red-400"
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

function PlusIcon() {
  return (
    <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width={2} d="M12 4v16m8-8H4" />
    </svg>
  );
}

function MemoryIcon() {
  return (
    <svg class="w-5 h-5 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
  const searchActive = memoryStore.query.value.trim() !== '';

  const [searchInput, setSearchInput] = useState('');
  const [editorMemory, setEditorMemory] = useState<AgentMemoryEntry | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [deletingMemory, setDeletingMemory] = useState<AgentMemoryEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Reset local UI state on space switch so stale modals/search don't carry over.
    setSearchInput('');
    setEditorMemory(null);
    setEditorOpen(false);
    setDeletingMemory(null);
    setDeleteError(null);
    memoryStore.attach(spaceId).catch(() => {
      // Error surfaced via memoryStore.error signal.
    });
    return () => {
      memoryStore.detach();
    };
  }, [spaceId]);

  // Clear any pending debounced search on unmount.
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
    setDeleting(true);
    setDeleteError(null);
    try {
      await memoryStore.deleteMemory(key);
      setDeletingMemory(null);
      toast.success(`Memory "${key}" deleted`);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete memory');
    } finally {
      setDeleting(false);
    }
  };

  const handleRetry = () => {
    memoryStore.reload().catch(() => {
      // Error surfaced via memoryStore.error signal.
    });
  };

  if (!loaded) {
    return (
      <div class="h-full overflow-y-auto">
        <div class="min-h-[calc(100%+1px)] flex items-center justify-center">
          <span class="text-xs text-gray-600 animate-pulse">Loading memories...</span>
        </div>
      </div>
    );
  }

  const trimmedSearch = searchInput.trim();

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="mb-3 flex flex-shrink-0 flex-col gap-3 rounded-lg border border-white/10 bg-white/[0.035] px-3 py-3">
        <div class="flex items-center justify-between gap-3">
          <div class="flex min-w-0 items-start gap-3">
            <div class="mt-0.5 h-8 w-1 flex-shrink-0 rounded-full bg-pink-400/70" />
            <div class="min-w-0">
              <p class="text-xs font-semibold uppercase tracking-wider text-gray-300">
                Memories · {memories.length} {searchActive ? 'results' : 'stored'}
              </p>
              <p class="mt-1 text-xs text-gray-500">
                Persistent facts, conventions, and decisions this space's agents can recall. Search
                uses the hybrid keyword + semantic backend.
              </p>
            </div>
          </div>
          <Button
            size="sm"
            onClick={handleCreate}
            icon={<PlusIcon />}
            data-testid="memory-create-button"
          >
            New Memory
          </Button>
        </div>

        <div class="relative">
          <svg
            class="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-600"
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
            class="w-full rounded-lg border border-white/10 bg-dark-950 py-1.5 pl-8 pr-8 text-sm text-gray-100 placeholder-gray-600 focus:border-blue-500 focus:outline-none"
            aria-label="Search memories"
            data-testid="memory-search-input"
          />
          {searchInput && (
            <button
              type="button"
              onClick={() => handleSearchInput('')}
              class="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-gray-500 hover:text-gray-300"
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
      </div>

      {error && (
        <div class="mb-3 flex flex-shrink-0 items-center justify-between gap-3 rounded-lg border border-red-800/50 bg-red-900/20 px-3 py-2">
          <span class="text-xs text-red-400">{error}</span>
          <Button size="xs" variant="ghost" onClick={handleRetry}>
            Retry
          </Button>
        </div>
      )}

      {memories.length === 0 ? (
        <div class="flex flex-1 flex-col items-center justify-center py-12 text-center">
          <div class="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-dark-800">
            <MemoryIcon />
          </div>
          {trimmedSearch ? (
            <>
              <p class="text-sm font-medium text-gray-400">No memories match "{trimmedSearch}".</p>
              <p class="mt-1 text-xs text-gray-600">Try a different query or clear the search.</p>
            </>
          ) : (
            <>
              <p class="text-sm font-medium text-gray-400">No memories stored yet.</p>
              <p class="mt-1 text-xs text-gray-600">
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
        <div class="scrollbar-dark min-h-0 flex-1 overflow-y-auto pr-3">
          <div class="min-h-[calc(100%+1px)]">
            {memories.map((memory) => (
              <MemoryCard
                key={memory.key}
                memory={memory}
                onEdit={handleEdit}
                onDelete={handleDeleteClick}
              />
            ))}
          </div>
        </div>
      )}

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
