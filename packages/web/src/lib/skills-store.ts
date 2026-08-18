import { signal } from '@preact/signals';
import type {
  AppSkill,
  CreateSkillParams,
  UpdateSkillParams,
  InstallSkillFromGitParams,
  LiveQuerySnapshotEvent,
  LiveQueryDeltaEvent,
} from '@hyperneo/shared';
import { Logger } from '@hyperneo/shared';
import { connectionManager } from './connection-manager';

const logger = new Logger('hyperneo:web:skills-store');

const SUBSCRIPTION_ID = 'skills-global';

class SkillsStore {
  readonly skills = signal<AppSkill[]>([]);

  readonly isLoading = signal<boolean>(false);

  readonly loaded = signal<boolean>(false);

  readonly error = signal<string | null>(null);

  private cleanups: Array<() => void> = [];

  private activeSubscriptionIds = new Set<string>();

  private subscribed = false;

  private refCount = 0;

  async subscribe(): Promise<void> {
    this.refCount++;
    if (this.subscribed) return;
    this.subscribed = true;

    try {
      const hub = await connectionManager.getHub();

      if (!this.subscribed) return;

      this.isLoading.value = true;
      this.activeSubscriptionIds.add(SUBSCRIPTION_ID);

      const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
        if (event.subscriptionId !== SUBSCRIPTION_ID) return;
        if (!this.activeSubscriptionIds.has(SUBSCRIPTION_ID)) return;
        this.skills.value = event.rows as AppSkill[];
        this.isLoading.value = false;
        this.loaded.value = true;
      });
      this.cleanups.push(unsubSnapshot);
      this.cleanups.push(() => this.activeSubscriptionIds.delete(SUBSCRIPTION_ID));

      const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
        if (event.subscriptionId !== SUBSCRIPTION_ID) return;
        if (!this.activeSubscriptionIds.has(SUBSCRIPTION_ID)) return;
        let current = this.skills.value;
        if (event.removed?.length) {
          const removedIds = new Set((event.removed as AppSkill[]).map((r) => r.id));
          current = current.filter((s) => !removedIds.has(s.id));
        }
        if (event.updated?.length) {
          const updatedMap = new Map((event.updated as AppSkill[]).map((u) => [u.id, u]));
          current = current.map((s) => updatedMap.get(s.id) ?? s);
        }
        if (event.added?.length) {
          current = [...current, ...(event.added as AppSkill[])];
        }
        this.skills.value = current;
      });
      this.cleanups.push(unsubDelta);

      const unsubReconnect = hub.onConnection((state) => {
        if (state !== 'connected') return;
        if (!this.activeSubscriptionIds.has(SUBSCRIPTION_ID)) return;
        this.isLoading.value = true;
        hub
          .request('liveQuery.subscribe', {
            queryName: 'skills.list',
            params: [],
            subscriptionId: SUBSCRIPTION_ID,
          })
          .catch((err) => {
            logger.warn('SkillsStore LiveQuery re-subscribe failed:', err);
            this.isLoading.value = false;
          });
      });
      this.cleanups.push(unsubReconnect);

      await hub.request('liveQuery.subscribe', {
        queryName: 'skills.list',
        params: [],
        subscriptionId: SUBSCRIPTION_ID,
      });

      if (!this.subscribed) {
        this.teardownCleanly();
        return;
      }
    } catch (err) {
      this.refCount = Math.max(0, this.refCount - 1);
      this.subscribed = false;
      this.teardownCleanly();
      this.error.value =
        err instanceof Error ? err.message : 'Failed to subscribe to Skills registry';
      logger.error('Failed to subscribe SkillsStore LiveQuery:', err);
      throw err;
    }
  }

  private teardownCleanly(): void {
    this.activeSubscriptionIds.delete(SUBSCRIPTION_ID);
    for (const fn of this.cleanups) {
      try {
        fn();
      } catch {
        /* ignore */
      }
    }
    this.cleanups = [];
    this.isLoading.value = false;
    this.loaded.value = false;
    this.error.value = null;
  }

  unsubscribe(): void {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount > 0) return;
    if (!this.subscribed) {
      this.error.value = null;
      return;
    }
    this.subscribed = false;

    this.activeSubscriptionIds.delete(SUBSCRIPTION_ID);

    this.teardownCleanly();

    const hub = connectionManager.getHubIfConnected();
    if (hub) {
      hub.request('liveQuery.unsubscribe', { subscriptionId: SUBSCRIPTION_ID }).catch(() => {});
    }

    this.skills.value = [];
  }

  async addSkill(params: CreateSkillParams): Promise<AppSkill> {
    const hub = await connectionManager.getHub();
    const response = await hub.request<{ skill: AppSkill }>('skill.create', { params });
    return response.skill;
  }

  async updateSkill(id: string, params: UpdateSkillParams): Promise<AppSkill> {
    const hub = await connectionManager.getHub();
    const response = await hub.request<{ skill: AppSkill }>('skill.update', { id, params });
    return response.skill;
  }

  async removeSkill(id: string): Promise<boolean> {
    const hub = await connectionManager.getHub();
    const response = await hub.request<{ success: boolean }>('skill.delete', { id });
    return response.success;
  }

  async setEnabled(id: string, enabled: boolean): Promise<AppSkill> {
    const hub = await connectionManager.getHub();
    const response = await hub.request<{ skill: AppSkill }>('skill.setEnabled', { id, enabled });
    return response.skill;
  }

  async installSkillFromGit(params: InstallSkillFromGitParams): Promise<AppSkill> {
    const hub = await connectionManager.getHub();
    const response = await hub.request<{ skill: AppSkill }>('skill.installFromGit', params);
    return response.skill;
  }
}

export const skillsStore = new SkillsStore();
