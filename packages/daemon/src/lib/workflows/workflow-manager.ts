import type {
  CreateSpaceWorkflowParams,
  SpaceWorkflow,
  SpaceWorkflowSummary,
  UpdateSpaceWorkflowParams,
  WorkflowNodeInput,
} from '@hyperneo/shared';
import { generateUUID } from '@hyperneo/shared';
import type { SpaceLongHorizonAgentRepository } from '../../storage/repositories/space-long-horizon-agent-repository.ts';
import type { SpaceWorkflowRepository } from '../../storage/repositories/space-workflow-repository.ts';
import { isRunnableUnifiedAgent } from '../agents/worker-long-horizon-mapper.ts';
import { Logger } from '../logger.ts';
import { validatePostApproval, validatePostApprovalRoutes } from './post-approval-validator.ts';
import '../github/connectors/production.ts';
import type { SpaceAgentTemplateRepository } from '../../storage/repositories/space-agent-template-repository.ts';
import {
  validateChannels,
  validateEndNodeId,
  validateHooks,
  validateNoDuplicateHookIds,
  validateStartNodeId,
  validateTransitions,
} from './workflow-graph-validation.ts';
import {
  generateUniqueHandle,
  validateHandle,
  validateName,
} from './workflow-identity-validation.ts';
import {
  validateNodes,
  validateStableNodeIds,
  type WorkflowNodeAgentRefDeps,
} from './workflow-node-validation.ts';
import {
  WorkflowDeletionBlockedError,
  WorkflowValidationError,
} from './workflow-validation-error.ts';

const logger = new Logger('SpaceWorkflowManager');
export interface SpaceAgentLookup {
  getAgentById(spaceId: string, id: string): { id: string; name: string } | null;
}

export function createSpaceAgentLookup(
  longHorizonAgentRepo: Pick<SpaceLongHorizonAgentRepository, 'getById'>
): SpaceAgentLookup {
  return {
    getAgentById(spaceId: string, id: string) {
      const unified = longHorizonAgentRepo.getById(id);
      if (unified && unified.spaceId === spaceId) {
        if (!isRunnableUnifiedAgent(unified)) return null;
        return { id: unified.id, name: unified.displayName };
      }
      return null;
    },
  };
}

export { isReservedWorkflowAgentName } from './workflow-node-validation.ts';
export {
  WorkflowDeletionBlockedError,
  WorkflowValidationError,
} from './workflow-validation-error.ts';

export class SpaceWorkflowManager {
  constructor(
    private repo: SpaceWorkflowRepository,
    private agentLookup: SpaceAgentLookup | null = null,
    private templateRepo?: SpaceAgentTemplateRepository
  ) {}

  createWorkflow(params: CreateSpaceWorkflowParams): SpaceWorkflow {
    const trimmedName = params.name.trim();
    validateName(this.repo, params.spaceId, trimmedName, null);
    const nodes = (params.nodes ?? []).map((node) => ({
      ...node,
      id: node.id ?? generateUUID(),
    }));
    validateNodes(params.spaceId, nodes, this.agentRefDeps());

    const fallbackStartNodeId = nodes[0]?.id ?? '';
    const fallbackEndNodeId = nodes[nodes.length - 1]?.id ?? '';
    const startNodeId =
      params.startNodeId == null ? fallbackStartNodeId : params.startNodeId.trim();
    const endNodeId = params.endNodeId == null ? fallbackEndNodeId : params.endNodeId.trim();

    validateStartNodeId(startNodeId, nodes);
    validateEndNodeId(endNodeId, nodes);

    validateNoDuplicateHookIds(params.hooks ?? []);

    if (params.channels && params.channels.length > 0) {
      validateChannels(params.channels);
    }

    validateHooks(params.hooks ?? [], nodes);

    validateTransitions(nodes, params.hooks ?? []);

    const postApprovalResult = validatePostApprovalRoutes({
      workflowPostApproval: params.postApproval,
      nodes,
    });
    if (!postApprovalResult.ok) {
      throw new WorkflowValidationError(postApprovalResult.error);
    }

    let handle: string;
    if (params.handle !== undefined && params.handle !== null) {
      if (typeof params.handle !== 'string') {
        throw new WorkflowValidationError('Workflow handle must be a string');
      }
      const trimmedHandle = params.handle.trim();
      validateHandle(this.repo, params.spaceId, trimmedHandle, null);
      handle = trimmedHandle;
    } else {
      handle = generateUniqueHandle(this.repo, params.spaceId, trimmedName);
    }

    return this.repo.createWorkflow({
      ...params,
      name: trimmedName,
      nodes,
      startNodeId,
      endNodeId,
      handle,
    });
  }

  getWorkflow(id: string): SpaceWorkflow | null {
    const result = this.getWorkflowForRunStart(id);
    return result?.workflow ?? null;
  }

  getWorkflowForRunStart(
    id: string
  ): { rawWorkflow: SpaceWorkflow; workflow: SpaceWorkflow } | null {
    const rawWorkflow = this.repo.getWorkflow(id);
    if (!rawWorkflow) return null;
    return {
      rawWorkflow,
      workflow: this.sanitizePostApprovalForLoad(rawWorkflow),
    };
  }

  getWorkflowForRun(run: {
    workflowId: string;
    definitionVersion: string | null;
  }): SpaceWorkflow | null {
    const raw = this.repo.getWorkflowForRun(run);
    if (!raw) return null;
    return this.sanitizePostApprovalForLoad(raw);
  }

  getWorkflowByHandle(spaceId: string, handle: string): SpaceWorkflow | null {
    const wf = this.repo.getWorkflowByHandle(spaceId, handle);
    if (!wf) return null;
    return this.sanitizePostApprovalForLoad(wf);
  }

  listWorkflows(spaceId: string): SpaceWorkflow[] {
    return this.repo.listWorkflows(spaceId).map((wf) => this.sanitizePostApprovalForLoad(wf));
  }

  listWorkflowSummaries(spaceId: string): SpaceWorkflowSummary[] {
    return this.repo.listWorkflowSummaries(spaceId);
  }

  private sanitizePostApprovalForLoad(wf: SpaceWorkflow): SpaceWorkflow {
    let sanitized: SpaceWorkflow | null = null;

    if (wf.postApproval) {
      const result = validatePostApproval({ postApproval: wf.postApproval, nodes: wf.nodes });
      if (!result.ok) {
        logger.warn(
          `disabling stale postApproval route on workflow ${wf.id} ` +
            `(space ${wf.spaceId}): ${result.error}`
        );
        sanitized = { ...(sanitized ?? wf) };
        delete sanitized.postApproval;
      }
    }

    const nextNodes = (sanitized ?? wf).nodes.map((node) => {
      if (!node.postApproval) return node;
      const result = validatePostApproval({ postApproval: node.postApproval, nodes: wf.nodes });
      if (result.ok) return node;
      logger.warn(
        `disabling stale postApproval route on workflow ${wf.id} node ${node.id} ` +
          `(space ${wf.spaceId}): ${result.error}`
      );
      const nextNode = { ...node };
      delete nextNode.postApproval;
      sanitized = { ...(sanitized ?? wf) };
      return nextNode;
    });

    const withSanitizedNodes = sanitized ? { ...sanitized, nodes: nextNodes } : wf;
    return withSanitizedNodes;
  }

  updateBuiltInIdentity(
    id: string,
    identity: Pick<UpdateSpaceWorkflowParams, 'name' | 'handle' | 'templateName'>
  ): SpaceWorkflow | null {
    const existing = this.repo.getWorkflow(id);
    if (!existing) return null;
    const name = identity.name?.trim();
    if (!name) throw new WorkflowValidationError('Workflow name is required');
    validateName(this.repo, existing.spaceId, name, id);
    if (typeof identity.handle !== 'string') {
      throw new WorkflowValidationError('Workflow handle must be a string');
    }
    const handle = identity.handle.trim();
    validateHandle(this.repo, existing.spaceId, handle, id);
    return this.repo.updateWorkflow(id, {
      name,
      handle,
      templateName: identity.templateName,
    });
  }

  stampBuiltInTemplateName(id: string, templateName: string): SpaceWorkflow | null {
    const existing = this.repo.getWorkflow(id);
    if (!existing) return null;
    return this.repo.updateWorkflow(id, { templateName });
  }

  stampBuiltInTags(id: string, tags: string[]): SpaceWorkflow | null {
    const existing = this.repo.getWorkflow(id);
    if (!existing) return null;
    return this.repo.updateWorkflow(id, { tags });
  }

  updateWorkflow(id: string, params: UpdateSpaceWorkflowParams): SpaceWorkflow | null {
    const existing = this.repo.getWorkflow(id);
    if (!existing) return null;

    if (params.name !== undefined) {
      const trimmedName = params.name.trim();
      validateName(this.repo, existing.spaceId, trimmedName, id);
      params = { ...params, name: trimmedName };
      if (
        trimmedName !== existing.name &&
        params.handle === undefined &&
        typeof existing.handle === 'string'
      ) {
        params = {
          ...params,
          handle: generateUniqueHandle(this.repo, existing.spaceId, trimmedName, id),
        };
      }
    }
    if (params.handle !== undefined && params.handle !== null) {
      if (typeof params.handle !== 'string') {
        throw new WorkflowValidationError('Workflow handle must be a string');
      }
      const trimmedHandle = params.handle.trim();
      validateHandle(this.repo, existing.spaceId, trimmedHandle, id);
      params = { ...params, handle: trimmedHandle };
    }
    if (params.nodes !== undefined) {
      validateStableNodeIds(id, existing.nodes, params.nodes ?? [], {
        allowStructuralChanges: true,
      });
    }

    const effectiveNodes: WorkflowNodeInput[] =
      params.nodes !== undefined
        ? (params.nodes ?? []).map(
            (n): WorkflowNodeInput => ({
              id: n.id,
              name: n.name,
              agents: n.agents,
              postApproval: n.postApproval,
              transitions: n.transitions,
            })
          )
        : existing.nodes.map(
            (n): WorkflowNodeInput => ({
              id: n.id,
              name: n.name,
              agents: n.agents,
              postApproval: n.postApproval,
              transitions: n.transitions,
            })
          );

    validateNodes(existing.spaceId, effectiveNodes, this.agentRefDeps());

    const fallbackStartNodeId = effectiveNodes[0]?.id ?? '';
    const fallbackEndNodeId = effectiveNodes[effectiveNodes.length - 1]?.id ?? '';
    const nodeIds = new Set(effectiveNodes.map((n) => n.id));
    const startNodeIdInput =
      params.startNodeId === undefined ? existing.startNodeId : params.startNodeId;
    const endNodeIdInput = params.endNodeId === undefined ? existing.endNodeId : params.endNodeId;
    const explicitStartNodeId = params.startNodeId !== undefined;
    const explicitEndNodeId = params.endNodeId !== undefined;
    const normalizedStartNodeId =
      startNodeIdInput == null ? fallbackStartNodeId : startNodeIdInput.trim();
    const normalizedEndNodeId = endNodeIdInput == null ? fallbackEndNodeId : endNodeIdInput.trim();
    const resolvedStartNodeId =
      !explicitStartNodeId && !nodeIds.has(normalizedStartNodeId)
        ? fallbackStartNodeId
        : normalizedStartNodeId;
    const resolvedEndNodeId =
      !explicitEndNodeId && !nodeIds.has(normalizedEndNodeId)
        ? fallbackEndNodeId
        : normalizedEndNodeId;

    validateStartNodeId(resolvedStartNodeId, effectiveNodes);
    validateEndNodeId(resolvedEndNodeId, effectiveNodes);
    params = { ...params, startNodeId: resolvedStartNodeId, endNodeId: resolvedEndNodeId };

    if (params.channels && params.channels.length > 0) {
      validateChannels(params.channels);
    }

    validateNoDuplicateHookIds(params.hooks ?? []);

    const effectiveHooks =
      params.hooks === undefined ? (existing.hooks ?? []) : (params.hooks ?? []);
    validateHooks(effectiveHooks, effectiveNodes);
    validateTransitions(effectiveNodes, effectiveHooks);

    const workflowPostApproval =
      params.postApproval === undefined
        ? existing.postApproval
        : (params.postApproval ?? undefined);
    const routeResult = validatePostApprovalRoutes({
      workflowPostApproval,
      nodes: effectiveNodes,
    });
    if (!routeResult.ok) {
      throw new WorkflowValidationError(routeResult.error);
    }

    return this.repo.updateWorkflow(id, params);
  }

  updateWorkflowNodeToolGuards(id: string, nodes: SpaceWorkflow['nodes']): void {
    const existing = this.repo.getWorkflow(id);
    if (!existing) {
      throw new WorkflowValidationError(`Workflow not found: ${id}`);
    }
    validateStableNodeIds(id, existing.nodes, nodes);
    this.repo.updateWorkflowNodeToolGuards(id, nodes);
  }

  private agentRefDeps(): WorkflowNodeAgentRefDeps {
    return { agentLookup: this.agentLookup, templateRepo: this.templateRepo };
  }

  hasExecutableRuns(id: string): boolean {
    return this.repo.hasExecutableRuns(id);
  }

  deleteWorkflow(id: string): boolean {
    const existing = this.repo.getWorkflow(id);
    if (!existing) return false;
    if (this.repo.hasExecutableRuns(id)) {
      throw new WorkflowDeletionBlockedError(
        `Cannot delete workflow "${existing.name}" (${id}): it has run(s) that ` +
          `are still executable (in progress, or not archived). Archive the ` +
          `task(s) and let the run(s) finish first, or keep the workflow.`,
        id
      );
    }
    return this.repo.deleteWorkflow(id);
  }
}
