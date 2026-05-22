import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
	EvolutionConversationAnalysisService,
	extractConversationMessages,
	parseConversationFrictionJson,
	type TraceMessage,
} from '../../../src/lib/space/evolution-conversation-analysis-service';
import { EvolutionRepository } from '../../../src/storage/repositories/evolution-repository';
import { SpaceRepository } from '../../../src/storage/repositories/space-repository';
import { SpaceTaskRepository } from '../../../src/storage/repositories/space-task-repository';
import { createSpaceTables } from '../helpers/space-test-db';

describe('EvolutionConversationAnalysisService', () => {
	let db: Database;
	let evolutionRepo: EvolutionRepository;
	let spaceRepo: SpaceRepository;
	let taskRepo: SpaceTaskRepository;
	let spaceId: string;

	beforeEach(() => {
		db = new Database(':memory:');
		createSpaceTables(db);
		evolutionRepo = new EvolutionRepository(db as never);
		spaceRepo = new SpaceRepository(db as never);
		taskRepo = new SpaceTaskRepository(db as never);
		spaceId = spaceRepo.createSpace({
			workspacePath: '/workspace/conversation-friction',
			slug: 'conversation-friction',
			name: 'Conversation Friction',
		}).id;
	});

	it('classifies null-origin users as human and explicit synthetic rows as synthetic', () => {
		const rows = [
			traceRow('human-1', 'user', 'human', {
				type: 'user',
				message: { role: 'user', content: [{ type: 'text', text: 'Please keep this scoped.' }] },
			}),
			traceRow('null-human-1', 'user', null, {
				type: 'user',
				message: { role: 'user', content: [{ type: 'text', text: 'This is normal user input.' }] },
			}),
			traceRow('synthetic-1', 'user', null, {
				type: 'user',
				isSynthetic: true,
				message: { role: 'user', content: [{ type: 'text', text: 'Reviewer requested changes.' }] },
			}),
			traceRow('system-1', 'user', 'system', {
				type: 'user',
				message: { role: 'user', content: [{ type: 'text', text: 'Workflow dispatched work.' }] },
			}),
			traceRow('assistant-1', 'assistant', null, {
				type: 'assistant',
				message: {
					role: 'assistant',
					content: [
						{ type: 'thinking', text: 'I may have misunderstood the requirement.' },
						{ type: 'text', text: 'Sorry, I will fix the scoped behavior.' },
					],
				},
			}),
		];

		const messages = extractConversationMessages(rows);

		expect(messages.map((message) => message.role)).toEqual([
			'human',
			'human',
			'synthetic_user',
			'synthetic_user',
			'thinking',
			'assistant',
		]);
		expect(messages.map((message) => message.metadata.messageId)).toEqual([
			'human-1',
			'null-human-1',
			'synthetic-1',
			'system-1',
			'assistant-1',
			'assistant-1',
		]);
	});

	it('emits conversation friction evidence above threshold and upserts repeated capture', async () => {
		const { scope, task } = createScopedTask();
		insertTextMessage(task.id, 'message-human-1', 'user', 'human', {
			type: 'user',
			message: {
				role: 'user',
				content: [{ type: 'text', text: 'No, keep the change in this PR.' }],
			},
		});
		insertTextMessage(task.id, 'message-assistant-1', 'assistant', null, {
			type: 'assistant',
			message: { role: 'assistant', content: [{ type: 'text', text: 'Sorry, I misunderstood.' }] },
		});
		const service = new EvolutionConversationAnalysisService({
			db: db as never,
			evolutionRepo,
			taskRepo,
			analyzeConversation: async () => ({
				patterns: [
					{
						kind: 'human_correction',
						confidence: 0.8,
						summary: 'Human corrected agent scope misunderstanding.',
						involvedMessages: ['message-human-1', 'message-assistant-1'],
						severity: 'medium',
					},
					{
						kind: 'agent_apology',
						confidence: 0.4,
						summary: 'Low-confidence apology.',
						involvedMessages: ['message-assistant-1'],
						severity: 'low',
					},
				],
				humanInterventionCount: 1,
				syntheticInterventionCount: 0,
				agentUncertaintyCount: 1,
				overallAssessment: 'Scope misunderstanding slowed completion.',
			}),
		});

		const first = await service.captureForTask({ scopeId: scope.id, taskId: task.id });
		const second = await service.captureForTask({ scopeId: scope.id, taskId: task.id });

		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
		expect(
			evolutionRepo.listEvidence(scope.id).filter((item) => item.kind === 'conversation_friction')
		).toHaveLength(1);
		expect(first[0]?.metadata.conversationFrictionDerived).toBe(true);
		expect(first[0]?.metadata.humanInterventionCount).toBe(1);
		expect((first[0]?.metadata.pattern as { kind?: string }).kind).toBe('human_correction');
	});

	it('excludes unsent messages from conversation friction input', async () => {
		const { scope, task } = createScopedTask();
		let analyzedMessages: TraceMessage[] = [];
		insertTextMessage(task.id, 'consumed-human-1', 'user', 'human', {
			type: 'user',
			message: { role: 'user', content: [{ type: 'text', text: 'Please fix this.' }] },
		});
		insertTextMessage(
			task.id,
			'deferred-human-1',
			'user',
			'human',
			{
				type: 'user',
				message: { role: 'user', content: [{ type: 'text', text: 'Not sent yet.' }] },
			},
			'deferred'
		);
		const service = new EvolutionConversationAnalysisService({
			db: db as never,
			evolutionRepo,
			taskRepo,
			analyzeConversation: async (input) => {
				analyzedMessages = input.messages;
				return emptyAnalysis();
			},
		});

		await service.captureForTask({ scopeId: scope.id, taskId: task.id });

		expect(analyzedMessages.map((message) => message.metadata.messageId)).toEqual([
			'consumed-human-1',
		]);
	});

	it('canonicalizes involved message IDs for stable fingerprints', async () => {
		const { scope, task } = createScopedTask();
		insertTextMessage(task.id, 'message-human-1', 'user', 'human', {
			type: 'user',
			message: { role: 'user', content: [{ type: 'text', text: 'No, this is wrong.' }] },
		});
		insertTextMessage(task.id, 'message-assistant-1', 'assistant', null, {
			type: 'assistant',
			message: { role: 'assistant', content: [{ type: 'text', text: 'Sorry, I misunderstood.' }] },
		});
		let reversed = false;
		const service = new EvolutionConversationAnalysisService({
			db: db as never,
			evolutionRepo,
			taskRepo,
			analyzeConversation: async () => ({
				patterns: [
					{
						kind: 'human_correction',
						confidence: 0.9,
						summary: 'Human corrected a misunderstanding.',
						involvedMessages: reversed
							? ['message-assistant-1', 'message-human-1']
							: ['message-human-1', 'message-assistant-1'],
						severity: 'high',
					},
				],
				humanInterventionCount: 1,
				syntheticInterventionCount: 0,
				agentUncertaintyCount: 1,
				overallAssessment: 'Correction needed.',
			}),
		});

		const first = await service.captureForTask({ scopeId: scope.id, taskId: task.id });
		reversed = true;
		const second = await service.captureForTask({ scopeId: scope.id, taskId: task.id });

		expect(first[0]?.id).toBe(second[0]?.id);
		expect(
			evolutionRepo.listEvidence(scope.id).filter((item) => item.kind === 'conversation_friction')
		).toHaveLength(1);
		expect(second[0]?.metadata.frictionFingerprint).toBe(
			'conversation_friction:human_correction:message-assistant-1,message-human-1'
		);
	});

	it('rejects patterns whose message IDs do not resolve in trace', async () => {
		const { scope, task } = createScopedTask();
		insertTextMessage(task.id, 'message-human-1', 'user', 'human', {
			type: 'user',
			message: { role: 'user', content: [{ type: 'text', text: 'Please fix this.' }] },
		});
		const service = new EvolutionConversationAnalysisService({
			db: db as never,
			evolutionRepo,
			taskRepo,
			analyzeConversation: async () => ({
				patterns: [
					{
						kind: 'human_correction',
						confidence: 0.9,
						summary: 'References a missing message.',
						involvedMessages: ['message-human-1', 'missing-message'],
						severity: 'medium',
					},
				],
				humanInterventionCount: 1,
				syntheticInterventionCount: 0,
				agentUncertaintyCount: 0,
				overallAssessment: 'Missing reference.',
			}),
		});

		const evidence = await service.captureForTask({ scopeId: scope.id, taskId: task.id });

		expect(evidence).toEqual([]);
		expect(evolutionRepo.listEvidence(scope.id)).toHaveLength(0);
	});

	it('skips malformed patterns while retaining valid patterns', () => {
		const analysis = parseConversationFrictionJson(
			JSON.stringify({
				patterns: [
					{
						kind: 'human_correction',
						confidence: 0.8,
						summary: 'Valid correction.',
						involvedMessages: ['message-human-1'],
						severity: 'medium',
					},
					{
						kind: 'not_allowed',
						confidence: 0.9,
						summary: 'Invalid kind.',
						involvedMessages: ['message-human-1'],
						severity: 'medium',
					},
				],
				humanInterventionCount: 1,
				syntheticInterventionCount: 0,
				agentUncertaintyCount: 0,
				overallAssessment: 'One valid pattern.',
			})
		);

		expect(analysis.patterns).toHaveLength(1);
		expect(analysis.patterns[0]?.kind).toBe('human_correction');
	});

	it('returns no evidence when LLM returns empty patterns', async () => {
		const { scope, task } = createScopedTask();
		insertTextMessage(task.id, 'message-human-1', 'user', 'human', {
			type: 'user',
			message: { role: 'user', content: [{ type: 'text', text: 'Please fix this.' }] },
		});
		const service = new EvolutionConversationAnalysisService({
			db: db as never,
			evolutionRepo,
			taskRepo,
			analyzeConversation: async () => emptyAnalysis(),
		});

		const evidence = await service.captureForTask({ scopeId: scope.id, taskId: task.id });

		expect(evidence).toEqual([]);
		expect(evolutionRepo.listEvidence(scope.id)).toHaveLength(0);
	});

	it('propagates LLM failures so the job queue can retry', async () => {
		const { scope, task } = createScopedTask();
		insertTextMessage(task.id, 'message-human-1', 'user', 'human', {
			type: 'user',
			message: { role: 'user', content: [{ type: 'text', text: 'Please fix this.' }] },
		});
		const service = new EvolutionConversationAnalysisService({
			db: db as never,
			evolutionRepo,
			taskRepo,
			analyzeConversation: async () => {
				throw new Error('LLM unavailable');
			},
		});

		expect(service.captureForTask({ scopeId: scope.id, taskId: task.id })).rejects.toThrow(
			'LLM unavailable'
		);
	});

	it('emits no evidence when all patterns are below threshold', async () => {
		const { scope, task } = createScopedTask();
		insertTextMessage(task.id, 'message-human-1', 'user', 'human', {
			type: 'user',
			message: { role: 'user', content: [{ type: 'text', text: 'Please fix this.' }] },
		});
		const service = new EvolutionConversationAnalysisService({
			db: db as never,
			evolutionRepo,
			taskRepo,
			analyzeConversation: async () => ({
				patterns: [
					{
						kind: 'human_correction',
						confidence: 0.4,
						summary: 'Below threshold.',
						involvedMessages: ['message-human-1'],
						severity: 'low',
					},
				],
				humanInterventionCount: 1,
				syntheticInterventionCount: 0,
				agentUncertaintyCount: 0,
				overallAssessment: 'Below threshold only.',
			}),
		});

		const evidence = await service.captureForTask({ scopeId: scope.id, taskId: task.id });

		expect(evidence).toEqual([]);
		expect(evolutionRepo.listEvidence(scope.id)).toHaveLength(0);
	});

	function createScopedTask() {
		const scope = evolutionRepo.createScope({
			spaceId,
			kind: 'custom',
			name: 'Friction scope',
			objective: 'Capture communication friction',
		});
		const task = taskRepo.createTask({
			spaceId,
			title: 'Fix repeated misunderstanding',
			description: 'Human corrected the agent twice',
			evolutionScopeId: scope.id,
		});
		return { scope, task };
	}

	function emptyAnalysis() {
		return {
			patterns: [],
			humanInterventionCount: 0,
			syntheticInterventionCount: 0,
			agentUncertaintyCount: 0,
			overallAssessment: 'No friction detected.',
		};
	}

	function traceRow(
		id: string,
		messageType: string,
		origin: string | null,
		message: Record<string, unknown>
	) {
		return {
			id,
			sessionId: 'session-1',
			messageType,
			sdkMessage: JSON.stringify(message),
			timestamp: new Date(1_700_000_000_000).toISOString(),
			origin,
		};
	}

	function insertTextMessage(
		taskId: string,
		id: string,
		messageType: string,
		origin: string | null,
		message: Record<string, unknown>,
		sendStatus = 'consumed'
	): void {
		db.prepare(
			`INSERT INTO sdk_messages (
				id, session_id, message_type, sdk_message, timestamp, origin,
				is_renderable, is_terminal, task_id, send_status
			) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`
		).run(
			id,
			'session-1',
			messageType,
			JSON.stringify(message),
			new Date(1_700_000_000_000).toISOString(),
			origin,
			taskId,
			sendStatus
		);
	}
});
