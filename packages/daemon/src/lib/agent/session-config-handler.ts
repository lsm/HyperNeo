import { resolveAutoCompactPercent, type Session } from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { Database } from '../../storage/database.ts';
import { SettingsManager } from '../settings-manager.ts';
import { Logger } from '../logger.ts';

export interface SessionConfigHandlerContext {
  readonly session: Session;
  readonly db: Database;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;

  settingsManager: SettingsManager;
  getProcessingState(): { status: string };
  restartQuery(): Promise<{ blocked: boolean }>;
}

export class SessionConfigHandler {
  private logger: Logger;

  constructor(private ctx: SessionConfigHandlerContext) {
    this.logger = new Logger(`SessionConfigHandler ${ctx.session.id}`);
    const pending = ctx.session.metadata.pendingAutoCompactPercent;
    if (pending !== undefined) {
      ctx.session.config = { ...ctx.session.config, autoCompactPercent: pending ?? undefined };
      delete ctx.session.metadata.pendingAutoCompactPercent;
      ctx.db
        .updateSession(ctx.session.id, {
          config: ctx.session.config,
          metadata: ctx.session.metadata,
        })
        .catch((error) => this.logger.error('Failed to persist pending auto-compact:', error));
    }
  }

  async updateConfig(configUpdates: Partial<Session['config']>): Promise<void> {
    const { session, db, internalEventBus } = this.ctx;

    const changes = { ...configUpdates };
    let refresh = false;
    if ('autoCompactPercent' in changes) {
      const percent =
        changes.autoCompactPercent === undefined
          ? undefined
          : resolveAutoCompactPercent(changes.autoCompactPercent);
      if (this.ctx.getProcessingState().status !== 'idle') {
        session.metadata = { ...session.metadata, pendingAutoCompactPercent: percent ?? null };
        delete changes.autoCompactPercent;
      } else {
        refresh = session.config.autoCompactPercent !== percent;
        changes.autoCompactPercent = percent;
        delete session.metadata.pendingAutoCompactPercent;
      }
    }
    session.config = { ...session.config, ...changes };
    await db.updateSession(session.id, {
      config: session.config,
      ...('autoCompactPercent' in configUpdates ? { metadata: session.metadata } : {}),
    });

    await internalEventBus.publish('session.updated', {
      sessionId: session.id,
      source: 'config-update',
      session: { config: session.config },
    });
    if (refresh) await this.ctx.restartQuery();
  }

  async applyPendingAutoCompactPercent(): Promise<boolean> {
    const pending = this.ctx.session.metadata.pendingAutoCompactPercent;
    if (pending === undefined || this.ctx.getProcessingState().status !== 'idle') return false;
    await this.updateConfig({ autoCompactPercent: pending ?? undefined });
    return true;
  }

  applyCommittedInputDraft(text: string | null): void {
    const metadata = { ...this.ctx.session.metadata };
    if (text === null) delete metadata.inputDraft;
    else metadata.inputDraft = text;
    this.ctx.session.metadata = metadata;
  }

  async updateMetadata(updates: Partial<Session>): Promise<void> {
    const { session, db } = this.ctx;

    if (updates.title) session.title = updates.title;

    if (updates.workspacePath !== undefined) {
      session.workspacePath = updates.workspacePath;
      this.ctx.settingsManager = new SettingsManager(db, updates.workspacePath || undefined);
    }

    if (updates.status) session.status = updates.status;

    if (updates.metadata) {
      const mergedMetadata = { ...session.metadata };
      for (const [key, value] of Object.entries(updates.metadata)) {
        if (value === undefined || value === null) {
          delete mergedMetadata[key as keyof typeof mergedMetadata];
        } else {
          (mergedMetadata as Record<string, unknown>)[key] = value;
        }
      }
      session.metadata = mergedMetadata;
    }

    if (updates.config) {
      session.config = { ...session.config, ...updates.config };
    }

    if (updates.archivedAt !== undefined) session.archivedAt = updates.archivedAt;
    if ('worktree' in updates) session.worktree = updates.worktree;
    if ('acpSessionId' in updates) session.acpSessionId = updates.acpSessionId;

    await db.updateSession(session.id, updates);
  }
}
