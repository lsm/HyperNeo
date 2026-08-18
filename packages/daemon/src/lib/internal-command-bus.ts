export interface CommandResult {
  ok: boolean;

  error?: unknown;

  metadata?: Record<string, unknown>;
}

export class DuplicateCommandHandlerError extends Error {
  constructor(public readonly commandName: string) {
    super(`Command '${commandName}' already has a registered handler`);
    this.name = 'DuplicateCommandHandlerError';
  }
}

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

export class InternalCommandBus<TCommandMap extends object = Record<string, unknown>> {
  private handlers = new Map<string, RegisteredCommandHandler>();

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

  hasHandler<K extends keyof TCommandMap & string>(commandName: K): boolean {
    return this.handlers.has(commandName);
  }

  unregister<K extends keyof TCommandMap & string>(commandName: K): void {
    this.handlers.delete(commandName);
  }

  clear(): void {
    this.handlers.clear();
  }

  getHandlerCount(): number {
    return this.handlers.size;
  }
}

export function createInternalCommandBus<
  TCommandMap extends object = Record<string, unknown>,
>(): InternalCommandBus<TCommandMap> {
  return new InternalCommandBus<TCommandMap>();
}

export interface AgentMessageInjectCommand {
  sessionId: string;

  message: string;

  deliveryMode?: 'immediate' | 'defer';

  metadata?: Record<string, unknown>;
}

export interface DaemonCommandMap {
  'agent.message.inject': AgentMessageInjectCommand;
}
