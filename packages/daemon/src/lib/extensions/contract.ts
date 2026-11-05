import { z } from 'zod';
import type { MessageHub } from '@hyperneo/shared';
import type { Database } from '../../storage/sqlite-compat.ts';
import type { WorkAdapter } from '../drivers/types.ts';
import type { WorkChatMatch } from '../../storage/work-chat-search.ts';
import { defineOperation, type OperationDefinition } from '../operations/registry.ts';

export interface DaemonWebRoute {
  path: string;
  label: string;
}

export interface DaemonAdapterHost {
  searchChats(text: string): Promise<readonly WorkChatMatch[]>;
}

export interface DaemonExtension {
  id: string;
  schema?(db: Database): void;
  operations?(): readonly OperationDefinition[];
  rpc?(hub: MessageHub): void;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
  adapters?(host: DaemonAdapterHost): readonly WorkAdapter[];
  webRoutes?: readonly DaemonWebRoute[];
}

export class DaemonExtensions {
  private readonly loaded: DaemonExtension[] = [];

  constructor(
    private readonly db: Database,
    private readonly hub: MessageHub
  ) {}

  register(extension: DaemonExtension): void {
    extension.schema?.(this.db);
    extension.rpc?.(this.hub);
    this.loaded.push(extension);
  }

  operations(): OperationDefinition[] {
    return this.loaded.flatMap((extension) => extension.operations?.() ?? []);
  }

  private readonly built = new Map<DaemonExtension, readonly WorkAdapter[]>();

  adapters(host: DaemonAdapterHost): WorkAdapter[] {
    return this.loaded.flatMap((extension) => {
      const built = this.built.get(extension) ?? extension.adapters?.(host) ?? [];
      this.built.set(extension, built);
      return built;
    });
  }

  manifest(): { extensions: { id: string; webRoutes: DaemonWebRoute[] }[] } {
    return {
      extensions: this.loaded.map(({ id, webRoutes = [] }) => ({ id, webRoutes: [...webRoutes] })),
    };
  }

  async start(): Promise<void> {
    for (const extension of this.loaded) await extension.start?.();
  }

  async stop(): Promise<{ id: string; error: unknown }[]> {
    const failures: { id: string; error: unknown }[] = [];
    for (const extension of [...this.loaded].reverse()) {
      try {
        await extension.stop?.();
      } catch (error) {
        failures.push({ id: extension.id, error });
      }
    }
    return failures;
  }
}

const DaemonExtensionsResultSchema = z.object({
  extensions: z.array(
    z.object({
      id: z.string(),
      webRoutes: z.array(z.object({ path: z.string(), label: z.string() })),
    })
  ),
});

export function createDaemonExtensionsOperation(extensions: DaemonExtensions) {
  return defineOperation({
    name: 'daemon.extensions',
    description:
      'List the extensions loaded in this daemon, each with the web routes it serves. An extension missing from the list is not available here.',
    inputSchema: z.object({}).default({}),
    resultSchema: DaemonExtensionsResultSchema,
    policy: { safetyClass: 'read' },
    execute: async () => extensions.manifest(),
  });
}
