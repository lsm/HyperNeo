import { Database as BunDatabase } from 'bun:sqlite';
import { InProcessTransport, MessageHub } from '@neokai/shared';
import { describe, expect, test } from 'bun:test';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import {
	ExternalEventService,
	ExternalEventStore,
	type ExternalEvent,
} from '../../../../src/lib/external-events';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github';
import {
	mapEventType,
	normalizeGitHubWebhook,
	toExternalEvent,
} from '../../../../src/lib/external-events/github/github-normalizer';
import type {
	ExternalEventExtensionConfigStore,
	SpaceExternalEventSourceConfig,
} from '../../../../src/lib/external-events/types';
import { createDaemonInternalEventBus } from '../../../../src/lib/internal-event-bus';

async function createSignature(payload: string, secret: string): Promise<string> {
	const encoder = new TextEncoder();
	const cryptoKey = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const buffer = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(payload));
	return `sha256=${Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')}`;
}

function setupDb(): BunDatabase {
	const db = new BunDatabase(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	createTables(db);
	runMigrations(db, () => {});
	return db;
}

class StaticExternalEventExtensionConfigStore implements ExternalEventExtensionConfigStore {
	constructor(
		private readonly options: { globallyEnabled?: boolean; webhooks?: boolean; polling?: boolean }
	) {}

	async getGlobalConfig(source: string) {
		return {
			source,
			globallyEnabled: this.options.globallyEnabled ?? true,
			capabilities: {
				webhooks: this.options.webhooks ?? true,
				polling: this.options.polling ?? true,
				rpcConfig: true,
			},
			settings: {},
		};
	}

	async getSpaceConfig(
		spaceId: string,
		source: string
	): Promise<SpaceExternalEventSourceConfig | null> {
		return { spaceId, source, enabled: true, settings: {} };
	}

	async listEnabledSpaces(_source: string): Promise<SpaceExternalEventSourceConfig[]> {
		return [];
	}

	async setGlobalConfig(
		_source: string,
		_config: Awaited<ReturnType<ExternalEventExtensionConfigStore['getGlobalConfig']>>
	): Promise<void> {}

	async setSpaceConfig(
		_spaceId: string,
		_source: string,
		_config: SpaceExternalEventSourceConfig
	): Promise<void> {}
}

const baseRepo = {
	id: 1,
	name: 'widgets',
	full_name: 'Acme/Widgets',
	owner: { login: 'Acme' },
};

function payloadFor(event: string): unknown {
	if (event === 'issue_comment') {
		return {
			action: 'created',
			repository: baseRepo,
			sender: { login: 'bot', type: 'Bot' },
			issue: { number: 7, title: 'PR', pull_request: { url: 'api' } },
			comment: {
				id: 101,
				body: 'looks good',
				html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-101',
				user: { login: 'bot', type: 'Bot' },
				created_at: '2026-01-01T00:00:00Z',
			},
		};
	}
	return {
		action: 'synchronize',
		repository: baseRepo,
		sender: { login: 'dev', type: 'User' },
		pull_request: {
			id: 77,
			number: 7,
			body: 'pr body',
			html_url: 'https://github.com/acme/widgets/pull/7',
			user: { login: 'dev', type: 'User' },
			updated_at: '2026-01-01T00:00:00Z',
		},
	};
}

function webhookRequest(payload: unknown, event: string, signature?: string): Request {
	const headers: Record<string, string> = {
		'X-GitHub-Event': event,
		'X-GitHub-Delivery': 'delivery-1',
	};
	if (signature) headers['X-Hub-Signature-256'] = signature;
	return new Request('http://localhost/webhook/github/space', {
		method: 'POST',
		headers,
		body: JSON.stringify(payload),
	});
}

describe('GitHubEventExtension', () => {
	test('normalizes webhooks and constructs canonical topics', () => {
		const normalized = normalizeGitHubWebhook(
			'issue_comment',
			'delivery-1',
			payloadFor('issue_comment')
		)!;
		expect(normalized.repoOwner).toBe('Acme');
		expect(normalized.repoName).toBe('widgets');
		expect(mapEventType(normalized.eventType, normalized.action, normalized.entityId)).toEqual({
			resource: 'pull_request',
			entityId: '7',
			action: 'comment_created',
		});

		const event = toExternalEvent('space-1', normalized);
		expect(event.topic).toBe('github/acme/widgets/pull_request/7.comment_created');
		expect(event.source).toBe('github');
		expect(event.payload.prNumber).toBe(7);
		expect(event.payload.repoOwner).toBe('acme');
		expect(event.dedupeKey).toBe('acme/widgets:issue_comment:101:created');
	});

	test('webhook verifies signatures, checks enablement, and publishes ExternalEventService event', async () => {
		const db = setupDb();
		db.prepare(
			`INSERT INTO spaces (id, slug, name, workspace_path, status, created_at, updated_at) VALUES ('space-1', 'space-1', 'Space', '/tmp', 'active', 1, 1)`
		).run();
		const bus = createDaemonInternalEventBus();
		const service = new ExternalEventService(new ExternalEventStore(db), bus);
		const received: ExternalEvent[] = [];
		bus.subscribe(
			'externalEvent.published',
			(payload) => {
				received.push({
					id: payload.eventId,
					spaceId: payload.spaceId,
					topic: payload.topic,
					occurredAt: payload.occurredAt,
					ingestedAt: payload.ingestedAt,
					source: payload.source,
					summary: payload.summary,
					externalUrl: payload.externalUrl,
					payload: payload.payload,
					dedupeKey: payload.dedupeKey,
				});
			},
			{ subscriberName: 'github-event-extension-test' }
		);
		const extension = new GitHubEventExtension(db);
		const context = {
			publisher: service,
			config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
			onSourceConfigChanged() {},
		};
		await extension.start(context);
		extension.repo.upsertWatchedRepo({
			spaceId: 'space-1',
			owner: 'acme',
			repo: 'widgets',
			webhookSecret: 'secret',
		});

		const payload = payloadFor('issue_comment');
		const raw = JSON.stringify(payload);
		const ok = await extension.routes[0].handle(
			webhookRequest(payload, 'issue_comment', await createSignature(raw, 'secret'))
		);
		expect(ok.status).toBe(200);
		expect(received).toHaveLength(1);
		expect(received[0].topic).toBe('github/acme/widgets/pull_request/7.comment_created');
		expect(db.prepare('SELECT COUNT(*) AS c FROM space_external_events').get()).toEqual({ c: 1 });

		const duplicate = await extension.routes[0].handle(
			webhookRequest(payload, 'issue_comment', await createSignature(raw, 'secret'))
		);
		expect(duplicate.status).toBe(200);
		expect(db.prepare('SELECT COUNT(*) AS c FROM space_external_events').get()).toEqual({ c: 1 });

		const bad = await extension.routes[0].handle(
			webhookRequest(payload, 'issue_comment', await createSignature(raw, 'wrong'))
		);
		expect(bad.status).toBe(401);

		const missingSignature = await extension.routes[0].handle(
			webhookRequest(payload, 'issue_comment')
		);
		expect(missingSignature.status).toBe(401);

		const otherRepoPayload = {
			...(payload as Record<string, unknown>),
			repository: {
				id: 2,
				name: 'other',
				full_name: 'acme/other',
				owner: { login: 'acme' },
			},
		};
		const otherRaw = JSON.stringify(otherRepoPayload);
		const repoNotWatched = await extension.routes[0].handle(
			webhookRequest(otherRepoPayload, 'issue_comment', await createSignature(otherRaw, 'secret'))
		);
		expect(repoNotWatched.status).toBe(404);

		await extension.stop();
	});

	test('treats omitted webhook capability as enabled', async () => {
		const db = setupDb();
		const published: ExternalEvent[] = [];
		const extension = new GitHubEventExtension(db);
		const context = {
			publisher: { publish: async (event: ExternalEvent) => published.push(event) },
			config: {
				async getGlobalConfig(source: string) {
					return { source, globallyEnabled: true, capabilities: {} };
				},
				async getSpaceConfig(spaceId: string, source: string) {
					return { spaceId, source, enabled: true, settings: {} };
				},
				async listEnabledSpaces() {
					return [];
				},
			},
			onSourceConfigChanged() {},
		};
		await extension.start(context);
		extension.repo.upsertWatchedRepo({
			spaceId: 'space-1',
			owner: 'acme',
			repo: 'widgets',
			webhookSecret: 'secret',
		});

		const payload = payloadFor('issue_comment');
		const raw = JSON.stringify(payload);
		const response = await extension.routes[0].handle(
			webhookRequest(payload, 'issue_comment', await createSignature(raw, 'secret'))
		);

		expect(response.status).toBe(200);
		expect(published).toHaveLength(1);
		await extension.stop();
	});

	test('does not publish when a matched space is disabled', async () => {
		const db = setupDb();
		const published: ExternalEvent[] = [];
		const extension = new GitHubEventExtension(db);
		const context = {
			publisher: { publish: async (event: ExternalEvent) => published.push(event) },
			config: {
				async getGlobalConfig(source: string) {
					return { source, globallyEnabled: true, capabilities: { webhooks: true, polling: true } };
				},
				async getSpaceConfig(spaceId: string, source: string) {
					return { spaceId, source, enabled: false, settings: {} };
				},
				async listEnabledSpaces() {
					return [];
				},
			},
			onSourceConfigChanged() {},
		};
		await extension.start(context);
		extension.repo.upsertWatchedRepo({
			spaceId: 'space-1',
			owner: 'acme',
			repo: 'widgets',
			webhookSecret: 'secret',
		});

		const payload = payloadFor('issue_comment');
		const raw = JSON.stringify(payload);
		const response = await extension.routes[0].handle(
			webhookRequest(payload, 'issue_comment', await createSignature(raw, 'secret'))
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ spaces: 0 });
		expect(published).toHaveLength(0);
		await extension.stop();
	});

	test('RPC disable persists for newly watched repositories', async () => {
		const db = setupDb();
		const extension = new GitHubEventExtension(db);
		const clientHub = new MessageHub();
		const hub = new MessageHub();
		const [clientTransport, serverTransport] = InProcessTransport.createPair();
		clientHub.registerTransport(clientTransport);
		hub.registerTransport(serverTransport);
		await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
		const context = {
			publisher: { publish: async () => {} },
			config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
			onSourceConfigChanged() {},
		};
		await extension.start(context);
		extension.registerRpcHandlers(hub, context);

		await clientHub.request('space.github.disable', { spaceId: 'space-1' });
		await clientHub.request('space.github.watchRepo', {
			spaceId: 'space-1',
			owner: 'acme',
			repo: 'widgets',
			pollingEnabled: true,
		});

		expect(extension.repo.listWatchedRepos('space-1')[0].enabled).toBe(false);
		await extension.stop();
	});

	test('space-scoped pollOnce respects global polling disable', async () => {
		const db = setupDb();
		const extension = new GitHubEventExtension(db);
		const clientHub = new MessageHub();
		const hub = new MessageHub();
		const [clientTransport, serverTransport] = InProcessTransport.createPair();
		clientHub.registerTransport(clientTransport);
		hub.registerTransport(serverTransport);
		await Promise.all([clientTransport.initialize(), serverTransport.initialize()]);
		let publishCount = 0;
		const context = {
			publisher: {
				publish: async () => {
					publishCount++;
				},
			},
			config: new StaticExternalEventExtensionConfigStore({
				globallyEnabled: true,
				polling: false,
			}),
			onSourceConfigChanged() {},
		};
		await extension.start(context);
		extension.registerRpcHandlers(hub, context);
		extension.repo.upsertWatchedRepo({
			spaceId: 'space-1',
			owner: 'acme',
			repo: 'widgets',
			pollingEnabled: true,
		});

		await expect(
			clientHub.request('space.github.pollOnce', { spaceId: 'space-1' })
		).rejects.toThrow('GitHub polling capability is disabled');
		expect(publishCount).toBe(0);
		await extension.stop();
	});

	test('stop waits for an active polling cycle before returning', async () => {
		const db = setupDb();
		const extension = new GitHubEventExtension(db, undefined, { pollIntervalMs: 1 });
		let releaseFetch!: () => void;
		let fetchStarted!: Promise<void>;
		let resolveFetchStarted!: () => void;
		fetchStarted = new Promise((resolve) => {
			resolveFetchStarted = resolve;
		});
		await extension.start({
			publisher: { publish: async () => {} },
			config: new StaticExternalEventExtensionConfigStore({ globallyEnabled: true }),
			onSourceConfigChanged() {},
		});
		extension.repo.upsertWatchedRepo({
			spaceId: 'space-1',
			owner: 'acme',
			repo: 'widgets',
			pollingEnabled: true,
		});

		let blocked = false;
		const pollPromise = extension.pollWatchedRepo(
			extension.repo.listPollingRepos()[0],
			(async () => {
				if (!blocked) {
					blocked = true;
					resolveFetchStarted();
					await new Promise<void>((resolve) => {
						releaseFetch = resolve;
					});
				}
				return new Response(JSON.stringify([]), { status: 200 });
			}) as typeof fetch
		);
		(extension as unknown as { activePollCycle: Promise<void> }).activePollCycle = pollPromise.then(
			() => {}
		);
		await fetchStarted;

		let stopped = false;
		const stopPromise = extension.stop().then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);

		releaseFetch();
		await stopPromise;
		expect(stopped).toBe(true);
	});
});
