import { describe, test, expect } from 'bun:test';
import type { McpServerConfig } from '@neokai/shared';
import { TaskAgentManager } from '../../../../src/lib/space/runtime/task-agent-manager.ts';

function makeManager(memoryRepo?: unknown): TaskAgentManager {
	return Object.create(TaskAgentManager.prototype, {
		config: {
			value: { memoryRepo },
		},
	}) as TaskAgentManager;
}

function makeSession(mcpServers: Record<string, McpServerConfig>) {
	let restartCount = 0;
	return {
		session: { config: { mcpServers } },
		mergeRuntimeMcpServers(servers: Record<string, McpServerConfig>) {
			this.session.config.mcpServers = {
				...this.session.config.mcpServers,
				...servers,
			};
		},
		async restartQuery() {
			restartCount += 1;
		},
		get restartCount() {
			return restartCount;
		},
	};
}

describe('TaskAgentManager agent-memory MCP wiring', () => {
	test('builds agent-memory server when memory repo is configured', () => {
		const manager = makeManager({});
		const servers = manager.buildAgentMemoryMcpServers('space-a', 'session-a');

		expect(Object.keys(servers)).toContain('agent-memory');
	});

	test('omits agent-memory server when memory repo is absent', () => {
		const manager = makeManager();
		const servers = manager.buildAgentMemoryMcpServers('space-a', 'session-a');

		expect(servers).toEqual({});
	});

	test('requires agent-memory only when memory repo is configured', () => {
		expect(makeManager().requiredWorkflowSubSessionMcpServers()).toEqual(['node-agent']);
		expect(makeManager({}).requiredWorkflowSubSessionMcpServers()).toEqual([
			'node-agent',
			'agent-memory',
		]);
	});

	test('reattaches agent-memory when missing during rehydrate self-heal', async () => {
		const manager = makeManager({});
		const session = makeSession({
			'node-agent': { type: 'sdk' } as McpServerConfig,
		});

		await manager.ensureNodeAgentAttached(session as never, {
			taskId: 'task-a',
			subSessionId: 'session-a',
			agentName: 'coder',
			spaceId: 'space-a',
			workflowRunId: 'run-a',
			workspacePath: '/tmp/space-a',
			workflowNodeId: 'node-a',
			phase: 'rehydrate',
		});

		expect(Object.keys(session.session.config.mcpServers).sort()).toEqual([
			'agent-memory',
			'node-agent',
		]);
		expect(session.restartCount).toBe(1);
	});
});
