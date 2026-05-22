/**
 * Space Agent RPC Handlers
 *
 * RPC handlers for Space agent CRUD operations:
 * - spaceAgent.listBuiltInTemplates - List built-in agent templates from seeding source
 * - spaceAgent.create           - Create an agent in a Space
 * - spaceAgent.list             - List all agents in a Space
 * - spaceAgent.get              - Get a single agent by ID
 * - spaceAgent.update           - Update an agent's fields
 * - spaceAgent.delete           - Delete an agent (error if referenced by workflows)
 * - spaceAgent.getDriftReport   - Compare preset-tracked agents to live preset definitions
 * - spaceAgent.syncFromTemplate - Reset a preset-tracked agent to the current preset definition
 */

import type {
	MessageHub,
	Session,
	SettingSource,
	SpaceAgent,
	SpaceAgentPromotionDraft,
	ThinkingLevel,
} from '@neokai/shared';
import { KNOWN_TOOLS } from '@neokai/shared';
import type { Database } from '../../storage';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { SpaceAgentManager } from '../space/managers/space-agent-manager';
import type { SpaceManager } from '../space/managers/space-manager';
import { getPresetAgentTemplates } from '../space/agents/seed-agents';
import { Logger } from '../logger';

const log = new Logger('space-agent-handlers');

const PROMOTION_MESSAGE_LIMIT = 24;
const PROMOTION_CONTEXT_CHAR_LIMIT = 6000;

function clampText(value: string, limit: number): string {
	if (value.length <= limit) return value;
	return `${value.slice(0, limit - 1).trimEnd()}…`;
}

function deriveAgentName(session: Session): string {
	const base = (session.title || 'Promoted Agent')
		.replace(/^space chat:?\s*/i, '')
		.replace(/[^\p{L}\p{N}\s_-]/gu, '')
		.trim();
	return clampText(base || 'Promoted Agent', 64);
}

function extractTools(session: Session): string[] | undefined {
	const allowedTools = session.config.allowedTools ?? [];
	const known = new Set<string>(KNOWN_TOOLS);
	const tools = allowedTools.filter((tool) => known.has(tool));
	return tools.length > 0 ? [...new Set(tools)] : undefined;
}

function extractSettingSources(session: Session): SettingSource[] | undefined {
	const configSources = session.config.settingSources;
	if (configSources?.length) return configSources;
	const toolSources = session.config.tools?.settingSources;
	return toolSources?.length ? toolSources : undefined;
}

function buildPromotionDraft(session: Session, db: Database): SpaceAgentPromotionDraft {
	const messages = db.getRenderableTextMessages(session.id, PROMOTION_MESSAGE_LIMIT);
	const context = messages.length
		? messages
				.map((message) => {
					const speaker = message.type === 'assistant' ? 'Assistant' : 'User';
					return `${speaker}: ${message.text}`;
				})
				.join('\n\n---\n\n')
		: 'No renderable chat messages were available. Fill in standing context manually before creating this agent.';
	const standingContext = clampText(context, PROMOTION_CONTEXT_CHAR_LIMIT);
	const name = deriveAgentName(session);
	const responsibility = `Continue the durable role that emerged in "${session.title || session.id}".`;
	const standingInstructions =
		'Use the standing context below as background, not as a transcript to replay. Keep future work goal-oriented, cite uncertainty, and ask for human input before high-impact actions.';
	const autonomy =
		'Supervised by default: propose actions and wait for explicit approval before destructive, external, or irreversible changes.';
	const managedGoals =
		'Review and narrow this list to the goals this long-horizon agent should own.';
	const managedScopes =
		'Review and narrow this list to repositories, files, systems, or product areas this agent may manage.';
	const reminders =
		'Periodically summarize progress, blockers, decisions, and needed human follow-up.';
	const eventSubscriptions =
		'Review and list events this agent should react to, such as task changes, PR reviews, CI failures, mentions, or scheduled check-ins.';
	const customPrompt = `## Responsibility\n${responsibility}\n\n## Standing Instructions\n${standingInstructions}\n\n## Autonomy\n${autonomy}\n\n## Managed Goals\n${managedGoals}\n\n## Managed Scopes\n${managedScopes}\n\n## Reminders\n${reminders}\n\n## Event Subscriptions\n${eventSubscriptions}\n\n## Standing Context From Promoted Session\n${standingContext}`;

	return {
		sourceSessionId: session.id,
		sourceSessionTitle: session.title || session.id,
		name,
		description: responsibility,
		model: session.config.model,
		thinkingLevel: session.config.thinkingLevel as ThinkingLevel | undefined,
		provider: session.config.provider,
		customPrompt,
		tools: extractTools(session),
		settingSources: extractSettingSources(session),
		profile: {
			responsibility,
			standingInstructions,
			autonomy,
			managedGoals,
			managedScopes,
			reminders,
			eventSubscriptions,
			standingContext,
		},
	};
}

async function publishAgentCreated(
	internalEventBus: InternalEventBus<DaemonInternalEventMap>,
	agent: SpaceAgent
): Promise<void> {
	await internalEventBus
		.publish('spaceAgent.created', {
			sessionId: `space:${agent.spaceId}`,
			spaceId: agent.spaceId,
			agent,
		})
		.catch((err) => {
			log.warn('Failed to emit spaceAgent.created:', err);
		});
}

export function setupSpaceAgentHandlers(
	messageHub: MessageHub,
	internalEventBus: InternalEventBus<DaemonInternalEventMap>,
	spaceAgentManager: SpaceAgentManager,
	spaceManager: SpaceManager,
	db: Database
): void {
	// spaceAgent.listBuiltInTemplates — return built-in templates from seeding source
	messageHub.onRequest('spaceAgent.listBuiltInTemplates', async (data) => {
		const params = data as { spaceId: string };
		if (!params.spaceId) throw new Error('spaceId is required');

		// Keep validation consistent with spaceWorkflow.listBuiltInTemplates.
		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) throw new Error(`Space not found: ${params.spaceId}`);

		return { templates: getPresetAgentTemplates() };
	});

	// spaceAgent.create — create a new agent within a Space
	messageHub.onRequest('spaceAgent.create', async (data) => {
		const params = data as {
			spaceId: string;
			name: string;
			description?: string;
			model?: string;
			thinkingLevel?: import('@neokai/shared').ThinkingLevel;
			provider?: string;
			customPrompt?: string | null;
			tools?: string[];
			settingSources?: import('@neokai/shared').SettingSource[];
		};

		if (!params.spaceId) throw new Error('spaceId is required');
		if (!params.name) throw new Error('name is required');

		const result = await spaceAgentManager.create({
			spaceId: params.spaceId,
			name: params.name,
			description: params.description,
			model: params.model,
			thinkingLevel: params.thinkingLevel,
			provider: params.provider,
			customPrompt: params.customPrompt,
			tools: params.tools,
			settingSources: params.settingSources,
		});

		if (!result.ok) throw new Error(result.error);

		await publishAgentCreated(internalEventBus, result.value);

		return { agent: result.value };
	});

	messageHub.onRequest('spaceAgent.getPromotionDraft', async (data) => {
		const params = data as { spaceId: string; sessionId: string };
		if (!params.spaceId) throw new Error('spaceId is required');
		if (!params.sessionId) throw new Error('sessionId is required');

		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) throw new Error(`Space not found: ${params.spaceId}`);

		const session = db.getSession(params.sessionId);
		if (!session) throw new Error(`Session not found: ${params.sessionId}`);
		if (session.context?.spaceId !== params.spaceId) {
			throw new Error(`Session not found: ${params.sessionId}`);
		}
		if (session.type === 'space_task_agent') {
			throw new Error('Task agent sessions cannot be promoted');
		}

		return { draft: buildPromotionDraft(session, db) };
	});

	messageHub.onRequest('spaceAgent.promoteSession', async (data) => {
		const params = data as {
			spaceId: string;
			sessionId: string;
			name: string;
			description?: string;
			model?: string;
			thinkingLevel?: import('@neokai/shared').ThinkingLevel;
			provider?: string;
			customPrompt?: string | null;
			tools?: string[];
			settingSources?: import('@neokai/shared').SettingSource[];
		};
		if (!params.spaceId) throw new Error('spaceId is required');
		if (!params.sessionId) throw new Error('sessionId is required');
		if (!params.name) throw new Error('name is required');

		const session = db.getSession(params.sessionId);
		if (!session) throw new Error(`Session not found: ${params.sessionId}`);
		if (session.context?.spaceId !== params.spaceId) {
			throw new Error(`Session not found: ${params.sessionId}`);
		}
		if (session.type === 'space_task_agent') {
			throw new Error('Task agent sessions cannot be promoted');
		}

		const result = await spaceAgentManager.create({
			spaceId: params.spaceId,
			name: params.name,
			description: params.description,
			model: params.model,
			thinkingLevel: params.thinkingLevel,
			provider: params.provider,
			customPrompt: params.customPrompt,
			tools: params.tools,
			settingSources: params.settingSources,
		});
		if (!result.ok) throw new Error(result.error);

		await publishAgentCreated(internalEventBus, result.value);
		return { agent: result.value };
	});

	// spaceAgent.list — list all agents for a Space
	messageHub.onRequest('spaceAgent.list', async (data) => {
		const params = data as { spaceId: string };
		if (!params.spaceId) throw new Error('spaceId is required');

		const agents = spaceAgentManager.listBySpaceId(params.spaceId);
		return { agents };
	});

	// spaceAgent.get — get a single agent by ID
	messageHub.onRequest('spaceAgent.get', async (data) => {
		const params = data as { id: string };
		if (!params.id) throw new Error('id is required');

		const agent = spaceAgentManager.getById(params.id);
		if (!agent) throw new Error(`Agent not found: ${params.id}`);

		return { agent };
	});

	// spaceAgent.update — update an existing agent
	messageHub.onRequest('spaceAgent.update', async (data) => {
		const params = data as {
			id: string;
			name?: string;
			description?: string | null;
			model?: string | null;
			thinkingLevel?: import('@neokai/shared').ThinkingLevel | null;
			provider?: string | null;
			customPrompt?: string | null;
			tools?: string[] | null;
			settingSources?: import('@neokai/shared').SettingSource[] | null;
		};

		if (!params.id) throw new Error('id is required');

		const { id, ...updateFields } = params;
		const result = await spaceAgentManager.update(id, {
			name: updateFields.name,
			description: updateFields.description,
			model: updateFields.model,
			thinkingLevel: updateFields.thinkingLevel,
			provider: updateFields.provider,
			customPrompt: updateFields.customPrompt,
			tools: updateFields.tools,
			settingSources: updateFields.settingSources,
		});

		if (!result.ok) throw new Error(result.error);

		internalEventBus
			.publish('spaceAgent.updated', {
				sessionId: `space:${result.value.spaceId}`,
				spaceId: result.value.spaceId,
				agent: result.value,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceAgent.updated:', err);
			});

		return { agent: result.value };
	});

	// spaceAgent.getDriftReport — list preset-tracked agents and whether each
	// has drifted from the source preset definition in code.
	messageHub.onRequest('spaceAgent.getDriftReport', async (data) => {
		const params = data as { spaceId: string };
		if (!params.spaceId) throw new Error('spaceId is required');

		// Validate space ownership for consistency with the rest of the
		// spaceAgent.* handlers — keeps unauthenticated drift queries from
		// leaking the existence of preset-tracked agents.
		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) throw new Error(`Space not found: ${params.spaceId}`);

		const report = spaceAgentManager.getAgentDriftReport(params.spaceId);
		return { report };
	});

	// spaceAgent.syncFromTemplate — reset a preset-tracked agent to the
	// current preset definition (description, tools, customPrompt) and
	// re-stamp its template_hash. Throws if the agent has no template_name
	// or the named preset no longer exists in code.
	messageHub.onRequest('spaceAgent.syncFromTemplate', async (data) => {
		const params = data as { spaceId: string; agentId: string };
		if (!params.spaceId) throw new Error('spaceId is required');
		if (!params.agentId) throw new Error('agentId is required');

		const space = await spaceManager.getSpace(params.spaceId);
		if (!space) throw new Error(`Space not found: ${params.spaceId}`);

		// Defensive: verify the agent actually belongs to this space before
		// running the sync. SpaceAgentManager.syncFromTemplate operates on the
		// agent ID alone, so this check prevents one space from rewriting
		// another space's agent via a forged spaceId.
		const existing = spaceAgentManager.getById(params.agentId);
		if (!existing) throw new Error(`Agent not found: ${params.agentId}`);
		if (existing.spaceId !== params.spaceId) {
			throw new Error(`Agent not found: ${params.agentId}`);
		}

		const result = await spaceAgentManager.syncFromTemplate(params.agentId);
		if (!result.ok) throw new Error(result.error);

		internalEventBus
			.publish('spaceAgent.updated', {
				sessionId: `space:${result.value.spaceId}`,
				spaceId: result.value.spaceId,
				agent: result.value,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceAgent.updated:', err);
			});

		return { agent: result.value };
	});

	// spaceAgent.delete — delete an agent (blocked if referenced by workflows)
	messageHub.onRequest('spaceAgent.delete', async (data) => {
		const params = data as { id: string };
		if (!params.id) throw new Error('id is required');

		// Pre-fetch to capture spaceId for the event payload.
		// SpaceAgentManager.delete() also calls getById internally; the two reads
		// are synchronous SQLite operations and the pre-fetch ensures we always
		// have the spaceId for event routing even after the row is removed.
		const existing = spaceAgentManager.getById(params.id);
		if (!existing) throw new Error(`Agent not found: ${params.id}`);

		const result = spaceAgentManager.delete(params.id);
		if (!result.ok) {
			const detailsMsg = result.details?.length ? `\n${result.details.join('\n')}` : '';
			throw new Error(`${result.error}${detailsMsg}`);
		}

		// Await the event so subscribers (e.g. StateManager) see it before the
		// handler returns — consistent with how room.delete emits room.deleted.
		await internalEventBus
			.publish('spaceAgent.deleted', {
				sessionId: `space:${existing.spaceId}`,
				spaceId: existing.spaceId,
				agentId: params.id,
			})
			.catch((err) => {
				log.warn('Failed to emit spaceAgent.deleted:', err);
			});

		return { success: true };
	});
}
