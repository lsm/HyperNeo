/**
 * Space Export/Import RPC Handlers
 *
 * Export namespace (spaceExport.*):
 *   spaceExport.agents    { spaceId, agentIds? }                       → { bundle: SpaceExportBundle }
 *   spaceExport.workflows { spaceId, workflowIds? }                    → { bundle: SpaceExportBundle }
 *   spaceExport.bundle    { spaceId, agentIds?, workflowIds? }         → { bundle: SpaceExportBundle }
 *
 * Import namespace (spaceImport.*):
 *   spaceImport.preview   { bundle, spaceId }                          → ImportPreviewResult
 *   spaceImport.execute   { spaceId, bundle, conflictResolution? }     → ImportExecuteResult
 *
 * Cross-reference rules:
 * - Exported workflow nodes store the agent's display **name** (`agentRef`), not UUID.
 * - On import, agent names are resolved to UUIDs by checking:
 *     1. Agents being imported in the same bundle (by original bundle name)
 *     2. Agents already present in the target space (by name)
 * - If a name cannot be resolved, preview flags it as a validation error;
 *   execute throws and aborts import of that workflow.
 * - Rule `appliesTo` lists node **names** in the exported format and are
 *   remapped to new node UUIDs on import.
 *
 * Atomicity:
 * - `spaceImport.execute` wraps all DB mutations in a single SQLite transaction.
 *   Any failure (unresolved agent ref, workflow validation error, etc.) rolls back
 *   the entire operation — no partial state is left in the database.
 *
 * Agent `replace` semantics:
 * - Fields absent from the exported agent (undefined) are explicitly cleared
 *   (set to null/empty), producing the same result as delete + create.
 *   This is intentional: `replace` is not a merge; it overwrites the existing
 *   record with exactly what the export contains.
 *
 * Naming uniqueness:
 * - Agent names in the DB are case-insensitive (SpaceAgentRepository uses LOWER()
 *   in uniqueness checks). The in-memory `usedAgentNames` set uses exact-case
 *   matching to track names created within the import batch; this is safe because
 *   all names that flow through the DB are already lower-case normalized at the
 *   source. Workflow names are exact-case both in the DB and in the set.
 */

import type { Database as BunDatabase } from 'bun:sqlite';
import { generateUUID } from '@neokai/shared';
import type {
	MessageHub,
	Space,
	SpaceAgent,
	SpaceWorkflow,
	CreateSpaceAgentParams,
	CreateSpaceWorkflowParams,
	WorkflowNodeInput,
	SpaceExportBundle,
	ExportedSpaceAgent,
	ExportedSpaceWorkflow,
} from '@neokai/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { SpaceManager } from '../space/managers/space-manager';
import type { SpaceWorkflowManager } from '../space/managers/space-workflow-manager';
import type { SpaceAgentRepository } from '../../storage/repositories/space-agent-repository';
import type { SpaceWorkflowRepository } from '../../storage/repositories/space-workflow-repository';
import { exportBundle, validateExportBundle, normalizeOverride } from '../space/export-format';
import { Logger } from '../logger';

const log = new Logger('space-export-import-handlers');

// ============================================================================
// Public types
// ============================================================================

export interface ImportPreview {
	name: string;
	action: 'create' | 'conflict';
	existingId?: string;
}

export interface ImportPreviewResult {
	agents: ImportPreview[];
	workflows: ImportPreview[];
	validationErrors: string[];
}

export type ConflictResolutionStrategy = 'skip' | 'rename' | 'replace';

export interface ImportConflictResolution {
	agents?: Record<string, ConflictResolutionStrategy>;
	workflows?: Record<string, ConflictResolutionStrategy>;
}

export interface ImportedItem {
	name: string;
	id: string;
	action: 'created' | 'skipped' | 'renamed' | 'replaced';
	/**
	 * For workflow `replace` imports only: the UUID of the workflow that was
	 * deleted to make room for the replacement. Used post-transaction to emit
	 * `spaceWorkflow.deleted` for the old UUID before emitting
	 * `spaceWorkflow.created` for the new one, ensuring SpaceStore removes the
	 * stale entry rather than appending a duplicate.
	 */
	previousId?: string;
}

export interface ImportExecuteResult {
	agents: ImportedItem[];
	workflows: ImportedItem[];
	warnings: string[];
}

// ============================================================================
// Private helpers
// ============================================================================

async function requireSpace(spaceManager: SpaceManager, spaceId: string): Promise<Space> {
	if (!spaceId) throw new Error('spaceId is required');
	const space = await spaceManager.getSpace(spaceId);
	if (!space) throw new Error(`Space not found: ${spaceId}`);
	return space;
}

/** Generate a name that does not collide with anything in `existingNames`. */
function generateUniqueName(baseName: string, existingNames: Set<string>): string {
	if (!existingNames.has(baseName)) return baseName;
	let counter = 1;
	while (counter < 10_000 && existingNames.has(`${baseName} (${counter})`)) counter++;
	if (counter >= 10_000) {
		throw new Error(`Cannot generate a unique name for "${baseName}": too many existing variants`);
	}
	return `${baseName} (${counter})`;
}

function buildAgentCreateParams(
	spaceId: string,
	name: string,
	exported: ExportedSpaceAgent
): CreateSpaceAgentParams {
	const params: CreateSpaceAgentParams = { spaceId, name };
	if (exported.description !== undefined) params.description = exported.description;
	if (exported.model !== undefined) params.model = exported.model;
	if (exported.thinkingLevel !== undefined) params.thinkingLevel = exported.thinkingLevel;
	if (exported.provider !== undefined) params.provider = exported.provider;
	// Combine legacy systemPrompt + instructions into customPrompt, joining with \n\n when both present
	const parts = [exported.systemPrompt, exported.instructions].filter(
		(s): s is string => typeof s === 'string' && s.length > 0
	);
	if (parts.length > 0) params.customPrompt = parts.join('\n\n');
	if (exported.tools !== undefined) params.tools = exported.tools;
	if (exported.settingSources !== undefined) params.settingSources = exported.settingSources;
	return params;
}

/**
 * Convert an `ExportedSpaceWorkflow` into `CreateSpaceWorkflowParams` suitable
 * for `SpaceWorkflowManager.createWorkflow()`.
 *
 * Node names are assigned fresh UUIDs; rule `appliesTo` arrays are remapped from
 * node names to those new UUIDs; agent refs are resolved via the two lookup maps.
 *
 * @returns params ready for the manager, the node-name→UUID map (for rule
 *          appliesTo remapping), and any warnings about unresolved agent refs.
 *
 * @internal Exported for unit testing. Callers outside tests should use the
 *   `spaceImport.execute` RPC handler which wraps this in a transaction.
 */
export function buildWorkflowCreateParams(
	spaceId: string,
	name: string,
	exported: ExportedSpaceWorkflow,
	importedAgentNameToId: Map<string, string>,
	existingAgentNameToId: Map<string, string>,
	usedWorkflowHandles?: Set<string>
): { params: CreateSpaceWorkflowParams; nodeNameToId: Map<string, string>; warnings: string[] } {
	const warnings: string[] = [];

	// Assign fresh UUIDs to each node (provides stable cross-reference within this import)
	const nodeNameToId = new Map<string, string>();
	for (const node of exported.nodes) {
		nodeNameToId.set(node.name, generateUUID());
	}

	// Build WorkflowNodeInput list — resolve agentRef names → UUIDs
	const nodes: WorkflowNodeInput[] = exported.nodes.map((exportedNode) => {
		// Resolve each agentRef name → UUID
		const agents = exportedNode.agents.map((a) => {
			const agentId =
				importedAgentNameToId.get(a.agentRef) ?? existingAgentNameToId.get(a.agentRef) ?? null;
			if (!agentId) {
				warnings.push(`node "${exportedNode.name}" references unknown agent "${a.agentRef}"`);
			}
			// agentId ?? '' is a placeholder for unresolved refs — warnings.length > 0 will
			// cause a throw before createWorkflow is called, so '' never reaches the DB.
			const entry: {
				agentId: string;
				name: string;
				model?: string;
				thinkingLevel?: import('@neokai/shared').ThinkingLevel;
				customPrompt?: import('@neokai/shared').WorkflowNodeAgentOverride;
				disabledSkillIds?: string[];
				extraMcpServers?: import('@neokai/shared').WorkflowNodeAgent['extraMcpServers'];
				timeoutMs?: number;
				toolGuards?: import('@neokai/shared').DeclarativeToolGuard[];
				eventInterests?: import('@neokai/shared').EventInterest[];
			} = {
				agentId: agentId ?? '',
				name: a.name,
			};
			if (typeof a.model === 'string' && a.model.trim()) entry.model = a.model.trim();
			if (a.thinkingLevel !== undefined) entry.thinkingLevel = a.thinkingLevel;
			// Normalize overrides: combine legacy systemPrompt + instructions into customPrompt.
			// Plain strings (legacy) are normalized to { value }; both fields are joined with \n\n.
			const normalizedSP = normalizeOverride(a.systemPrompt);
			const normalizedInst = normalizeOverride(a.instructions);
			if (normalizedSP !== undefined || normalizedInst !== undefined) {
				const parts = [normalizedSP?.value, normalizedInst?.value].filter(
					(s): s is string => typeof s === 'string' && s.length > 0
				);
				if (parts.length > 0) entry.customPrompt = { value: parts.join('\n\n') };
			}
			if (a.disabledSkillIds !== undefined) entry.disabledSkillIds = a.disabledSkillIds;
			if (a.extraMcpServers !== undefined)
				entry.extraMcpServers = a.extraMcpServers as Record<
					string,
					import('@neokai/shared').McpServerConfig
				>;
			if (typeof a.timeoutMs === 'number') entry.timeoutMs = a.timeoutMs;
			if (a.toolGuards !== undefined) entry.toolGuards = a.toolGuards;
			if (a.eventInterests !== undefined) entry.eventInterests = a.eventInterests;
			return entry;
		});

		const node: WorkflowNodeInput = {
			id: nodeNameToId.get(exportedNode.name)!,
			name: exportedNode.name,
			agents,
			postApproval: exportedNode.postApproval,
		};

		return node;
	});

	// Resolve startNode name → new UUID
	const startNodeId = nodeNameToId.get(exported.startNode);
	const endNodeId = exported.endNode ? nodeNameToId.get(exported.endNode) : undefined;

	const params: CreateSpaceWorkflowParams = {
		spaceId,
		name,
		nodes,
		tags: exported.tags,
		// Fall back to 3 when the exported bundle predates completionAutonomyLevel.
		// 3 ("Low Approval") matches the DB column default and is the safest neutral
		// choice for imports where the exporter didn't specify a level.
		completionAutonomyLevel: exported.completionAutonomyLevel ?? 3,
	};
	if (startNodeId) params.startNodeId = startNodeId;
	if (endNodeId) params.endNodeId = endNodeId;
	if (exported.description !== undefined) params.description = exported.description;
	if (exported.channels && exported.channels.length > 0) params.channels = exported.channels;
	if (exported.disabled !== undefined) params.disabled = exported.disabled;
	// Only preserve the exported handle when it is unique in the target space
	// and not already used by another workflow in the same import batch.
	// Otherwise let createWorkflow auto-generate a handle from the name.
	if (
		exported.handle !== undefined &&
		exported.handle.trim() !== '' &&
		(!usedWorkflowHandles || !usedWorkflowHandles.has(exported.handle))
	) {
		params.handle = exported.handle;
	}

	return { params, nodeNameToId, warnings };
}

/**
 * Validate cross-references in an exported workflow against the current import context.
 * Returns a list of human-readable error strings (empty = valid).
 *
 * Validates:
 * 1. Agent refs in nodes: each agentRef must resolve to a known agent name.
 * 2. Workflow-level channels: basic structural validation (direction, non-empty from/to).
 *
 * Note: condition expression validation is intentionally omitted here — it is
 * already enforced by the Zod schema in validateExportBundle(), so any bundle
 * that reaches this function has already had its conditions validated.
 *
 * @param importedAgentNames - Set of agent names being imported in the same bundle
 * @param existingAgentNameToId - Map of existing agent names → UUIDs in target space
 * @param agentNameToRole - Map of agent name → role (from bundle + space agents combined)
 */
function validateWorkflowForPreview(
	exported: ExportedSpaceWorkflow,
	importedAgentNames: Set<string>,
	existingAgentNameToId: Map<string, string>,
	agentNameToRole: Map<string, string>
): string[] {
	const errors: string[] = [];

	for (const node of exported.nodes) {
		// ── 1. Agent ref validation ───────────────────────────────────────────
		for (const a of node.agents) {
			if (!importedAgentNames.has(a.agentRef) && !existingAgentNameToId.has(a.agentRef)) {
				errors.push(
					`node "${node.name}" references unknown agent "${a.agentRef}" — not found in bundle or target space`
				);
			}
		}
	}

	// ── 2. Workflow-level channel validation ──────────────────────────────────
	if (exported.channels && exported.channels.length > 0) {
		for (let ci = 0; ci < exported.channels.length; ci++) {
			const ch = exported.channels[ci];
			const loc = `channels[${ci}]`;
			if (!ch.from || !ch.from.trim()) {
				errors.push(`${loc}: 'from' must be a non-empty node name string`);
			}
			const toList = Array.isArray(ch.to) ? ch.to : [ch.to];
			if (toList.length === 0) {
				errors.push(`${loc}: 'to' must not be empty`);
			}
		}
	}

	void agentNameToRole; // kept in signature for backward compatibility

	return errors;
}

// ============================================================================
// Setup
// ============================================================================

export function setupSpaceExportImportHandlers(
	messageHub: MessageHub,
	spaceManager: SpaceManager,
	agentRepo: SpaceAgentRepository,
	workflowRepo: SpaceWorkflowRepository,
	workflowManager: SpaceWorkflowManager,
	db: BunDatabase,
	internalEventBus: InternalEventBus<DaemonInternalEventMap>
): void {
	// ─── spaceExport.agents ──────────────────────────────────────────────────
	messageHub.onRequest('spaceExport.agents', async (data) => {
		const params = data as { spaceId: string; agentIds?: string[] };
		const space = await requireSpace(spaceManager, params.spaceId);

		let agents: SpaceAgent[] = agentRepo.getBySpaceId(params.spaceId);
		if (params.agentIds?.length) {
			const idSet = new Set(params.agentIds);
			agents = agents.filter((a) => idSet.has(a.id));
		}

		const bundle = exportBundle(agents, [], `${space.name} agents`, {
			exportedFrom: params.spaceId,
		});
		return { bundle };
	});

	// ─── spaceExport.workflows ───────────────────────────────────────────────
	messageHub.onRequest('spaceExport.workflows', async (data) => {
		const params = data as { spaceId: string; workflowIds?: string[] };
		const space = await requireSpace(spaceManager, params.spaceId);

		let workflows = workflowRepo.listWorkflows(params.spaceId);
		if (params.workflowIds?.length) {
			const idSet = new Set(params.workflowIds);
			workflows = workflows.filter((w) => idSet.has(w.id));
		}

		// All space agents are needed for correct agentId→name resolution inside exportBundle
		const allAgents = agentRepo.getBySpaceId(params.spaceId);

		// Export with full agent set so step agentRefs resolve to names, then trim the
		// bundle's agents array to only those actually referenced by the exported workflows.
		const full = exportBundle(allAgents, workflows, `${space.name} workflows`, {
			exportedFrom: params.spaceId,
		});

		const referencedNames = new Set<string>();
		for (const wf of full.workflows) {
			for (const node of wf.nodes) {
				for (const a of node.agents) referencedNames.add(a.agentRef);
			}
		}

		const bundle: SpaceExportBundle = {
			...full,
			agents: full.agents.filter((a) => referencedNames.has(a.name)),
		};

		return { bundle };
	});

	// ─── spaceExport.bundle ──────────────────────────────────────────────────
	messageHub.onRequest('spaceExport.bundle', async (data) => {
		const params = data as { spaceId: string; agentIds?: string[]; workflowIds?: string[] };
		const space = await requireSpace(spaceManager, params.spaceId);

		let agents = agentRepo.getBySpaceId(params.spaceId);
		if (params.agentIds?.length) {
			const idSet = new Set(params.agentIds);
			agents = agents.filter((a) => idSet.has(a.id));
		}

		let workflows = workflowRepo.listWorkflows(params.spaceId);
		if (params.workflowIds?.length) {
			const idSet = new Set(params.workflowIds);
			workflows = workflows.filter((w) => idSet.has(w.id));
		}

		const bundle = exportBundle(agents, workflows, `${space.name} bundle`, {
			exportedFrom: params.spaceId,
		});
		return { bundle };
	});

	// ─── spaceImport.preview ─────────────────────────────────────────────────
	messageHub.onRequest('spaceImport.preview', async (data) => {
		const params = data as { bundle: unknown; spaceId: string };
		await requireSpace(spaceManager, params.spaceId);

		// Validate bundle structure and version
		const validation = validateExportBundle(params.bundle);
		if (!validation.ok) {
			const result: ImportPreviewResult = {
				agents: [],
				workflows: [],
				validationErrors: [validation.error],
			};
			return result;
		}
		const bundle = validation.value;

		// Load existing entities in target space
		const existingAgents = agentRepo.getBySpaceId(params.spaceId);
		const existingWorkflows = workflowRepo.listWorkflows(params.spaceId);

		const existingAgentByName = new Map(existingAgents.map((a) => [a.name, a]));
		const existingWorkflowByName = new Map(existingWorkflows.map((w) => [w.name, w]));
		const existingAgentNameToId = new Map(existingAgents.map((a) => [a.name, a.id]));

		// Build name map for channel validation (role field no longer exists).
		const agentNameToRole = new Map<string, string>(existingAgents.map((a) => [a.name, a.name]));

		// Agent previews
		const agentPreviews: ImportPreview[] = bundle.agents.map((a) => {
			const existing = existingAgentByName.get(a.name);
			if (existing) return { name: a.name, action: 'conflict', existingId: existing.id };
			return { name: a.name, action: 'create' };
		});

		// Workflow previews + validation
		const workflowPreviews: ImportPreview[] = [];
		const validationErrors: string[] = [];

		const importedAgentNames = new Set(bundle.agents.map((a) => a.name));

		for (const wf of bundle.workflows) {
			const existing = existingWorkflowByName.get(wf.name);
			if (existing) {
				workflowPreviews.push({ name: wf.name, action: 'conflict', existingId: existing.id });
			} else {
				workflowPreviews.push({ name: wf.name, action: 'create' });
			}

			// Cross-reference validation (unresolved agent refs + channel role refs)
			const errors = validateWorkflowForPreview(
				wf,
				importedAgentNames,
				existingAgentNameToId,
				agentNameToRole
			);
			for (const err of errors) {
				validationErrors.push(`Workflow "${wf.name}": ${err}`);
			}
		}

		const result: ImportPreviewResult = {
			agents: agentPreviews,
			workflows: workflowPreviews,
			validationErrors,
		};
		return result;
	});

	// ─── spaceImport.execute ─────────────────────────────────────────────────
	messageHub.onRequest('spaceImport.execute', async (data) => {
		const params = data as {
			spaceId: string;
			bundle: unknown;
			conflictResolution?: ImportConflictResolution;
		};
		// Space check is async — must happen outside the synchronous transaction
		await requireSpace(spaceManager, params.spaceId);

		// Re-validate bundle (guards against stale previews or tampered payloads)
		const validation = validateExportBundle(params.bundle);
		if (!validation.ok) {
			throw new Error(`Invalid bundle: ${validation.error}`);
		}
		const bundle = validation.value;
		const resolution = params.conflictResolution ?? {};

		// All DB mutations are wrapped in a single transaction so that any failure
		// (unresolved agent ref, workflow validation error, etc.) rolls back the
		// entire import — no partial state is committed to the database.
		const executeImport = db.transaction(
			(spaceId: string, res: ImportConflictResolution): ImportExecuteResult => {
				// Snapshot of existing entities (before any mutations)
				const existingAgents = agentRepo.getBySpaceId(spaceId);
				const existingWorkflows = workflowRepo.listWorkflows(spaceId);

				const existingAgentByName = new Map(existingAgents.map((a) => [a.name, a]));
				const existingWorkflowByName = new Map(existingWorkflows.map((w) => [w.name, w]));
				const existingAgentNameToId = new Map(existingAgents.map((a) => [a.name, a.id]));

				// Mutable sets for uniqueness tracking across the import batch
				const usedAgentNames = new Set(existingAgents.map((a) => a.name));
				const usedWorkflowNames = new Set(existingWorkflows.map((w) => w.name));
				const usedWorkflowHandles = new Set(
					existingWorkflows.map((w) => w.handle).filter((h): h is string => !!h)
				);

				// ── Phase 1: import agents ──────────────────────────────────────
				// Maps original bundle agent name → assigned UUID (used for workflow cross-refs)
				const importedAgentNameToId = new Map<string, string>();
				const agentResults: ImportedItem[] = [];

				for (const exportedAgent of bundle.agents) {
					const existing = existingAgentByName.get(exportedAgent.name);

					if (!existing) {
						// No conflict — create new agent
						const created = agentRepo.create(
							buildAgentCreateParams(spaceId, exportedAgent.name, exportedAgent)
						);
						usedAgentNames.add(exportedAgent.name);
						importedAgentNameToId.set(exportedAgent.name, created.id);
						agentResults.push({ name: exportedAgent.name, id: created.id, action: 'created' });
						continue;
					}

					// Conflict — apply resolution strategy (default: skip)
					const strategy: ConflictResolutionStrategy = res.agents?.[exportedAgent.name] ?? 'skip';

					if (strategy === 'skip') {
						importedAgentNameToId.set(exportedAgent.name, existing.id);
						agentResults.push({ name: exportedAgent.name, id: existing.id, action: 'skipped' });
					} else if (strategy === 'replace') {
						// Overwrite existing agent in place (preserve UUID and spaceId).
						// Fields absent from the export are explicitly cleared (null → empty string
						// or null) so that replace produces the same result as delete + create.
						// Combine legacy systemPrompt + instructions into customPrompt on replace.
						const replaceParts = [exportedAgent.systemPrompt, exportedAgent.instructions].filter(
							(s): s is string => typeof s === 'string' && s.length > 0
						);
						const updated = agentRepo.update(existing.id, {
							description: exportedAgent.description ?? null,
							model: exportedAgent.model ?? null,
							thinkingLevel: exportedAgent.thinkingLevel ?? null,
							provider: exportedAgent.provider ?? null,
							customPrompt: replaceParts.length > 0 ? replaceParts.join('\n\n') : null,
							tools: exportedAgent.tools ?? null,
							settingSources: exportedAgent.settingSources ?? null,
						});
						const id = updated?.id ?? existing.id;
						importedAgentNameToId.set(exportedAgent.name, id);
						agentResults.push({ name: exportedAgent.name, id, action: 'replaced' });
					} else {
						// rename — create with a unique name; the original bundle name remains the
						// cross-reference key so workflow nodes still resolve correctly.
						const finalName = generateUniqueName(exportedAgent.name, usedAgentNames);
						const created = agentRepo.create(
							buildAgentCreateParams(spaceId, finalName, exportedAgent)
						);
						usedAgentNames.add(finalName);
						importedAgentNameToId.set(exportedAgent.name, created.id);
						agentResults.push({ name: finalName, id: created.id, action: 'renamed' });
					}
				}

				// ── Phase 2 pre-step: delete all replace-strategy workflows ────────
				// Deleting upfront frees both name slots and handle slots in the DB
				// before any new workflow tries to claim them, making handle preservation
				// independent of iteration order within the bundle.
				const replacedIdByName = new Map<string, string>();
				for (const exportedWorkflow of bundle.workflows) {
					const existing = existingWorkflowByName.get(exportedWorkflow.name);
					if (!existing) continue;
					const strategy: ConflictResolutionStrategy =
						res.workflows?.[exportedWorkflow.name] ?? 'skip';
					if (strategy === 'replace') {
						workflowRepo.deleteWorkflow(existing.id);
						replacedIdByName.set(exportedWorkflow.name, existing.id);
						usedWorkflowNames.delete(exportedWorkflow.name);
						if (existing.handle) usedWorkflowHandles.delete(existing.handle);
					}
				}

				// ── Phase 2: import workflows ────────────────────────────────────
				const workflowResults: ImportedItem[] = [];
				const allWarnings: string[] = [];

				for (const exportedWorkflow of bundle.workflows) {
					const existing = existingWorkflowByName.get(exportedWorkflow.name);

					let finalName = exportedWorkflow.name;
					let action: ImportedItem['action'] = 'created';
					let replacedOldId: string | undefined;

					if (!existing) {
						// No conflict — create as-is
					} else {
						const strategy: ConflictResolutionStrategy =
							res.workflows?.[exportedWorkflow.name] ?? 'skip';

						if (strategy === 'skip') {
							workflowResults.push({
								name: exportedWorkflow.name,
								id: existing.id,
								action: 'skipped',
							});
							continue;
						}

						if (strategy === 'replace') {
							// Already deleted in the pre-step above.
							replacedOldId = replacedIdByName.get(exportedWorkflow.name);
							action = 'replaced';
						} else {
							// rename
							finalName = generateUniqueName(exportedWorkflow.name, usedWorkflowNames);
							action = 'renamed';
						}
					}

					// Reserve the name before calling createWorkflow so that duplicate workflow
					// names within the same bundle (same strategy = rename) produce different names.
					usedWorkflowNames.add(finalName);

					const { params: createParams, warnings } = buildWorkflowCreateParams(
						spaceId,
						finalName,
						exportedWorkflow,
						importedAgentNameToId,
						existingAgentNameToId,
						usedWorkflowHandles
					);

					// Surface handle conflicts with existing space workflows as warnings so
					// callers know the imported handle was rewritten rather than preserved.
					const exportedHandle =
						typeof exportedWorkflow.handle === 'string' ? exportedWorkflow.handle.trim() : '';
					if (exportedHandle && usedWorkflowHandles.has(exportedHandle)) {
						allWarnings.push(
							`Workflow "${finalName}": exported handle "${exportedHandle}" already exists in the target space; a new handle was auto-generated`
						);
					}

					// Fail fast on unresolved agent refs — they would produce invalid DB rows.
					// The transaction ensures the delete (replace strategy) is also rolled back.
					if (warnings.length > 0) {
						for (const w of warnings) {
							allWarnings.push(`Workflow "${finalName}": ${w}`);
						}
						throw new Error(
							`Cannot import workflow "${finalName}": unresolved agent reference(s) — run spaceImport.preview to see details`
						);
					}

					// workflowManager.createWorkflow validates nodes/transitions/conditions and writes to DB
					const created = workflowManager.createWorkflow(createParams);
					// Track the handle assigned to this workflow so later imports in
					// the same batch don't collide with it.
					if (created.handle) usedWorkflowHandles.add(created.handle);
					const wfItem: ImportedItem = { name: finalName, id: created.id, action };
					if (action === 'replaced' && typeof replacedOldId !== 'undefined') {
						wfItem.previousId = replacedOldId;
					}
					workflowResults.push(wfItem);
				}

				return {
					agents: agentResults,
					workflows: workflowResults,
					warnings: allWarnings,
				};
			}
		);

		const importResult = executeImport(params.spaceId, resolution);

		// Emit real-time events so SpaceStore updates its agent/workflow signals.
		// Events are fired after the transaction commits — one per imported item.
		// "skipped" items produce no event (the existing record is unchanged).
		const spaceId = params.spaceId;

		for (const item of importResult.agents) {
			if (item.action === 'skipped') continue;
			const agent: SpaceAgent | null = agentRepo.getById(item.id);
			if (!agent) continue;
			const eventName = item.action === 'replaced' ? 'spaceAgent.updated' : 'spaceAgent.created';
			internalEventBus
				.publish(eventName, {
					sessionId: `space:${spaceId}`,
					spaceId,
					agent,
				})
				.catch((err) => {
					log.warn(`Failed to emit ${eventName} for imported agent "${item.name}":`, err);
				});
		}

		for (const item of importResult.workflows) {
			if (item.action === 'skipped') continue;
			// P2: use getWorkflow for O(1) lookup instead of a full list scan
			const workflow: SpaceWorkflow | null = workflowRepo.getWorkflow(item.id);
			if (!workflow) continue;

			if (item.action === 'replaced' && item.previousId) {
				// P1: emit deleted for old UUID so SpaceStore removes the stale entry,
				// then emit created for the new UUID so it is added fresh.
				internalEventBus
					.publish('spaceWorkflow.deleted', {
						sessionId: 'global',
						spaceId,
						workflowId: item.previousId,
					})
					.catch((err) => {
						log.warn(
							`Failed to emit spaceWorkflow.deleted for replaced workflow "${item.name}":`,
							err
						);
					});
				internalEventBus
					.publish('spaceWorkflow.created', {
						sessionId: 'global',
						spaceId,
						workflow,
					})
					.catch((err) => {
						log.warn(
							`Failed to emit spaceWorkflow.created for replaced workflow "${item.name}":`,
							err
						);
					});
			} else {
				internalEventBus
					.publish('spaceWorkflow.created', {
						sessionId: 'global',
						spaceId,
						workflow,
					})
					.catch((err) => {
						log.warn(
							`Failed to emit spaceWorkflow.created for imported workflow "${item.name}":`,
							err
						);
					});
			}
		}

		return importResult;
	});
}
