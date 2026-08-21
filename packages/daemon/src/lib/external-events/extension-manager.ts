import type { MessageHub } from '@hyperneo/shared/message-hub/message-hub.ts';
import type {
  ExternalEventExtension,
  ExternalEventExtensionContext,
  HttpExternalEventExtension,
  Route,
  RpcExternalEventExtension,
} from './types';

export class ExternalEventExtensionManager {
  private extensions = new Map<string, ExternalEventExtension>();
  private started = new Map<string, ExternalEventExtensionContext>();
  private starting = new Map<string, Promise<void>>();
  private stopping = new Map<string, Promise<void>>();
  private routeHandlers: RegisteredRoute[] = [];
  private rpcUnsubscribers = new Map<string, (() => void)[]>();
  private rpcMethodOwners = new Map<string, string>();

  register(extension: ExternalEventExtension): void {
    if (
      !extension.sourceId ||
      extension.sourceId.trim().length === 0 ||
      extension.sourceId !== extension.sourceId.trim()
    ) {
      throw new Error(
        'External event extension sourceId must be non-empty and must not include edge whitespace'
      );
    }
    if (this.extensions.has(extension.sourceId)) {
      throw new Error(`External event extension "${extension.sourceId}" is already registered`);
    }
    this.extensions.set(extension.sourceId, extension);
  }

  unregister(sourceId: string): void {
    if (this.started.has(sourceId) || this.starting.has(sourceId)) {
      throw new Error(`Cannot unregister started external event extension "${sourceId}"`);
    }
    this.unregisterRpcHandlers(sourceId);
    this.routeHandlers = this.routeHandlers.filter((route) => route.sourceId !== sourceId);
    this.extensions.delete(sourceId);
  }

  async startExtension(sourceId: string, context: ExternalEventExtensionContext): Promise<void> {
    const existingStop = this.stopping.get(sourceId);
    if (existingStop) {
      await existingStop;
    }
    if (this.started.has(sourceId)) return;
    const existingStart = this.starting.get(sourceId);
    if (existingStart) {
      await existingStart;
      if (this.started.has(sourceId)) return;
    }

    const startPromise = this.runStartExtension(sourceId, context);
    this.starting.set(sourceId, startPromise);
    try {
      await startPromise;
    } finally {
      this.starting.delete(sourceId);
    }
  }

  async stopExtension(sourceId: string): Promise<void> {
    const existingStop = this.stopping.get(sourceId);
    if (existingStop) {
      await existingStop;
      return;
    }

    const stopPromise = this.runStopExtension(sourceId);
    this.stopping.set(sourceId, stopPromise);
    try {
      await stopPromise;
    } finally {
      this.stopping.delete(sourceId);
    }
  }

  getExtension(sourceId: string): ExternalEventExtension | undefined {
    return this.extensions.get(sourceId);
  }

  getAll(): ExternalEventExtension[] {
    return Array.from(this.extensions.values());
  }

  isStarted(sourceId: string): boolean {
    return this.started.has(sourceId);
  }

  registerRoutes(routes: readonly Route[], context: ExternalEventExtensionContext): void {
    const sourceId = this.findSourceIdForRoutes(routes);
    if (!sourceId) {
      throw new Error(
        'Cannot infer external event route owner: route signatures do not match a registered source'
      );
    }
    this.unregisterRoutes(sourceId);
    for (const route of routes) {
      this.routeHandlers.push({
        sourceId,
        method: route.method,
        path: route.path,
        handle: (req) => route.handle(req, context),
      });
    }
  }

  registerRpcHandlers(
    sourceId: string,
    hub: MessageHub,
    context: ExternalEventExtensionContext
  ): void {
    this.unregisterRpcHandlers(sourceId);
    const extension = this.getRequiredExtension(sourceId);
    if (!isRpcExtension(extension)) {
      throw new Error(`External event extension "${sourceId}" does not expose RPC handlers`);
    }

    const unsubscribers: (() => void)[] = [];
    const registeredMethods: string[] = [];
    const trackingHub = new Proxy(hub, {
      get: (target, prop, receiver) => {
        if (prop !== 'onRequest') {
          return Reflect.get(target, prop, receiver);
        }
        return (method: string, handler: Parameters<MessageHub['onRequest']>[1]) => {
          const owner = this.rpcMethodOwners.get(method);
          if (owner && owner !== sourceId) {
            throw new Error(
              `Cannot register external event RPC handler "${method}" for "${sourceId}": ` +
                `already registered by "${owner}"`
            );
          }
          const unsubscribe = target.onRequest(method, handler);
          this.rpcMethodOwners.set(method, sourceId);
          registeredMethods.push(method);
          unsubscribers.push(unsubscribe);
          return unsubscribe;
        };
      },
    });
    try {
      extension.registerRpcHandlers(trackingHub, context);
    } catch (error) {
      for (const unsubscribe of unsubscribers) {
        unsubscribe();
      }
      for (const method of registeredMethods) {
        this.rpcMethodOwners.delete(method);
      }
      throw error;
    }
    this.rpcUnsubscribers.set(sourceId, unsubscribers);
  }

  getRegisteredRoutes(): readonly RegisteredRoute[] {
    return this.routeHandlers;
  }

  private async runStartExtension(
    sourceId: string,
    context: ExternalEventExtensionContext
  ): Promise<void> {
    if (this.started.has(sourceId)) return;
    const extension = this.getRequiredExtension(sourceId);
    const globalConfig = await context.config.getGlobalConfig(sourceId);
    if (!globalConfig.globallyEnabled) return;
    await extension.start(context);
    this.started.set(sourceId, context);
  }

  private async runStopExtension(sourceId: string): Promise<void> {
    const inFlightStart = this.starting.get(sourceId);
    if (inFlightStart) {
      try {
        await inFlightStart;
      } catch {}
    }

    const extension = this.extensions.get(sourceId);
    if (!extension || !this.started.has(sourceId)) return;
    try {
      await extension.stop();
    } finally {
      this.started.delete(sourceId);
      this.unregisterRpcHandlers(sourceId);
      this.unregisterRoutes(sourceId);
    }
  }

  private getRequiredExtension(sourceId: string): ExternalEventExtension {
    const extension = this.extensions.get(sourceId);
    if (!extension) {
      throw new Error(`External event extension "${sourceId}" is not registered`);
    }
    return extension;
  }

  private unregisterRpcHandlers(sourceId: string): void {
    const unsubscribers = this.rpcUnsubscribers.get(sourceId) ?? [];
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
    this.rpcUnsubscribers.delete(sourceId);
    for (const [method, owner] of this.rpcMethodOwners) {
      if (owner === sourceId) {
        this.rpcMethodOwners.delete(method);
      }
    }
  }

  private unregisterRoutes(sourceId: string): void {
    this.routeHandlers = this.routeHandlers.filter((route) => route.sourceId !== sourceId);
  }

  private findSourceIdForRoutes(routes: readonly Route[]): string | undefined {
    const identityMatchingSourceIds: string[] = [];
    for (const extension of this.extensions.values()) {
      if (isHttpExtension(extension) && extension.routes === routes) {
        identityMatchingSourceIds.push(extension.sourceId);
      }
    }
    if (identityMatchingSourceIds.length > 1) {
      throw new Error(
        `Cannot infer external event route owner: route array is shared by multiple sources ` +
          `(${identityMatchingSourceIds.join(', ')}). Each extension must expose a distinct routes array.`
      );
    }
    if (identityMatchingSourceIds.length === 1) {
      return identityMatchingSourceIds[0];
    }

    const matchingSourceIds: string[] = [];
    for (const extension of this.extensions.values()) {
      if (!isHttpExtension(extension)) continue;
      if (routesMatch(extension.routes, routes)) {
        matchingSourceIds.push(extension.sourceId);
      }
    }

    if (matchingSourceIds.length > 1) {
      throw new Error(
        `Cannot infer external event route owner: route signatures match multiple sources ` +
          `(${matchingSourceIds.join(', ')}). Pass the registered extension.routes array directly.`
      );
    }
    return matchingSourceIds[0];
  }
}

export interface RegisteredRoute {
  readonly sourceId: string;
  readonly method: Route['method'];
  readonly path: string;
  handle(req: Request): Promise<Response>;
}

function routesMatch(left: readonly Route[], right: readonly Route[]): boolean {
  if (left.length !== right.length) return false;
  const unmatched = right.map(routeSignature);
  for (const route of left) {
    const matchIndex = unmatched.indexOf(routeSignature(route));
    if (matchIndex === -1) return false;
    unmatched.splice(matchIndex, 1);
  }
  return unmatched.length === 0;
}

function routeSignature(route: Route): string {
  return `${route.method} ${route.path}`;
}

export function isHttpExtension(
  extension: ExternalEventExtension
): extension is HttpExternalEventExtension {
  return 'routes' in extension && Array.isArray((extension as { routes?: unknown }).routes);
}

export function isRpcExtension(
  extension: ExternalEventExtension
): extension is RpcExternalEventExtension {
  return typeof (extension as { registerRpcHandlers?: unknown }).registerRpcHandlers === 'function';
}
