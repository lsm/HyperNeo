/**
 * MemoryStore - Space-scoped agent memory management.
 *
 * ARCHITECTURE: One-shot RPC over the `agentMemory.*` handlers.
 * - Initial state: Fetched via `agentMemory.list` when a space is attached.
 * - Search: `agentMemory.list` with a `query` delegates to the daemon's hybrid
 *   BM25 + vector backend (no separate `agentMemory.search` call needed — the
 *   management UI wants plain entries, not ranked `{memory, rank}` hits).
 * - Updates: Re-fetched after each write/delete (there is no LiveQuery for
 *   memories, so we refresh explicitly).
 *
 * Signals (reactive state):
 * - memories: Currently displayed entries for the attached space
 * - query: The active search query ('' = full list)
 * - loading, loaded, error: View state
 */

import { signal } from '@preact/signals';
import type { AgentMemoryEntry } from '@hyperneo/shared';
import { Logger } from '@hyperneo/shared';
import { connectionManager } from './connection-manager';

const logger = new Logger('kai:web:memory-store');

const LIST_LIMIT = 100;

class MemoryStore {
  /** Currently displayed memories for the attached space. */
  readonly memories = signal<AgentMemoryEntry[]>([]);

  /** Active search query — empty string means "show all". */
  readonly query = signal<string>('');

  /** Loading state. */
  readonly isLoading = signal<boolean>(false);

  /**
   * Flips to `true` once the first load returns so the UI can distinguish
   * "still loading" from "genuinely zero memories".
   */
  readonly loaded = signal<boolean>(false);

  /** Error state. */
  readonly error = signal<string | null>(null);

  /** The space this store is currently bound to. */
  private spaceId: string | null = null;

  /**
   * Monotonic load generation. Each load() captures the generation at request
   * time and discards its result if a newer load (e.g. a faster search) has
   * started — prevents a slow `list` from clobbering a newer `search` result.
   */
  private loadGeneration = 0;

  /** Reset all signals and unbind from the current space. */
  detach(): void {
    this.spaceId = null;
    this.loadGeneration++;
    this.memories.value = [];
    this.query.value = '';
    this.isLoading.value = false;
    this.loaded.value = false;
    this.error.value = null;
  }

  /**
   * Bind to a space and load its memories. Safe to call on every mount; a
   * no-op when re-attaching to the same already-loaded space.
   */
  attach(spaceId: string): Promise<void> {
    if (this.spaceId === spaceId && this.loaded.value) return Promise.resolve();
    this.spaceId = spaceId;
    this.query.value = '';
    return this.reload();
  }

  /**
   * Re-fetch using the current space + query. Errors are surfaced via the
   * `error` signal (and re-thrown so callers can chain toasts if desired).
   */
  async reload(): Promise<void> {
    const spaceId = this.spaceId;
    if (!spaceId) return;
    const generation = ++this.loadGeneration;
    this.isLoading.value = true;
    this.error.value = null;
    try {
      const hub = await connectionManager.getHub();
      const query = this.query.value.trim();
      const rows = await hub.request<AgentMemoryEntry[]>('agentMemory.list', {
        spaceId,
        query: query || undefined,
        limit: LIST_LIMIT,
      });
      // Discard if a newer load started while this request was in flight.
      if (generation !== this.loadGeneration) return;
      this.memories.value = rows ?? [];
      this.loaded.value = true;
    } catch (err) {
      if (generation !== this.loadGeneration) return;
      this.error.value = err instanceof Error ? err.message : 'Failed to load memories';
      logger.error('Failed to load memories:', err);
      throw err;
    } finally {
      if (generation === this.loadGeneration) {
        this.isLoading.value = false;
      }
    }
  }

  /** Set the search query and refresh. Use '' to clear back to the full list. */
  search(query: string): Promise<void> {
    this.query.value = query;
    return this.reload();
  }

  /**
   * Create or update a memory. The daemon upserts on (spaceId, key): an
   * existing key updates content (and tags when provided), a new key creates.
   * Returns the written entry and refreshes the list.
   */
  async write(params: {
    key: string;
    content: string;
    tags?: string[];
  }): Promise<AgentMemoryEntry> {
    const spaceId = this.spaceId;
    if (!spaceId) throw new Error('No space selected.');
    const hub = await connectionManager.getHub();
    const entry = await hub.request<AgentMemoryEntry>('agentMemory.write', {
      spaceId,
      key: params.key,
      content: params.content,
      tags: params.tags,
    });
    await this.reload();
    return entry;
  }

  /** Delete a memory by key. Returns whether a row was actually deleted. */
  async deleteMemory(key: string): Promise<boolean> {
    const spaceId = this.spaceId;
    if (!spaceId) throw new Error('No space selected.');
    const hub = await connectionManager.getHub();
    const result = await hub.request<{ deleted: boolean }>('agentMemory.delete', {
      spaceId,
      key,
    });
    await this.reload();
    return result.deleted;
  }
}

/** Singleton store instance. */
export const memoryStore = new MemoryStore();
