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

const logger = new Logger('hyperneo:web:memory-store');

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

  /**
   * Ownership token for the active load-more request. Incremented when a new
   * loadMore starts and on detach; a loadMore only clears `isLoadingMore` if it
   * is still the active owner, so a stale request settling after a space switch
   * cannot clear the new space's spinner.
   */
  private loadMoreGen = 0;

  /** Reset all signals and unbind from the current space. */
  detach(): void {
    this.spaceId = null;
    this.offset = 0;
    this.loadGeneration++;
    this.loadMoreGen++;
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
    // Drop stale pagination until the replacement page lands: if this reload
    // fails (or is in flight) we don't want Load-more enabled against rows
    // from a previous query/space.
    this.hasMore.value = false;
    // Take over from any in-flight loadMore: clear its spinner and invalidate
    // it so a fetch that never settles can't pin isLoadingMore or block further
    // pagination via the loadMore guard.
    this.loadMoreGen++;
    this.isLoadingMore.value = false;
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
    const owner = ++this.loadMoreGen;
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
      // Only clear the spinner if this request is still the active load-more
      // owner. A space switch (detach) or a newer loadMore bumps loadMoreGen,
      // so a stale request settling late won't clear the new space's spinner
      // — but a same-space reload that interrupted this still lets us clear
      // (loadMoreGen unchanged) so the button never sticks.
      if (owner === this.loadMoreGen) {
        this.isLoadingMore.value = false;
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
    // During an active search, skip inserting a NEW non-matching entry (it
    // would pollute the ranked results). An EDIT of a result already in the
    // filtered set updates in place WITHOUT re-sorting — search results are
    // relevance-ordered (BM25+vector), and re-sorting by updatedAt would
    // discard that order. The full (no-query) list is updatedAt-ordered, so
    // upsert + re-sort is correct there. (create() keeps the strict gate: a
    // brand-new memory that doesn't match the query shouldn't appear mid-search.)
    if (!this.query.value.trim()) {
      this.upsertEntry(entry);
    } else if (this.memories.value.some((m) => m.key === entry.key)) {
      this.replaceEntryInPlace(entry);
    }
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
    // Skip the optimistic upsert during an active search (see write()).
    if (!this.query.value.trim()) this.upsertEntry(entry);
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

  /**
   * Re-fetch the first page to reconcile after a mutation, without leaking a
   * refresh failure into the view. The mutation already persisted, so on
   * failure we restore the pre-refresh view state (hasMore etc.) rather than
   * leaving reload's upfront clears in place. The refresh error is suppressed
   * only when a page had already loaded — if the initial load itself failed,
   * we leave that error visible so the user isn't left looking at a spinner.
   */
  private async refreshBestEffort(): Promise<void> {
    const hadLoaded = this.loaded.value;
    const prevHasMore = this.hasMore.value;
    const prevOffset = this.offset;
    const prevError = this.error.value;
    try {
      await this.reload();
    } catch {
      // Restore pagination the failed reload cleared upfront.
      this.hasMore.value = prevHasMore;
      // Keep the load-more cursor aligned with the displayed rows; otherwise a
      // reload that zeroed offset (then failed) would make the next Load-more
      // re-fetch rows already present (a silent no-op).
      this.offset = prevOffset;
      if (hadLoaded) {
        // A page was already loaded: keep the UI stable and don't tell the user
        // to retry a mutation that already persisted.
        this.error.value = prevError;
      }
      // If nothing had loaded yet, leave reload's error set so the load failure
      // stays visible instead of a permanent spinner.
    }
  }

  private upsertEntry(entry: AgentMemoryEntry): void {
    const others = this.memories.value.filter((m) => m.key !== entry.key);
    this.memories.value = [...others, entry].sort(compareMemories);
  }

  /**
   * Replace a single entry by key without re-ordering. Used for in-place edits
   * of search results, which are relevance-ordered (upsertEntry's updatedAt
   * sort would discard the backend's BM25+vector rank).
   */
  private replaceEntryInPlace(entry: AgentMemoryEntry): void {
    this.memories.value = this.memories.value.map((m) => (m.key === entry.key ? entry : m));
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
