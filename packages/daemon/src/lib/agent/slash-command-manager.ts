import type { Session } from '@hyperneo/shared';
import type { QueryLike } from './query-like';
import { flattenSDKSlashCommands, type SlashCommand } from '@hyperneo/shared/sdk';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Database } from '../../storage/database';
import type { Logger } from '../logger';
import { getBuiltInCommandNames } from '../built-in-commands';

export interface SlashCommandManagerContext {
  readonly session: Session;
  readonly db: Database;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  readonly logger: Logger;

  readonly queryObject: QueryLike | null;
}

export class SlashCommandManager {
  private slashCommands: string[] = [];
  private commandsFetchedFromSDK = false;
  private commandsRestoredFromDb = false;
  private commandsChangedSinceInit = false;

  constructor(private ctx: SlashCommandManagerContext) {
    const stored = ctx.session.availableCommands;
    if (Array.isArray(stored) && stored.length > 0) {
      this.slashCommands = stored;
      this.commandsRestoredFromDb = true;
    }
  }

  async getSlashCommands(): Promise<string[]> {
    const { logger, queryObject } = this.ctx;

    if (this.slashCommands.length > 0) {
      if (!this.commandsFetchedFromSDK && !this.commandsRestoredFromDb && queryObject) {
        this.fetchAndCache().catch((e) => {
          logger.warn('Background refresh of slash commands failed:', e);
        });
      }
      return this.slashCommands;
    }

    await this.fetchAndCache();

    if (this.slashCommands.length === 0) {
      this.slashCommands = getBuiltInCommandNames();
    }

    return this.slashCommands;
  }

  async updateFromInit(sdkCommands: string[]): Promise<void> {
    if (this.commandsFetchedFromSDK && !this.commandsChangedSinceInit) return;

    const { session, db, internalEventBus } = this.ctx;

    const kaiBuiltInCommands = getBuiltInCommandNames();
    const allCommands = [...new Set([...sdkCommands, ...kaiBuiltInCommands])];

    this.slashCommands = allCommands;
    this.commandsFetchedFromSDK = true;
    this.commandsRestoredFromDb = false;
    this.commandsChangedSinceInit = false;

    session.availableCommands = this.slashCommands;
    db.updateSession(session.id, { availableCommands: this.slashCommands });

    await internalEventBus.publish('commands.updated', {
      sessionId: session.id,
      commands: this.slashCommands,
    });
  }

  async updateFromCommandsChanged(sdkCommands: string[]): Promise<void> {
    const { session, db, internalEventBus } = this.ctx;

    const kaiBuiltInCommands = getBuiltInCommandNames();
    const allCommands = [...new Set([...sdkCommands, ...kaiBuiltInCommands])];

    this.slashCommands = allCommands;
    this.commandsFetchedFromSDK = true;
    this.commandsRestoredFromDb = false;
    this.commandsChangedSinceInit = true;

    session.availableCommands = this.slashCommands;
    db.updateSession(session.id, { availableCommands: this.slashCommands });

    await internalEventBus.publish('commands.updated', {
      sessionId: session.id,
      commands: this.slashCommands,
    });
  }

  async fetchAndCache(): Promise<void> {
    const { session, db, internalEventBus, logger, queryObject } = this.ctx;

    if (!queryObject || typeof queryObject.supportedCommands !== 'function') {
      return;
    }

    if (this.commandsFetchedFromSDK) {
      return;
    }

    try {
      const commands = await queryObject.supportedCommands();
      const commandNames = flattenSDKSlashCommands(commands as SlashCommand[]);

      const sdkBuiltInCommands = ['clear', 'help'];
      const kaiBuiltInCommands = getBuiltInCommandNames();
      const allCommands = [
        ...new Set([...commandNames, ...sdkBuiltInCommands, ...kaiBuiltInCommands]),
      ];

      this.slashCommands = allCommands;
      this.commandsFetchedFromSDK = true;

      session.availableCommands = this.slashCommands;
      db.updateSession(session.id, { availableCommands: this.slashCommands });

      await internalEventBus.publish('commands.updated', {
        sessionId: session.id,
        commands: this.slashCommands,
      });
    } catch (error) {
      logger.warn('Failed to fetch slash commands:', error);
    }
  }
}
