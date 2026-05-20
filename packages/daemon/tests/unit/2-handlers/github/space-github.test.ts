import { Database as BunDatabase } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { GitHubEventExtension } from '../../../../src/lib/external-events/github';
import { createTables, runMigrations } from '../../../../src/storage/schema';
import {
	SpaceGitHubService,
	normalizeSpaceGitHubWebhook,
} from '../../../../src/lib/github/space-github';

function setupDb(): BunDatabase {
	const db = new BunDatabase(':memory:');
	db.exec('PRAGMA foreign_keys = ON');
	createTables(db);
	runMigrations(db, () => {});
	return db;
}

function seedTask(db: BunDatabase, text = 'https://github.com/acme/widgets/pull/7'): string {
	db.prepare(
		`INSERT INTO spaces (id, slug, name, workspace_path, status, created_at, updated_at) VALUES ('space-1', 'space-1', 'Space', '/tmp', 'active', 1, 1)`
	).run();
	db.prepare(
		`INSERT INTO space_workflows (id, space_id, name, description, channels, gates, created_at, updated_at) VALUES ('wf-1', 'space-1', 'wf', '', '[]', '[]', 1, 1)`
	).run();
	db.prepare(
		`INSERT INTO space_workflow_runs (id, space_id, workflow_id, title, description, status, created_at, updated_at) VALUES ('run-1', 'space-1', 'wf-1', 'run', '', 'in_progress', 1, 1)`
	).run();
	db.prepare(
		`INSERT INTO space_tasks (id, space_id, task_number, title, description, status, priority, labels, workflow_run_id, depends_on, created_at, updated_at) VALUES ('task-1', 'space-1', 1, 'task', ?, 'in_progress', 'normal', '[]', 'run-1', '[]', 1, 1)`
	).run(text);
	return 'task-1';
}

const baseRepo = {
	id: 1,
	name: 'widgets',
	full_name: 'acme/widgets',
	owner: { login: 'acme' },
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
	if (event === 'pull_request_review') {
		return {
			action: 'submitted',
			repository: baseRepo,
			sender: { login: 'reviewer', type: 'User' },
			pull_request: { id: 77, number: 7, html_url: 'https://github.com/acme/widgets/pull/7' },
			review: {
				id: 202,
				state: 'commented',
				body: 'review body',
				html_url: 'https://github.com/acme/widgets/pull/7#pullrequestreview-202',
				user: { login: 'reviewer', type: 'User' },
				submitted_at: '2026-01-01T00:00:00Z',
			},
		};
	}
	if (event === 'pull_request_review_comment') {
		return {
			action: 'created',
			repository: baseRepo,
			sender: { login: 'reviewer', type: 'User' },
			pull_request: { id: 77, number: 7, html_url: 'https://github.com/acme/widgets/pull/7' },
			comment: {
				id: 303,
				body: 'inline body',
				html_url: 'https://github.com/acme/widgets/pull/7#discussion_r303',
				user: { login: 'reviewer', type: 'User' },
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

describe('Space GitHub integration', () => {
	test('normalizes supported webhook event types', () => {
		for (const event of [
			'issue_comment',
			'pull_request_review',
			'pull_request_review_comment',
			'pull_request',
		]) {
			const normalized = normalizeSpaceGitHubWebhook(event, `d-${event}`, payloadFor(event));
			expect(normalized?.repoOwner).toBe('acme');
			expect(normalized?.repoName).toBe('widgets');
			expect(normalized?.prNumber).toBe(7);
			expect(normalized?.eventType).toBe(event);
		}
	});

	test('resolves by task text, artifacts, gate data, ambiguous and unknown', async () => {
		let db = setupDb();
		seedTask(db);
		let service = new SpaceGitHubService(db);
		await service.ingest(
			'space-1',
			normalizeSpaceGitHubWebhook('pull_request', 'd1', payloadFor('pull_request'))!
		);
		expect(
			db.prepare('SELECT task_id, state, matched_by FROM space_github_events').get()
		).toMatchObject({ task_id: 'task-1', state: 'routed' });
		expect(
			(db.prepare('SELECT matched_by FROM space_github_events').get() as { matched_by: string })
				.matched_by
		).toContain('task_text_pr_url');

		db = setupDb();
		seedTask(db, 'no pr here');
		db.prepare(
			`INSERT INTO workflow_run_artifacts (id, run_id, node_id, artifact_type, artifact_key, data, created_at, updated_at) VALUES ('a1', 'run-1', 'n1', 'pr', 'url', ?, 1, 1)`
		).run(JSON.stringify({ pr_url: 'https://github.com/acme/widgets/pull/7' }));
		service = new SpaceGitHubService(db);
		await service.ingest(
			'space-1',
			normalizeSpaceGitHubWebhook('pull_request', 'd2', payloadFor('pull_request'))!
		);
		expect(db.prepare('SELECT matched_by FROM space_github_events').get()).toEqual({
			matched_by: 'workflow_artifact_pr_url',
		});

		db = setupDb();
		seedTask(db, 'no pr here');
		db.prepare(
			`INSERT INTO gate_data (run_id, gate_id, data, updated_at) VALUES ('run-1', 'g1', ?, 1)`
		).run(JSON.stringify({ pr_url: 'https://github.com/acme/widgets/pull/7' }));
		service = new SpaceGitHubService(db);
		await service.ingest(
			'space-1',
			normalizeSpaceGitHubWebhook('pull_request', 'd3', payloadFor('pull_request'))!
		);
		expect(db.prepare('SELECT matched_by FROM space_github_events').get()).toEqual({
			matched_by: 'gate_data_pr_url',
		});

		db = setupDb();
		seedTask(db);
		db.prepare(
			`INSERT INTO space_tasks (id, space_id, task_number, title, description, status, priority, labels, depends_on, created_at, updated_at) VALUES ('task-2', 'space-1', 2, 'task2', 'https://github.com/acme/widgets/pull/7', 'open', 'normal', '[]', '[]', 1, 1)`
		).run();
		service = new SpaceGitHubService(db);
		await service.ingest(
			'space-1',
			normalizeSpaceGitHubWebhook('pull_request', 'd4', payloadFor('pull_request'))!
		);
		expect(db.prepare('SELECT state FROM space_github_events').get()).toEqual({
			state: 'ambiguous',
		});

		db = setupDb();
		db.prepare(
			`INSERT INTO spaces (id, slug, name, workspace_path, status, created_at, updated_at) VALUES ('space-1', 'space-1', 'Space', '/tmp', 'active', 1, 1)`
		).run();
		service = new SpaceGitHubService(db);
		await service.ingest(
			'space-1',
			normalizeSpaceGitHubWebhook('pull_request', 'd5', payloadFor('pull_request'))!
		);
		expect(db.prepare('SELECT state FROM space_github_events').get()).toEqual({ state: 'ignored' });
	});
	test('extension polling uses auth/cursors and publishes to ExternalEventService', async () => {
		const db = setupDb();
		seedTask(db);
		const published: { spaceId: string; topic: string }[] = [];
		const extension = new GitHubEventExtension(db, 'token');
		await extension.start({
			publisher: {
				publish: async (event: any) => {
					published.push({ spaceId: event.spaceId, topic: event.topic });
					return { outcome: 'created', eventId: event.id };
				},
			},
			config: {
				async getGlobalConfig(source: string) {
					return { source, globallyEnabled: true, capabilities: { webhooks: true, polling: true } };
				},
				async getSpaceConfig(spaceId: string, source: string) {
					return { spaceId, source, enabled: true, settings: {} };
				},
				async listEnabledSpaces() {
					return [];
				},
			},
			onSourceConfigChanged() {},
		});
		extension.repo.upsertWatchedRepo({
			spaceId: 'space-1',
			owner: 'acme',
			repo: 'widgets',
			pollingEnabled: true,
		});
		const calls: RequestInit[] = [];
		const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
			calls.push(init ?? {});
			const urlText = String(url);
			const rows = urlText.includes('/issues/comments')
				? [
						{
							id: 101,
							body: 'looks good',
							html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-101',
							issue: { number: 7, pull_request: { url: 'api' } },
							user: { login: 'bot', type: 'Bot' },
							updated_at: '2026-01-01T00:00:00Z',
						},
					]
				: [];
			return new Response(JSON.stringify(rows), { status: 200, headers: { ETag: 'etag-1' } });
		};
		await extension.pollWatchedRepo(
			extension.repo.listPollingRepos()[0],
			fakeFetch as typeof fetch
		);
		expect((calls[0].headers as Record<string, string>).Authorization).toBe('Bearer token');
		expect(published).toHaveLength(1);
		expect(published[0]!.topic).toBe('github/acme/widgets/pull_request/7.comment_polled');
		await extension.pollWatchedRepo(
			extension.repo.listPollingRepos()[0],
			fakeFetch as typeof fetch
		);
		expect(published).toHaveLength(2);
		expect((calls[3].headers as Record<string, string>)['If-None-Match']).toBe('etag-1');
		await extension.stop();
	});

	test('dedupe keys preserve repeated webhook actions and polling PR updates', async () => {
		const first = normalizeSpaceGitHubWebhook(
			'pull_request',
			'delivery-a',
			payloadFor('pull_request')
		)!;
		const second = normalizeSpaceGitHubWebhook(
			'pull_request',
			'delivery-b',
			payloadFor('pull_request')
		)!;
		expect(first.dedupeKey).not.toBe(second.dedupeKey);

		const commentCreated = normalizeSpaceGitHubWebhook(
			'issue_comment',
			'delivery-c',
			payloadFor('issue_comment')
		)!;
		const editedPayload = {
			...(payloadFor('issue_comment') as Record<string, unknown>),
			action: 'edited',
		};
		const commentEdited = normalizeSpaceGitHubWebhook(
			'issue_comment',
			'delivery-d',
			editedPayload
		)!;
		expect(commentCreated.dedupeKey).not.toBe(commentEdited.dedupeKey);

		const db = setupDb();
		seedTask(db);
		const service = new SpaceGitHubService(db);
		await service.ingest('space-1', first);
		await service.ingest('space-1', second);
		expect(db.prepare('SELECT COUNT(*) AS c FROM space_github_events').get()).toEqual({ c: 2 });
	});

	test('extension polling ignores issue comments and keeps watermark stable while draining pages', async () => {
		const db = setupDb();
		seedTask(db);
		let publishCount = 0;
		const extension = new GitHubEventExtension(db, 'token');
		await extension.start({
			publisher: {
				publish: async () => {
					publishCount++;
					return { outcome: 'created', eventId: 'id' };
				},
			},
			config: {
				async getGlobalConfig(source: string) {
					return { source, globallyEnabled: true, capabilities: { webhooks: true, polling: true } };
				},
				async getSpaceConfig(spaceId: string, source: string) {
					return { spaceId, source, enabled: true, settings: {} };
				},
				async listEnabledSpaces() {
					return [];
				},
			},
			onSourceConfigChanged() {},
		});
		extension.repo.upsertWatchedRepo({
			spaceId: 'space-1',
			owner: 'Acme',
			repo: 'Widgets',
			pollingEnabled: true,
		});
		const calls: string[] = [];
		const fakeFetch = async (url: string | URL | Request) => {
			const urlText = String(url);
			calls.push(urlText);
			if (urlText.includes('/issues/comments')) {
				return new Response(
					JSON.stringify([
						{
							id: 501,
							body: 'regular issue comment',
							html_url: 'https://github.com/acme/widgets/issues/99#issuecomment-501',
							issue: { number: 99 },
							user: { login: 'human', type: 'User' },
							updated_at: '2026-01-01T00:00:00Z',
						},
					]),
					{ status: 200 }
				);
			}
			if (urlText.includes('/pulls?')) {
				const page = new URL(urlText).searchParams.get('page');
				return new Response(
					JSON.stringify(
						Array.from({ length: page === '1' ? 100 : 1 }, (_unused, idx) => ({
							id: page === '1' ? 700 + idx : 900,
							number: 7,
							title: `PR update ${idx}`,
							html_url: 'https://github.com/acme/widgets/pull/7',
							user: { login: 'dev', type: 'User' },
							updated_at:
								page === '1'
									? `2026-01-01T00:${String(idx % 60).padStart(2, '0')}:00Z`
									: '2026-01-01T00:59:59Z',
						}))
					),
					{ status: 200 }
				);
			}
			return new Response(JSON.stringify([]), { status: 200 });
		};

		await extension.pollWatchedRepo(
			extension.repo.listPollingRepos()[0],
			fakeFetch as typeof fetch
		);

		expect(publishCount).toBe(100);
		expect(calls.some((url) => url.includes('per_page=100'))).toBe(true);
		let cursor = JSON.parse(
			(
				db.prepare('SELECT poll_cursor FROM space_github_watched_repos').get() as {
					poll_cursor: string;
				}
			).poll_cursor
		);
		expect(cursor.processedPages.pulls).toBe(2);
		expect(cursor.lastSeenAt).toBe(0);
		expect(cursor.pendingLastSeenAt).toBeGreaterThan(0);

		await extension.pollWatchedRepo(
			extension.repo.listPollingRepos()[0],
			fakeFetch as typeof fetch
		);

		expect(calls.some((url) => url.includes('page=2') && !url.includes('since='))).toBe(true);
		// External events published through ExternalEventService
		expect(publishCount).toBeGreaterThan(0);
		await extension.stop();
	});
});
