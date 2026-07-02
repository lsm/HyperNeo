/**
 * InternalCommandBus — Semantic daemon command primitive (v1)
 *
 * First-class facade for typed internal commands with explicit one-handler-per-command
 * semantics.  Commands are requests to do work, not facts.
 *
 * Design constraints (v1)
 * -----------------------
 * • One owner/handler per command — duplicate registration is rejected.
 * • No middleware — cross-cutting concerns stay explicit in handlers.
 * • Structured results — every dispatch returns a `CommandResult`.
 * • Typed command map — domain code defines commands through a `TCommandMap`.
 *
 * Future direction
 * ----------------
 * See docs/plans/internal-event-command-query-architecture.md for the full
 * internal-event / command / query architecture plan.
 */

/**
 * Structured result returned by every command dispatch.
 */
export interface CommandResult {
  /** Whether the command handler completed successfully. */
  ok: boolean;

  /** Error payload when `ok` is false. */
  error?: unknown;

  /** Arbitrary metadata the handler may attach (timings, ids, etc). */
  metadata?: Record<string, unknown>;
}

/**
 * Thrown when a command handler is registered for a name that already
 * has an owner.
 */
export class DuplicateCommandHandlerError extends Error {
  constructor(public readonly commandName: string) {
    super(`Command '${commandName}' already has a registered handler`);
    this.name = 'DuplicateCommandHandlerError';
  }
}

/**
 * Thrown when `dispatch(...)` is called for a command with no registered handler.
 */
export class MissingCommandHandlerError extends Error {
  constructor(public readonly commandName: string) {
    super(`No handler registered for command '${commandName}'`);
    this.name = 'MissingCommandHandlerError';
  }
}

export type CommandHandler<TCommand> = (command: TCommand) => Promise<CommandResult>;

interface RegisteredCommandHandler {
  handler: (command: unknown) => Promise<CommandResult>;
}

/**
 * InternalCommandBus
 *
 * @template TCommandMap — map of dot-separated command names to payload shapes.
 */
export class InternalCommandBus<TCommandMap extends object = Record<string, unknown>> {
  private handlers = new Map<string, RegisteredCommandHandler>();

  /**
   * Register a handler for a command.
   *
   * @param commandName — typed command name
   * @param handler     — callback invoked when the command is dispatched
   * @returns unsubscribe function
   * @throws DuplicateCommandHandlerError if a handler already exists for this command
   */
  register<K extends keyof TCommandMap & string>(
    commandName: K,
    handler: CommandHandler<TCommandMap[K]>
  ): () => void {
    const key = commandName;

    if (this.handlers.has(key)) {
      throw new DuplicateCommandHandlerError(key);
    }

    const registered: RegisteredCommandHandler = {
      handler: handler as (command: unknown) => Promise<CommandResult>,
    };

    this.handlers.set(key, registered);

    return () => {
      const current = this.handlers.get(key);
      if (current === registered) {
        this.handlers.delete(key);
      }
    };
  }

  /**
   * Dispatch a command to its registered handler and await the result.
   *
   * @param commandName — typed command name
   * @param command     — command payload
   * @returns structured `CommandResult`
   * @throws MissingCommandHandlerError if no handler is registered
   */
  async dispatch<K extends keyof TCommandMap & string>(
    commandName: K,
    command: TCommandMap[K]
  ): Promise<CommandResult> {
    const key = commandName;
    const registered = this.handlers.get(key);

    if (!registered) {
      throw new MissingCommandHandlerError(key);
    }

    try {
      return await registered.handler(command);
    } catch (error) {
      return { ok: false, error };
    }
  }

  /**
   * Return true if a handler is registered for the given command name.
   */
  hasHandler<K extends keyof TCommandMap & string>(commandName: K): boolean {
    return this.handlers.has(commandName);
  }

  /**
   * Remove the handler for a specific command.
   */
  unregister<K extends keyof TCommandMap & string>(commandName: K): void {
    this.handlers.delete(commandName);
  }

  /**
   * Remove all handlers.
   */
  clear(): void {
    this.handlers.clear();
  }

  /**
   * Return the number of registered handlers.
   */
  getHandlerCount(): number {
    return this.handlers.size;
  }
}

/**
 * Convenience factory that produces an InternalCommandBus typed with the
 * caller's command map.
 *
 * This is the entry point most daemon code should use:
 *
 *   import { createInternalCommandBus } from '@hyperneo/daemon/lib/internal-command-bus';
 *   const bus = createInternalCommandBus<MyCommandMap>();
 */
export function createInternalCommandBus<
  TCommandMap extends object = Record<string, unknown>,
>(): InternalCommandBus<TCommandMap> {
  return new InternalCommandBus<TCommandMap>();
}

// ---------------------------------------------------------------------------
// Command contracts — canonical payloads for commands used across the daemon.
// Expand this map as new commands are added; keep each domain's commands
// in a separate interface and intersect them here.
// ---------------------------------------------------------------------------

/**
 * Payload for `agent.message.inject` — inject a message into an agent session.
 */
export interface AgentMessageInjectCommand {
  /** Target session ID. */
  sessionId: string;

  /** Message content to inject (usually a formatted agent envelope). */
  message: string;

  /** Delivery strategy for busy/idle session handling. */
  deliveryMode?: 'immediate' | 'defer';

  /** Optional metadata for routing diagnostics. */
  metadata?: Record<string, unknown>;
}

/**
 * Canonical daemon command map.
 *
 * Each domain should own its slice; this type is the intersection of all
 * domain command maps so the bus can be typed with the full surface.
 */
export interface DaemonCommandMap {
  'agent.message.inject': AgentMessageInjectCommand;
}
