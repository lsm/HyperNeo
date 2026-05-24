import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { StructuredLogEvent } from '@neokai/shared';
import {
	EvolutionLogEvidenceService,
	PRODUCT_FORGE_SCOPE_ID,
} from '../../../src/lib/space/evolution-log-evidence-service';
import { EvolutionRepository } from '../../../src/storage/repositories/evolution-repository';
import type { EvidenceRef } from '@neokai/shared';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { createSpaceTables } from '../helpers/space-test-db';

describe('EvolutionLogEvidenceService', () => {
	let db: Database;
	let evolutionRepo: EvolutionRepository;
	let scopeId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		const spaceRepo = new SpaceRepository(db as never);
		evolutionRepo = new EvolutionRepository(db as never);
		const spaceId = spaceRepo.createSpace({
			workspacePath: '/workspace/log-evidence',
			slug: 'log-evidence',
			name: 'Log Evidence',
		}).id;
		scopeId = evolutionRepo.createScope({
			spaceId,
			kind: 'project',
			name: 'NeoKai product',
			objective: 'Capture daemon warnings and errors',
		}).id;
	});

	it('creates evidence for error-level log events', () => {
		const service = new EvolutionLogEvidenceService({
			evolutionRepo,
			subscriptions: [{ scopeId, levels: ['error'] }],
		});

		service.capture(
			createEvent({
				level: 'error',
				message: 'MCP connection failed',
				stack: 'Error: MCP connection failed\n    at connect',
			})
		);
		service.flush();

		const evidence = evolutionRepo.listEvidence(scopeId);
		expect(evidence).toHaveLength(1);
		expect(evidence[0].kind).toBe('daemon_error');
		expect(evidence[0].summary).toContain('MCP connection failed');
		expect(evidence[0].metadata.stack).toContain('at connect');
		expect(evidence[0].metadata.context).toEqual({ spaceId: 'space-1', sessionId: 'session-1' });
		expect(evidence[0].metadata.process).toMatchObject({ pid: 123 });
	});

	it('deduplicates identical signatures within the window', () => {
		let listEvidenceCalls = 0;
		let findEvidenceBySourceCalls = 0;
		const repo = Object.create(evolutionRepo) as EvolutionRepository & {
			findEvidenceBySource(scopeId: string, sourceId: string): EvidenceRef[];
		};
		repo.listEvidence = (...args) => {
			listEvidenceCalls += 1;
			return evolutionRepo.listEvidence(...args);
		};
		repo.findEvidenceBySource = (...args) => {
			findEvidenceBySourceCalls += 1;
			return evolutionRepo.findEvidenceBySource(...args);
		};
		const service = new EvolutionLogEvidenceService({
			evolutionRepo: repo,
			subscriptions: [{ scopeId, levels: ['warn'] }],
			dedupeWindowMs: 60_000,
		});

		service.capture(createEvent({ level: 'warn', message: 'session dropped 12345678901' }));
		service.capture(createEvent({ level: 'warn', message: 'session dropped 99999999999' }));
		service.flush();

		const evidence = evolutionRepo.listEvidence(scopeId);
		expect(evidence).toHaveLength(1);
		expect(evidence[0].kind).toBe('runtime_warning');
		expect(evidence[0].metadata.count).toBe(2);
		expect(evidence[0].metadata.samples).toHaveLength(2);
		expect(findEvidenceBySourceCalls).toBe(2);
		expect(listEvidenceCalls).toBe(0);
	});

	it('resolves default product scope dynamically when the fixed scope is absent', () => {
		const dynamicSpaceId = new SpaceRepository(db as never).createSpace({
			workspacePath: '/workspace/log-evidence-dynamic',
			slug: 'log-evidence-dynamic',
			name: 'Log Evidence Dynamic',
		}).id;
		let listSpacesCalls = 0;
		const service = new EvolutionLogEvidenceService({
			evolutionRepo,
			spaceRepo: {
				listSpaces: () => {
					listSpacesCalls += 1;
					return [{ id: dynamicSpaceId }] as never;
				},
			},
		});
		expect(evolutionRepo.getScope(PRODUCT_FORGE_SCOPE_ID)).toBeNull();

		service.capture(createEvent({ level: 'error', message: 'dynamic scope failure' }));
		service.capture(createEvent({ level: 'warn', message: 'dynamic scope warning' }));
		service.flush();

		const scope = evolutionRepo
			.listScopes({ spaceId: dynamicSpaceId })
			.find((item) => item.policy.logEvidenceProductScope === true);
		expect(scope).toBeTruthy();
		expect(evolutionRepo.listEvidence(scope!.id)).toHaveLength(2);
		expect(listSpacesCalls).toBe(1);
	});

	it('classifies process crash events by processEvent metadata', () => {
		const service = new EvolutionLogEvidenceService({
			evolutionRepo,
			subscriptions: [{ scopeId, levels: ['fatal'] }],
		});

		service.capture(
			createEvent({
				level: 'fatal',
				message: 'uncaught exception',
				metadata: { processEvent: 'uncaughtException' },
			})
		);
		service.flush();

		expect(evolutionRepo.listEvidence(scopeId)[0].kind).toBe('uncaught_exception');
	});

	it('does not capture unsubscribed levels and redacts secrets', () => {
		const service = new EvolutionLogEvidenceService({
			evolutionRepo,
			subscriptions: [{ scopeId, levels: ['error'] }],
		});

		service.capture(createEvent({ level: 'info', message: 'startup ok' }));
		service.capture(
			createEvent({
				level: 'error',
				message: 'config failed token=secret-value',
				metadata: { apiKey: 'sk-test-secret' },
			})
		);
		service.flush();

		const evidence = evolutionRepo.listEvidence(scopeId);
		expect(evidence).toHaveLength(1);
		expect(JSON.stringify(evidence[0].metadata)).not.toContain('sk-test-secret');
		expect(JSON.stringify(evidence[0].metadata)).not.toContain('secret-value');
		expect(JSON.stringify(evidence[0].metadata)).toContain('[REDACTED]');
	});
});

function createEvent(overrides: Partial<StructuredLogEvent>): StructuredLogEvent {
	return {
		id: `event-${Math.random()}`,
		timestamp: Date.now(),
		level: 'error',
		message: 'daemon error',
		module: 'kai:daemon:test',
		source: 'logger',
		context: { spaceId: 'space-1', sessionId: 'session-1' },
		process: {
			pid: 123,
			memory: { rss: 1, heapTotal: 1, heapUsed: 1, external: 0, arrayBuffers: 0 },
			uptime: 5,
		},
		metadata: {},
		...overrides,
	};
}
