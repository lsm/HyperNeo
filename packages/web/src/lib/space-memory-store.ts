import { signal } from '@preact/signals';
import type { AgentMemoryEntry } from '@hyperneo/shared';
import { Logger } from '@hyperneo/shared';
import { connectionManager } from './connection-manager';

const logger = new Logger('hyperneo:web:memory-store');

const PAGE_SIZE = 100;

class MemoryStore {
  readonly memories = signal<AgentMemoryEntry[]>([]);

  readonly query = signal<string>('');

  readonly hasMore = signal<boolean>(false);

  readonly isLoading = signal<boolean>(false);

  readonly isLoadingMore = signal<boolean>(false);

  readonly loaded = signal<boolean>(false);

  readonly error = signal<string | null>(null);

  private spaceId: string | null = null;

  private offset = 0;

  private loadGeneration = 0;

  private loadMoreGen = 0;

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

  attach(spaceId: string): Promise<void> {
    if (this.spaceId === spaceId && this.loaded.value) return Promise.resolve();
    this.spaceId = spaceId;
    this.query.value = '';
    return this.reload();
  }

  async reload(): Promise<void> {
    const spaceId = this.spaceId;
    if (!spaceId) return;
    this.offset = 0;
    const generation = ++this.loadGeneration;
    this.isLoading.value = true;
    this.error.value = null;
    this.hasMore.value = false;
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
      const seen = new Set(this.memories.value.map((m) => m.key));
      const fresh = rows.filter((m) => !seen.has(m.key));
      this.memories.value = [...this.memories.value, ...fresh];
      this.offset = offset;
      this.applyHasMore(rows.length);
    } catch (err) {
      if (generation !== this.loadGeneration) return;
      this.error.value = err instanceof Error ? err.message : 'Failed to load more memories';
      logger.error('Failed to load more memories:', err);
    } finally {
      if (owner === this.loadMoreGen) {
        this.isLoadingMore.value = false;
      }
    }
  }

  search(query: string): Promise<void> {
    this.query.value = query;
    return this.reload();
  }

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
    if (this.spaceId !== spaceId) return entry;
    if (!this.query.value.trim()) {
      this.upsertEntry(entry);
    } else if (this.memories.value.some((m) => m.key === entry.key)) {
      this.replaceEntryInPlace(entry);
    }
    await this.refreshBestEffort();
    return entry;
  }

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
    if (!this.query.value.trim()) this.upsertEntry(entry);
    await this.refreshBestEffort();
    return entry;
  }

  async deleteMemory(key: string): Promise<boolean> {
    const spaceId = this.spaceId;
    if (!spaceId) throw new Error('No space selected.');
    const hub = await connectionManager.getHub();
    const result = await hub.request<{ deleted: boolean }>('agentMemory.delete', {
      spaceId,
      key,
    });
    if (this.spaceId !== spaceId) return result.deleted;
    if (result.deleted) this.removeEntry(key);
    await this.refreshBestEffort();
    return result.deleted;
  }

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

  private applyHasMore(returned: number): void {
    this.hasMore.value = returned >= PAGE_SIZE;
  }

  private async refreshBestEffort(): Promise<void> {
    const hadLoaded = this.loaded.value;
    const prevHasMore = this.hasMore.value;
    const prevOffset = this.offset;
    const prevError = this.error.value;
    try {
      await this.reload();
    } catch {
      this.hasMore.value = prevHasMore;
      this.offset = prevOffset;
      if (hadLoaded) {
        this.error.value = prevError;
      }
    }
  }

  private upsertEntry(entry: AgentMemoryEntry): void {
    const others = this.memories.value.filter((m) => m.key !== entry.key);
    this.memories.value = [...others, entry].sort(compareMemories);
  }

  private replaceEntryInPlace(entry: AgentMemoryEntry): void {
    this.memories.value = this.memories.value.map((m) => (m.key === entry.key ? entry : m));
  }

  private removeEntry(key: string): void {
    this.memories.value = this.memories.value.filter((m) => m.key !== key);
  }
}

function compareMemories(a: AgentMemoryEntry, b: AgentMemoryEntry): number {
  return b.updatedAt - a.updatedAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

export const memoryStore = new MemoryStore();
