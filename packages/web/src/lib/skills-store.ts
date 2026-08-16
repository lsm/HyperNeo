/**
 * SkillsStore - Application-level Skills registry with LiveQuery subscriptions
 *
 * ARCHITECTURE: LiveQuery supersedes one-shot skill.list for frontend UI purposes
 * - Initial state: Fetched via LiveQuery snapshot on subscribe
 * - Updates: Real-time via liveQuery.delta events
 * - Reconnect: Re-subscribes with same subscriptionId on hub reconnection
 * - Teardown: Calls liveQuery.unsubscribe to clean up server-side subscription
 *
 * Signal (reactive state):
 * - skills: List of all application-level Skills
 */

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
  /** All application-level Skills */
  readonly skills = signal<AppSkill[]>([]);

  /** Loading state */
  readonly isLoading = signal<boolean>(false);

  /**
   * Flips to `true` the first time the LiveQuery snapshot handler fires and
   * stays true until unsubscribe. Use this (not `skills.length > 0`) when you
   * need to distinguish "the subscription has returned" from "there happen to
   * be zero skills" — e.g. to suppress UI annotations during the initial
   * mount while showing them correctly in the zero-skills steady state.
   */
  readonly loaded = signal<boolean>(false);

  /** Error state — set when subscribe() fails */
  readonly error = signal<string | null>(null);

  /** Cleanup functions registered during subscribe() */
  private cleanups: Array<() => void> = [];

  /**
   * Stale-event guard: set of currently active subscriptionIds.
   * Cleared immediately in unsubscribe() before handler teardown so that
   * any in-flight events (queued in the JS event loop between unsubscribe and
   * handler removal) are discarded rather than applied to the wrong state.
   */
  private activeSubscriptionIds = new Set<string>();

  /** Guard: true once subscribe() has been called and not yet torn down */
  private subscribed = false;

  /** Reference count — incremented by subscribe(), decremented by unsubscribe() */
  private refCount = 0;

  /**
   * Subscribe to the global Skills registry via LiveQuery.
   *
   * Idempotent: safe to call multiple times; subsequent calls are no-ops
   * until unsubscribe() is called.
   *
   * Re-throws errors so callers can handle failures (e.g., show a toast).
   */
  async subscribe(): Promise<void> {
    this.refCount++;
    if (this.subscribed) return;
    this.subscribed = true;

    try {
      const hub = await connectionManager.getHub();

      // Guard: unsubscribe() was called before hub became available
      if (!this.subscribed) return;

      this.isLoading.value = true;
      this.activeSubscriptionIds.add(SUBSCRIPTION_ID);

      // --- Snapshot handler ---
      const unsubSnapshot = hub.onEvent<LiveQuerySnapshotEvent>('liveQuery.snapshot', (event) => {
        if (event.subscriptionId !== SUBSCRIPTION_ID) return;
        if (!this.activeSubscriptionIds.has(SUBSCRIPTION_ID)) return; // stale-event guard
        this.skills.value = event.rows as AppSkill[];
        this.isLoading.value = false;
        // Flip loaded=true on the first snapshot so consumers can tell
        // "we've heard back from the server, there genuinely are zero
        // skills" apart from "we haven't heard back yet."
        this.loaded.value = true;
      });
      this.cleanups.push(unsubSnapshot);
      this.cleanups.push(() => this.activeSubscriptionIds.delete(SUBSCRIPTION_ID));

      // --- Delta handler ---
      const unsubDelta = hub.onEvent<LiveQueryDeltaEvent>('liveQuery.delta', (event) => {
        if (event.subscriptionId !== SUBSCRIPTION_ID) return;
        if (!this.activeSubscriptionIds.has(SUBSCRIPTION_ID)) return; // stale-event guard
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

      // --- Reconnect handler ---
      // Re-subscribe with the same subscriptionId so we get a fresh snapshot
      // after the WebSocket reconnects.
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

      // --- Subscribe to the named query ---
      await hub.request('liveQuery.subscribe', {
        queryName: 'skills.list',
        params: [],
        subscriptionId: SUBSCRIPTION_ID,
      });

      // Guard: abort if unsubscribed while the subscribe request was in flight
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

  /**
   * Run all cleanup functions and reset state — used after subscribe() races
   * with unsubscribe().
   */
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

  /**
   * Unsubscribe and reset state.
   *
   * Calls liveQuery.unsubscribe so the server cleans up the subscription.
   * Safe to call even if subscribe() was never called.
   */
  unsubscribe(): void {
    this.refCount = Math.max(0, this.refCount - 1);
    if (this.refCount > 0) return; // still has other subscribers
    if (!this.subscribed) {
      // Still reset error signal even if we were never subscribed
      // (e.g., subscribe() failed and set this.subscribed = false in its catch block)
      this.error.value = null;
      return;
    }
    this.subscribed = false;

    // Stale-event guard: clear activeSubscriptionIds immediately so any events
    // already queued in the JS event loop are discarded before handlers are removed.
    this.activeSubscriptionIds.delete(SUBSCRIPTION_ID);

    this.teardownCleanly();

    // Tell the server to dispose the subscription.
    const hub = connectionManager.getHubIfConnected();
    if (hub) {
      hub.request('liveQuery.unsubscribe', { subscriptionId: SUBSCRIPTION_ID }).catch(() => {});
    }

    this.skills.value = [];
  }

  // ---------------------------------------------------------------------------
  // Mutation methods — these trigger LiveQuery deltas automatically
  // ---------------------------------------------------------------------------

  /**
   * Add a new skill. The LiveQuery subscription will push the created skill
   * back via a delta event automatically.
   */
  async addSkill(params: CreateSkillParams): Promise<AppSkill> {
    const hub = await connectionManager.getHub();
    const response = await hub.request<{ skill: AppSkill }>('skill.create', { params });
    return response.skill;
  }

  /**
   * Update an existing skill. The LiveQuery subscription will push the updated
   * skill back via a delta event automatically.
   */
  async updateSkill(id: string, params: UpdateSkillParams): Promise<AppSkill> {
    const hub = await connectionManager.getHub();
    const response = await hub.request<{ skill: AppSkill }>('skill.update', { id, params });
    return response.skill;
  }

  /**
   * Remove a skill. The LiveQuery subscription will push the removal
   * back via a delta event automatically.
   */
  async removeSkill(id: string): Promise<boolean> {
    const hub = await connectionManager.getHub();
    const response = await hub.request<{ success: boolean }>('skill.delete', { id });
    return response.success;
  }

  /**
   * Enable or disable a skill. The LiveQuery subscription will push the updated
   * skill back via a delta event automatically.
   */
  async setEnabled(id: string, enabled: boolean): Promise<AppSkill> {
    const hub = await connectionManager.getHub();
    const response = await hub.request<{ skill: AppSkill }>('skill.setEnabled', { id, enabled });
    return response.skill;
  }

  /**
   * Install a skill from a git repository URL. Downloads the skill directory
   * from GitHub (or a raw URL) and registers it as a builtin skill.
   *
   * The LiveQuery subscription will push the new skill back via a delta event.
   */
  async installSkillFromGit(params: InstallSkillFromGitParams): Promise<AppSkill> {
    const hub = await connectionManager.getHub();
    const response = await hub.request<{ skill: AppSkill }>('skill.installFromGit', params);
    return response.skill;
  }
}

/** Singleton store instance */
export const skillsStore = new SkillsStore();
