export interface QueryResult<T = unknown> {
  ok: boolean;

  data?: T;

  error?: unknown;
}

export class DuplicateQueryHandlerError extends Error {
  constructor(public readonly queryName: string) {
    super(`Query '${queryName}' already has a registered handler`);
    this.name = 'DuplicateQueryHandlerError';
  }
}

export class MissingQueryHandlerError extends Error {
  constructor(public readonly queryName: string) {
    super(`No handler registered for query '${queryName}'`);
    this.name = 'MissingQueryHandlerError';
  }
}

export type QueryHandler<TInput, TOutput> = (query: TInput) => Promise<TOutput>;

interface RegisteredQueryHandler {
  handler: (query: unknown) => Promise<unknown>;
}

type QueryInput<TQueryMap, K extends keyof TQueryMap> = TQueryMap[K] extends {
  input: infer I;
}
  ? I
  : never;

type QueryOutput<TQueryMap, K extends keyof TQueryMap> = TQueryMap[K] extends {
  output: infer O;
}
  ? O
  : never;

export class InternalQueryBus<
  TQueryMap extends object = Record<string, { input: unknown; output: unknown }>,
> {
  private handlers = new Map<string, RegisteredQueryHandler>();

  register<K extends keyof TQueryMap & string>(
    queryName: K,
    handler: QueryHandler<QueryInput<TQueryMap, K>, QueryOutput<TQueryMap, K>>
  ): () => void {
    const key = queryName;

    if (this.handlers.has(key)) {
      throw new DuplicateQueryHandlerError(key);
    }

    const registered: RegisteredQueryHandler = {
      handler: handler as (query: unknown) => Promise<unknown>,
    };

    this.handlers.set(key, registered);

    return () => {
      const current = this.handlers.get(key);
      if (current === registered) {
        this.handlers.delete(key);
      }
    };
  }

  async execute<K extends keyof TQueryMap & string>(
    queryName: K,
    query: QueryInput<TQueryMap, K>
  ): Promise<QueryResult<QueryOutput<TQueryMap, K>>> {
    const key = queryName;
    const registered = this.handlers.get(key);

    if (!registered) {
      return { ok: false, error: new MissingQueryHandlerError(key) };
    }

    try {
      const data = (await registered.handler(query)) as QueryOutput<TQueryMap, K>;
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error };
    }
  }

  hasHandler<K extends keyof TQueryMap & string>(queryName: K): boolean {
    return this.handlers.has(queryName);
  }

  unregister<K extends keyof TQueryMap & string>(queryName: K): void {
    this.handlers.delete(queryName);
  }

  clear(): void {
    this.handlers.clear();
  }

  getHandlerCount(): number {
    return this.handlers.size;
  }
}

export function createInternalQueryBus<
  TQueryMap extends object = Record<string, { input: unknown; output: unknown }>,
>(): InternalQueryBus<TQueryMap> {
  return new InternalQueryBus<TQueryMap>();
}

export interface SpaceWorkflowRunGetQuery {
  runId: string;
}

export interface SpaceWorkflowRunGetResult {
  run: Record<string, unknown> | null;
}

export interface RoomTasksListQuery {
  roomId: string;
  includeArchived?: boolean;
}

export interface RoomTasksListResult {
  tasks: Array<Record<string, unknown>>;
}

export interface DaemonQueryMap {
  'space.workflowRun.get': { input: SpaceWorkflowRunGetQuery; output: SpaceWorkflowRunGetResult };
  'room.tasks.list': { input: RoomTasksListQuery; output: RoomTasksListResult };
}
