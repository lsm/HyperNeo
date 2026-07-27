/**
 * MemoryStore - Space-scoped agent memory management.
 *
 * ARCHITECTURE: One-shot RPC over the `agentMemory.*` handlers.
 * - Initial state: Fetched via `agentMemory.list` when a space is attached.
 * - Search: `agentMemory.list` with a `query` delegates to the daemon's hybrid
 *   BM25 + vector backend (no separate `agentMemory.search` call needed — the
 *   management UI wants plain entries, not ranked `{memory, rank}` hits). The
 *   handler passes `recordAccess: false` so browsing stays read-only.
 * - Pagination: spaces may hold more memories than the page size; `loadMore()`
 *   fetches and appends the next page. The backend exposes no total, so
 *   `hasMore` is inferred from whether the last page was full.
 * - Updates: Mutations are applied optimistically, then a best-effort reload
 *   reconciles. A refresh failure never fails the mutation.
 *
 * Signals (reactive state):
 * - memories: Currently displayed entries for the attached space
 * - query: The active search query ('' = full list)
 * - hasMore: More pages may be available behind the current view
 * - loading, loaded, error: View state
 */

import { signal } from '@preact/signals';
import type { AgentMemoryEntry } from '@hyperneo/shared';
import { Logger } from '@hyperneo/shared';
import { connectionManager } from './connection-manager';

const logger = new Logger('kai:web:memory-store');

const PAGE_SIZE = 100;

class MemoryStore {
  /** Currently displayed memories for the attached space. */
  readonly memories = signal<AgentMemoryEntry[]>([]);

  /** Active search query — empty string means "show all". */
  readonly query = signal<string>('');

  /** More pages may be available behind the currently loaded view. */
  readonly hasMore = signal<boolean>(false);

  /** Loading state for the current view (initial load or a refresh). */
  readonly isLoading = signal<boolean>(false);

  /** Loading state for an appended `loadMore` page (does not block the view). */
  readonly isLoadingMore = signal<boolean>(false);

  /**
   * Flips to `true` once the first load returns so the UI can distinguish
   * "still loading" from "genuinely zero memories".
   */
  readonly loaded = signal<boolean>(false);

  /** Error state. */
  readonly error = signal<string | null>(null);

  /** The space this store is currently bound to. */
  private spaceId: string | null = null;

  /** Offset of the next page to fetch via `loadMore()`. */
  private offset = 0;

  /**
   * Monotonic load generation. Each fetch captures the generation at request
   * time and discards its result if a newer fetch started — prevents a slow
   * page from clobbering a newer replace/append.
   */
  private loadGeneration = 0;

  /** Reset all signals and unbind from the current space. */
  detach(): void {
    this.spaceId = null;
    this.offset = 0;
    this.loadGeneration++;
    this.memories.value = [];
    this.query.value = '';
    this.hasMore.value = false;
    this.isLoading.value = false;
    this.isLoadingMore.value = false;
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
   * Re-fetch the first page (offset 0) and replace the view. Errors are
   * surfaced via the `error` signal and re-thrown so callers can chain toasts.
   */
  async reload(): Promise<void> {
    const spaceId = this.spaceId;
    if (!spaceId) return;
    this.offset = 0;
    const generation = ++this.loadGeneration;
    this.isLoading.value = true;
    this.error.value = null;
    try {
      const rows = await this.fetchPage(spaceId, 0);
      if (generation !== this.loadGeneration) return;
      this.memories.value = rows;
      this.applyHasMore(rows.length);
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

  /**
   * Fetch and append the next page. No-op when no more pages are expected or
   * a fetch is already in flight. Refresh failures are swallowed (best-effort)
   * — the already-loaded view stays usable.
   */
  async loadMore(): Promise<void> {
    const spaceId = this.spaceId;
    if (!spaceId || !this.hasMore.value || this.isLoadingMore.value) return;
    const offset = this.offset + PAGE_SIZE;
    const generation = ++this.loadGeneration;
    this.isLoadingMore.value = true;
    try {
      const rows = await this.fetchPage(spaceId, offset);
      if (generation !== this.loadGeneration) return;
      // Append, de-duplicating by key in case offsets shifted between fetches.
      const seen = new Set(this.memories.value.map((m) => m.key));
      const fresh = rows.filter((m) => !seen.has(m.key));
      this.memories.value = [...this.memories.value, ...fresh];
      this.offset = offset;
      this.applyHasMore(rows.length);
    } catch (err) {
      if (generation !== this.loadGeneration) return;
      // Best-effort: surface the error but keep the loaded view intact.
      this.error.value = err instanceof Error ? err.message : 'Failed to load more memories';
      logger.error('Failed to load more memories:', err);
    } finally {
      // Always clear the load-more spinner: if a reload interrupted this fetch
      // (generation advanced), the result is discarded above, but leaving
      // isLoadingMore pinned would stick the button and block future loadMore.
      this.isLoadingMore.value = false;
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
   * The written entry is applied optimistically; a refresh then reconciles.
   * A refresh failure does NOT fail the write — the mutation already succeeded.
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
    // If the space switched while the write was in flight, don't contaminate the
    // new space's view with the old space's entry. The write persisted
    // server-side and will be visible when the user returns to that space.
    if (this.spaceId !== spaceId) return entry;
    // Optimistically reflect the write even if the refresh below fails.
    this.upsertEntry(entry);
    await this.refreshBestEffort();
    return entry;
  }

  /**
   * Atomically create a new memory. The daemon inserts with ON CONFLICT DO
   * NOTHING and rejects when the key already exists, so this never silently
   * overwrites an existing entry (unlike write()'s upsert). Use for the
   * "New Memory" flow; edits should use write().
   */
  async create(params: {
    key: string;
    content: string;
    tags?: string[];
  }): Promise<AgentMemoryEntry> {
    const spaceId = this.spaceId;
    if (!spaceId) throw new Error('No space selected.');
    const hub = await connectionManager.getHub();
    const entry = await hub.request<AgentMemoryEntry>('agentMemory.create', {
      spaceId,
      key: params.key,
      content: params.content,
      tags: params.tags,
    });
    if (this.spaceId !== spaceId) return entry;
    this.upsertEntry(entry);
    await this.refreshBestEffort();
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
    // Guard against a mid-delete space switch landing the removal in the wrong
    // space's view (see write()).
    if (this.spaceId !== spaceId) return result.deleted;
    if (result.deleted) this.removeEntry(key);
    await this.refreshBestEffort();
    return result.deleted;
  }

  /**
   * Authoritative existence check for a key. Read-only (`recordAccess: false`)
   * so it never perturbs telemetry. Best-effort: returns false on transport
   * error so a failed check never blocks a legitimate create.
   */
  async exists(key: string): Promise<boolean> {
    const spaceId = this.spaceId;
    if (!spaceId) return false;
    try {
      const hub = await connectionManager.getHub();
      const entry = await hub.request<AgentMemoryEntry | null>('agentMemory.read', {
        spaceId,
        key,
        recordAccess: false,
      });
      return entry !== null;
    } catch (err) {
      logger.warn('memoryStore.exists failed, defaulting to false:', err);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async fetchPage(spaceId: string, offset: number): Promise<AgentMemoryEntry[]> {
    const hub = await connectionManager.getHub();
    const query = this.query.value.trim();
    const rows = await hub.request<AgentMemoryEntry[]>('agentMemory.list', {
      spaceId,
      query: query || undefined,
      limit: PAGE_SIZE,
      offset,
    });
    return rows ?? [];
  }

  /** A full page means more may exist; a short page means we've reached the end. */
  private applyHasMore(returned: number): void {
    this.hasMore.value = returned >= PAGE_SIZE;
  }

  /** Re-fetch the first page to reconcile, swallowing refresh-only failures. */
  private async refreshBestEffort(): Promise<void> {
    try {
      await this.reload();
    } catch {
      // The mutation already succeeded and the optimistic update above keeps
      // the UI consistent. Suppress the refresh error so the user is never
      // told to retry a write/delete that already persisted; the next
      // load/search reconciles.
      this.error.value = null;
    }
  }

  private upsertEntry(entry: AgentMemoryEntry): void {
    const others = this.memories.value.filter((m) => m.key !== entry.key);
    this.memories.value = [...others, entry].sort(compareMemories);
  }

  private removeEntry(key: string): void {
    this.memories.value = this.memories.value.filter((m) => m.key !== key);
  }
}

/** Match the daemon's list ordering: updated_at DESC, then key ASC. */
function compareMemories(a: AgentMemoryEntry, b: AgentMemoryEntry): number {
  return b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

/** Singleton store instance. */
export const memoryStore = new MemoryStore();
