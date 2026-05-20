import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { MessageHub } from '@neokai/shared';
import { ExternalEventExtensionConfigStore } from '../../../../src/lib/external-events/extension-config-store';
import { ExternalEventExtensionManager } from '../../../../src/lib/external-events/extension-manager';
import type {
	ExternalEventExtensionContext,
	HttpExternalEventExtension,
	RpcExternalEventExtension,
} from '../../../../src/lib/external-events/types';
import { setupExternalEventExtensionHandlers } from '../../../../src/lib/rpc-handlers';
import type { RPCHandlerDependencies } from '../../../../src/lib/rpc-handlers';

type RequestHandler = (data: unknown, context?: unknown) => unknown;

let db: Database;
let configStore: ExternalEventExtensionConfigStore;
let extensionContext: ExternalEventExtensionContext;
let extensionManager: ExternalEventExtensionManager;
let hub: MessageHub;
let handlers: Map<string, RequestHandler>;

beforeEach(() => {
	db = new Database(':memory:');
	configStore = new ExternalEventExtensionConfigStore(db);
	extensionContext = {
		publisher: { publish: async () => ({ outcome: 'published', eventId: 'evt-1' }) },
		config: configStore,
		onSourceConfigChanged() {},
	};
	extensionManager = new ExternalEventExtensionManager();
	const hubMock = createMockHub();
	hub = hubMock.hub;
	handlers = hubMock.handlers;
});

afterEach(() => {
	db.close();
});

describe('external event extension RPC handlers', () => {
	test('lists registered extensions with config and lifecycle status', async () => {
		const extension = createExtension('github');
		extensionManager.register(extension);
		await configStore.setGlobalConfig('github', {
			source: 'github',
			globallyEnabled: true,
			capabilities: { webhooks: true, rpcConfig: true },
		});
		await extensionManager.startExtension('github', extensionContext);
		setupExternalEventExtensionHandlers(makeDeps());

		const result = (await handlers.get('externalEvents.extensions.list')!({})) as {
			extensions: Array<{ source: string; status: string; config: { globallyEnabled: boolean } }>;
		};

		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0]).toMatchObject({
			source: 'github',
			status: 'started',
			config: {
				source: 'github',
				globallyEnabled: true,
				capabilities: { webhooks: true, rpcConfig: true },
			},
		});
	});

	test('toggles global enablement and manages routes, RPC handlers, and lifecycle', async () => {
		const extension = createExtension('github');
		extensionManager.register(extension);
		await configStore.setGlobalConfig('github', {
			source: 'github',
			globallyEnabled: false,
			capabilities: { webhooks: true, rpcConfig: true },
		});
		setupExternalEventExtensionHandlers(makeDeps());

		await handlers.get('externalEvents.extensions.setGlobalEnabled')!({
			source: 'github',
			enabled: true,
		});

		expect(extension.starts).toBe(1);
		expect(extensionManager.isStarted('github')).toBe(true);
		expect(extensionManager.getRegisteredRoutes()).toHaveLength(1);
		expect(handlers.has('github.test')).toBe(true);
		expect((await configStore.getGlobalConfig('github')).globallyEnabled).toBe(true);

		await handlers.get('externalEvents.extensions.setGlobalEnabled')!({
			source: 'github',
			enabled: false,
		});

		expect(extension.stops).toBe(1);
		expect(extensionManager.isStarted('github')).toBe(false);
		expect(extensionManager.getRegisteredRoutes()).toHaveLength(0);
		expect(handlers.has('github.test')).toBe(false);
		expect((await configStore.getGlobalConfig('github')).globallyEnabled).toBe(false);
	});
});

function createMockHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
	const handlers = new Map<string, RequestHandler>();
	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
		onEvent: mock(() => () => {}),
		onClientDisconnect: mock(() => () => {}),
		request: mock(async () => {}),
		event: mock(() => {}),
		joinChannel: mock(async () => {}),
		leaveChannel: mock(async () => {}),
		isConnected: mock(() => true),
		getState: mock(() => 'connected' as const),
		onConnection: mock(() => () => {}),
		onMessage: mock(() => () => {}),
		cleanup: mock(() => {}),
		registerTransport: mock(() => () => {}),
		registerRouter: mock(() => {}),
		getRouter: mock(() => null),
		getPendingCallCount: mock(() => 0),
	} as unknown as MessageHub;
	return { hub, handlers };
}

function createExtension(sourceId: string): TestExtension {
	return {
		sourceId,
		starts: 0,
		stops: 0,
		routes: [
			{
				method: 'POST',
				path: `/${sourceId}/webhook`,
				handle: async () => Response.json({ ok: true }),
			},
		],
		async start() {
			this.starts += 1;
		},
		async stop() {
			this.stops += 1;
		},
		registerRpcHandlers(hubLike) {
			hubLike.onRequest(`${sourceId}.test`, () => ({ ok: true }));
		},
	};
}

interface TestExtension extends HttpExternalEventExtension, RpcExternalEventExtension {
	starts: number;
	stops: number;
}

function makeDeps(): RPCHandlerDependencies {
	return {
		messageHub: hub,
		externalEventExtensionManager: extensionManager,
		externalEventExtensionConfigStore: configStore,
		externalEventExtensionContext: extensionContext,
	} as unknown as RPCHandlerDependencies;
}
