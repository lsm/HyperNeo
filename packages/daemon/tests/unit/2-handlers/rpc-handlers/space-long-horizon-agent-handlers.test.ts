import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MessageHub } from '@neokai/shared';
import { setupSpaceLongHorizonAgentHandlers } from '../../../../src/lib/rpc-handlers/space-long-horizon-agent-handlers';
import type { SpaceManager } from '../../../../src/lib/space/managers/space-manager';

type RequestHandler = (data: unknown, context: unknown) => Promise<unknown>;

function createMockMessageHub(): { hub: MessageHub; handlers: Map<string, RequestHandler> } {
	const handlers = new Map<string, RequestHandler>();
	const hub = {
		onRequest: mock((method: string, handler: RequestHandler) => {
			handlers.set(method, handler);
			return () => handlers.delete(method);
		}),
	} as unknown as MessageHub;
	return { hub, handlers };
}

function createMockSpaceManager(): SpaceManager {
	type GetSpaceResult = Awaited<ReturnType<SpaceManager['getSpace']>>;
	return {
		getSpace: mock(async (spaceId: string): Promise<GetSpaceResult> => {
			return spaceId === 'space-1' ? ({ id: 'space-1' } as Exclude<GetSpaceResult, null>) : null;
		}),
	} as unknown as SpaceManager;
}

async function call<T>(
	handlers: Map<string, RequestHandler>,
	method: string,
	params: unknown
): Promise<T> {
	const handler = handlers.get(method);
	if (!handler) throw new Error(`Handler not registered: ${method}`);
	return (await handler(params, {})) as T;
}

describe('Space long-horizon agent handlers', () => {
	let hubData: ReturnType<typeof createMockMessageHub>;

	beforeEach(() => {
		hubData = createMockMessageHub();
		setupSpaceLongHorizonAgentHandlers(hubData.hub, createMockSpaceManager());
	});

	describe('spaceLongHorizonAgent.listBuiltInTemplates', () => {
		it('registers the handler', () => {
			expect(hubData.handlers.has('spaceLongHorizonAgent.listBuiltInTemplates')).toBe(true);
		});

		it('returns built-in long-horizon agent templates', async () => {
			const result = await call<{
				templates: Array<{
					key: string;
					suggestedEventSubscriptions: unknown[];
					reminderDefaults: unknown[];
					ownershipPatterns: unknown[];
				}>;
			}>(hubData.handlers, 'spaceLongHorizonAgent.listBuiltInTemplates', {
				spaceId: 'space-1',
			});

			expect(result.templates).toHaveLength(7);
			expect(result.templates.map((template) => template.key)).toContain('coordinator.default');
			for (const template of result.templates) {
				expect(template.suggestedEventSubscriptions.length).toBeGreaterThan(0);
				expect(template.reminderDefaults.length).toBeGreaterThan(0);
				expect(template.ownershipPatterns.length).toBeGreaterThan(0);
			}
		});

		it('throws when spaceId is missing', async () => {
			await expect(
				call(hubData.handlers, 'spaceLongHorizonAgent.listBuiltInTemplates', {})
			).rejects.toThrow('spaceId is required');
		});

		it('throws when space does not exist', async () => {
			await expect(
				call(hubData.handlers, 'spaceLongHorizonAgent.listBuiltInTemplates', {
					spaceId: 'missing-space',
				})
			).rejects.toThrow('Space not found: missing-space');
		});
	});
});
