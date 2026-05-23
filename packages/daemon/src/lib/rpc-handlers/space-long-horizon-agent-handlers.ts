import type { MessageHub } from '@neokai/shared';
import type { SpaceManager } from '../space/managers/space-manager';
import { getLongHorizonAgentTemplates } from '../space/agents/long-horizon-agent-templates';

export function setupSpaceLongHorizonAgentHandlers(
	messageHub: MessageHub,
	spaceManager: SpaceManager
): void {
	messageHub.onRequest('spaceLongHorizonAgent.listBuiltInTemplates', async (data) => {
		const params = data as { spaceId: string };
		if (!params.spaceId) throw new Error('spaceId is required');

		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) throw new Error(`Space not found: ${params.spaceId}`);

		return { templates: getLongHorizonAgentTemplates() };
	});
}
