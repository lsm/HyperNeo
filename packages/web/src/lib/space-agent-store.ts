import type { CreateSpaceAgentParams, SpaceAgent, UpdateSpaceAgentParams } from '@hyperneo/shared';
import { signal } from '@preact/signals';
import { connectionManager } from './connection-manager';

export interface CreateSpaceAgentRequest extends Omit<CreateSpaceAgentParams, 'handle'> {
  handle?: string;
  templateKey?: string | null;
}

function sortAgents(agents: SpaceAgent[]): SpaceAgent[] {
  return [...agents].sort((a, b) => a.createdAt - b.createdAt);
}

export class SpaceAgentStore {
  readonly agents = signal<SpaceAgent[]>([]);
  readonly loading = signal(false);
  readonly error = signal<string | null>(null);
  readonly spaceId = signal<string | null>(null);
  readonly reminderCounts = signal<Record<string, number>>({});

  private cleanups: Array<() => void> = [];
  private subscribedSpaceId: string | null = null;
  private countsRefreshing = false;
  private countsQueued = false;
  private generation = 0;

  private hub() {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) throw new Error('Not connected');
    return hub;
  }

  async selectSpace(spaceId: string): Promise<void> {
    if (this.spaceId.value === spaceId && this.subscribedSpaceId === spaceId) return;
    this.teardown();
    this.spaceId.value = spaceId;
    this.agents.value = [];
    await this.subscribe(spaceId);
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const spaceId = this.spaceId.value;
    if (!spaceId) return;
    const generation = ++this.generation;
    this.loading.value = true;
    this.error.value = null;
    try {
      const { agents } = await this.hub().request<{ agents: SpaceAgent[] }>('spaceAgentV2.list', {
        spaceId,
      });
      if (!this.isCurrent(generation)) return;
      this.agents.value = sortAgents(agents);
      await this.refreshReminderCounts(generation);
    } catch (err) {
      if (!this.isCurrent(generation)) return;
      this.error.value = err instanceof Error ? err.message : 'Failed to load agents';
    } finally {
      if (this.isCurrent(generation)) this.loading.value = false;
    }
  }

  private async refreshReminderCounts(generation: number): Promise<void> {
    if (this.countsRefreshing) {
      this.countsQueued = true;
      return;
    }
    this.countsRefreshing = true;
    try {
      do {
        this.countsQueued = false;
        await this.fetchReminderCounts(generation);
      } while (this.countsQueued);
    } finally {
      this.countsRefreshing = false;
    }
  }

  private async fetchReminderCounts(generation: number): Promise<void> {
    const spaceId = this.spaceId.value;
    if (!spaceId) return;
    try {
      const { counts } = await this.hub().request<{ counts: Record<string, number> }>(
        'spaceAgentV2.listReminderCounts',
        { spaceId }
      );
      if (!this.isCurrent(generation)) return;
      this.reminderCounts.value = counts;
    } catch {
      if (!this.isCurrent(generation)) return;
      this.reminderCounts.value = {};
    }
  }

  private isCurrent(generation: number): boolean {
    return this.generation === generation;
  }

  async recover(): Promise<void> {
    const spaceId = this.spaceId.value;
    if (!spaceId) return;
    this.releaseHandlers();
    try {
      await this.subscribe(spaceId);
    } catch {}
    await this.refresh();
  }

  async create(params: CreateSpaceAgentRequest): Promise<SpaceAgent> {
    const spaceId = this.spaceId.value;
    if (!spaceId) throw new Error('No space selected');
    const { agent } = await this.hub().request<{ agent: SpaceAgent }>('spaceAgentV2.create', {
      ...params,
      spaceId,
    });
    this.upsert(agent);
    return agent;
  }

  async update(id: string, changes: UpdateSpaceAgentParams): Promise<SpaceAgent> {
    const { agent } = await this.hub().request<{ agent: SpaceAgent }>('spaceAgentV2.update', {
      id,
      ...changes,
    });
    this.upsert(agent);
    return agent;
  }

  async remove(id: string): Promise<void> {
    await this.hub().request<{ id: string }>('spaceAgentV2.delete', { id });
    this.drop(id);
  }

  upsert(agent: SpaceAgent): void {
    if (!this.spaceId.value || agent.spaceId !== this.spaceId.value) return;
    const current = this.agents.value;
    const index = current.findIndex((a) => a.id === agent.id);
    if (index === -1) {
      this.agents.value = sortAgents([...current, agent]);
      void this.refreshReminderCounts(this.generation);
      return;
    }
    const next = [...current];
    next[index] = agent;
    this.agents.value = next;
  }

  drop(id: string): void {
    this.agents.value = this.agents.value.filter((a) => a.id !== id);
  }

  private async subscribe(spaceId: string): Promise<void> {
    const hub = connectionManager.getHubIfConnected();
    if (!hub) return;

    await this.joinSharedSpaceChannel(hub, spaceId);
    if (this.spaceId.value !== spaceId) return;

    this.cleanups.push(
      hub.onEvent<{ spaceId: string; agent: SpaceAgent }>('spaceAgentV2.created', (event) => {
        if (event.spaceId === spaceId) this.upsert(event.agent);
      })
    );
    this.cleanups.push(
      hub.onEvent<{ spaceId: string; agent: SpaceAgent }>('spaceAgentV2.updated', (event) => {
        if (event.spaceId === spaceId) this.upsert(event.agent);
      })
    );
    this.cleanups.push(
      hub.onEvent<{ spaceId: string; agentId: string }>('spaceAgentV2.deleted', (event) => {
        if (event.spaceId === spaceId) this.drop(event.agentId);
      })
    );
    this.subscribedSpaceId = spaceId;
  }

  private async joinSharedSpaceChannel(
    hub: NonNullable<ReturnType<typeof connectionManager.getHubIfConnected>>,
    spaceId: string
  ): Promise<void> {
    await hub.joinChannel(`space:${spaceId}`);
  }

  private releaseHandlers(): void {
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    this.subscribedSpaceId = null;
  }

  teardown(): void {
    this.releaseHandlers();
    this.generation += 1;
    this.spaceId.value = null;
    this.agents.value = [];
    this.reminderCounts.value = {};
    this.error.value = null;
    this.loading.value = false;
  }
}

export const spaceAgentStore = new SpaceAgentStore();
