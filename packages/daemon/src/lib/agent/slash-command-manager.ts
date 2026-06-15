/**
 * SlashCommandManager - Manages slash command caching
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * Handles:
 * - Fetching slash commands from SDK
 * - Caching and persisting to database
 * - Combining SDK commands with built-in commands
 */

import type { Session } from '@neokai/shared';
import type { QueryLike } from './query-like';
import type { SlashCommand } from '@neokai/shared/sdk';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Database } from '../../storage/database';
import type { Logger } from '../logger';
import { getBuiltInCommandNames } from '../built-in-commands';

/**
 * Context interface - what SlashCommandManager needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface SlashCommandManagerContext {
  readonly session: Session;
  readonly db: Database;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  readonly logger: Logger;

  // Query state
  readonly queryObject: QueryLike | null;
}

/**
 * Manages slash command fetching and caching
 */
export class SlashCommandManager {
  private slashCommands: string[] = [];
  private commandsFetchedFromSDK = false;

  constructor(private ctx: SlashCommandManagerContext) {
    // Restore from session if available — validate it's a real array, not a
    // corrupted string (old sessions may have "merge-session" stored as a
    // JSON-encoded string rather than a JSON-encoded array).
    const stored = ctx.session.availableCommands;
    if (Array.isArray(stored) && stored.length > 0) {
      this.slashCommands = stored;
    }
  }

  /**
   * Get available slash commands
   */
  async getSlashCommands(): Promise<string[]> {
    const { logger, queryObject } = this.ctx;

    // Return cached commands if available
    if (this.slashCommands.length > 0) {
      // Fire-and-forget: refresh from SDK in background
      if (!this.commandsFetchedFromSDK && queryObject) {
        this.fetchAndCache().catch((e) => {
          logger.warn('Background refresh of slash commands failed:', e);
        });
      }
      return this.slashCommands;
    }

    // Try to fetch from SDK
    await this.fetchAndCache();

    // Fallback to built-in commands
    if (this.slashCommands.length === 0) {
      this.slashCommands = getBuiltInCommandNames();
    }

    return this.slashCommands;
  }

  /**
   * Update commands from the SDK system init message.
   * This is the most reliable source — fires immediately on every query start
   * and contains all built-in commands plus custom skills.
   */
  async updateFromInit(sdkCommands: string[]): Promise<void> {
    if (this.commandsFetchedFromSDK) return;

    const { session, db, internalEventBus } = this.ctx;

    const kaiBuiltInCommands = getBuiltInCommandNames();
    const allCommands = [...new Set([...sdkCommands, ...kaiBuiltInCommands])];

    this.slashCommands = allCommands;
    this.commandsFetchedFromSDK = true;

    session.availableCommands = this.slashCommands;
    db.updateSession(session.id, { availableCommands: this.slashCommands });

    await internalEventBus.publish('commands.updated', {
      sessionId: session.id,
      commands: this.slashCommands,
    });
  }

  /**
   * Fetch and cache slash commands from SDK
   */
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
      const commandNames = commands.map((cmd: SlashCommand) => cmd.name);

      // Add SDK built-in commands
      const sdkBuiltInCommands = ['clear', 'help'];
      // Add NeoKai built-in commands
      const kaiBuiltInCommands = getBuiltInCommandNames();
      const allCommands = [
        ...new Set([...commandNames, ...sdkBuiltInCommands, ...kaiBuiltInCommands]),
      ];

      this.slashCommands = allCommands;
      this.commandsFetchedFromSDK = true;

      // Save to database
      session.availableCommands = this.slashCommands;
      db.updateSession(session.id, { availableCommands: this.slashCommands });

      // Emit event
      await internalEventBus.publish('commands.updated', {
        sessionId: session.id,
        commands: this.slashCommands,
      });
    } catch (error) {
      logger.warn('Failed to fetch slash commands:', error);
    }
  }
}
