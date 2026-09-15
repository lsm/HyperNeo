import type { WorkflowChannel, WorkflowHook, WorkflowNodeInput } from '@hyperneo/shared';
import { HANDOFF_TARGET_WILDCARD, MAX_NODE_HANDOFF_TRANSITIONS } from '@hyperneo/shared';
import { validateWorkflowHooks } from './hook-validation.ts';
import { WorkflowValidationError } from './workflow-validation-error.ts';

export function validateChannels(channels: WorkflowChannel[]): void {
  for (let ci = 0; ci < channels.length; ci++) {
    const ch = channels[ci];
    const loc = `channels[${ci}]`;

    if (!ch.from || !ch.from.trim()) {
      throw new WorkflowValidationError(`${loc}: 'from' must be a non-empty node name string`);
    }

    if (Array.isArray(ch.to)) {
      if (ch.to.length === 0) {
        throw new WorkflowValidationError(
          `${loc}: 'to' array must contain at least one agent name string`
        );
      }
      for (let ti = 0; ti < ch.to.length; ti++) {
        if (!ch.to[ti] || !ch.to[ti].trim()) {
          throw new WorkflowValidationError(
            `${loc}.to[${ti}]: must be a non-empty agent name string`
          );
        }
      }
    } else {
      if (!ch.to || !(ch.to as string).trim()) {
        throw new WorkflowValidationError(`${loc}: 'to' must be a non-empty agent name string`);
      }
    }
  }
}

export function validateTransitions(nodes: WorkflowNodeInput[], hooks: WorkflowHook[]): void {
  const hookIds = new Set(hooks.map((h) => h.id));
  const targetNameDestinations = new Map<string, Set<string>>();
  const addDestination = (name: string, destinationKey: string) => {
    const set = targetNameDestinations.get(name) ?? new Set<string>();
    set.add(destinationKey);
    targetNameDestinations.set(name, set);
  };
  for (const node of nodes) {
    const nodeId = node.id ?? node.name;
    addDestination(node.name, `node:${nodeId}`);
    for (const agent of node.agents ?? []) {
      if (agent.name) addDestination(agent.name, `slot:${nodeId}`);
    }
  }

  for (let ni = 0; ni < nodes.length; ni++) {
    const node = nodes[ni];
    const transitions = node.transitions;
    if (transitions === undefined) continue;
    if (!Array.isArray(transitions)) {
      throw new WorkflowValidationError(`node[${ni}] "${node.name}": transitions must be an array`);
    }
    if (transitions.length === 0) continue;

    const seenIds = new Set<string>();
    const seenTargets = new Set<string>();
    if (transitions.length > MAX_NODE_HANDOFF_TRANSITIONS) {
      throw new WorkflowValidationError(
        `node[${ni}] "${node.name}": transitions cannot contain more than ${MAX_NODE_HANDOFF_TRANSITIONS} entries`
      );
    }
    for (let ti = 0; ti < transitions.length; ti++) {
      const t = transitions[ti];
      const loc = `node[${ni}] "${node.name}".transitions[${ti}]`;

      if (!t || typeof t !== 'object') {
        throw new WorkflowValidationError(`${loc}: transition must be an object`);
      }
      if (typeof t.id !== 'string') {
        throw new WorkflowValidationError(`${loc}: 'id' must be a string`);
      }
      if (!t.id.trim()) {
        throw new WorkflowValidationError(`${loc}: 'id' must be a non-empty string`);
      }
      if (t.id.length > 100) {
        throw new WorkflowValidationError(`${loc}: 'id' must be at most 100 characters`);
      }
      if (t.label !== undefined && typeof t.label !== 'string') {
        throw new WorkflowValidationError(`${loc}: 'label' must be a string`);
      }
      if (typeof t.label === 'string' && t.label.length > 200) {
        throw new WorkflowValidationError(`${loc}: 'label' must be at most 200 characters`);
      }
      if (seenIds.has(t.id)) {
        throw new WorkflowValidationError(
          `${loc}: duplicate transition id "${t.id}" within node "${node.name}"`
        );
      }
      seenIds.add(t.id);

      if (typeof t.target !== 'string') {
        throw new WorkflowValidationError(`${loc}: 'target' must be a string`);
      }
      if (!t.target.trim()) {
        throw new WorkflowValidationError(`${loc}: 'target' must be a non-empty string`);
      }
      if (t.target.length > 100) {
        throw new WorkflowValidationError(`${loc}: 'target' must be at most 100 characters`);
      }
      if (t.target !== HANDOFF_TARGET_WILDCARD) {
        const destinations = targetNameDestinations.get(t.target);
        if (!destinations || destinations.size === 0) {
          throw new WorkflowValidationError(
            `${loc}: target "${t.target}" does not reference a known node name or agent slot name`
          );
        }
        if (destinations.size > 1) {
          throw new WorkflowValidationError(
            `${loc}: target "${t.target}" is ambiguous — matches ${destinations.size} destinations; ` +
              'use a name unique to one node or slot'
          );
        }
      }
      if (seenTargets.has(t.target)) {
        throw new WorkflowValidationError(
          `${loc}: duplicate transition target "${t.target}" within node "${node.name}" — ` +
            'a handoff target must resolve to a single declared transition'
        );
      }
      seenTargets.add(t.target);

      if (t.hookId !== undefined) {
        if (typeof t.hookId !== 'string') {
          throw new WorkflowValidationError(`${loc}: 'hookId' must be a string`);
        }
        if (!t.hookId.trim()) {
          throw new WorkflowValidationError(`${loc}: 'hookId' must be a non-empty string`);
        }
        if (t.hookId.length > 100) {
          throw new WorkflowValidationError(`${loc}: 'hookId' must be at most 100 characters`);
        }
        if (!hookIds.has(t.hookId)) {
          throw new WorkflowValidationError(
            `${loc}: hookId "${t.hookId}" does not reference a known hook`
          );
        }
      }

      if (t.maxCycles !== undefined) {
        if (typeof t.maxCycles !== 'number' || !Number.isFinite(t.maxCycles)) {
          throw new WorkflowValidationError(`${loc}: 'maxCycles' must be a finite number`);
        }
        if (t.maxCycles <= 0 || !Number.isInteger(t.maxCycles)) {
          throw new WorkflowValidationError(`${loc}: 'maxCycles' must be a positive integer`);
        }
      }
    }
  }
}

export function validateHooks(hooks: unknown[], nodes: WorkflowNodeInput[]): void {
  const errors = validateWorkflowHooks(hooks, nodes);
  if (errors.length > 0) {
    throw new WorkflowValidationError(errors.join('; '));
  }
}

export function validateNoDuplicateHookIds(hooks: unknown[]): void {
  const seen = new Set<string>();
  for (let hi = 0; hi < hooks.length; hi++) {
    const hook = hooks[hi];
    if (!hook || typeof hook !== 'object') continue;
    const id = (hook as { id?: unknown }).id;
    if (typeof id !== 'string') continue;
    if (seen.has(id)) {
      throw new WorkflowValidationError(`hooks[${hi}].id: duplicate hook id "${id}"`);
    }
    seen.add(id);
  }
}

export function validateStartNodeId(startNodeId: string, nodes: WorkflowNodeInput[]): void {
  if (!startNodeId.trim()) {
    throw new WorkflowValidationError('startNodeId must be a non-empty string');
  }
  const nodeIds = new Set(nodes.map((n) => n.id));
  if (!nodeIds.has(startNodeId)) {
    throw new WorkflowValidationError(
      `startNodeId "${startNodeId}" does not match any node in this workflow`
    );
  }
}

export function validateEndNodeId(endNodeId: string, nodes: WorkflowNodeInput[]): void {
  if (!endNodeId.trim()) {
    throw new WorkflowValidationError('endNodeId must be a non-empty string');
  }
  const endNode = nodes.find((n) => n.id === endNodeId);
  if (!endNode) {
    throw new WorkflowValidationError(
      `endNodeId "${endNodeId}" does not match any node in this workflow`
    );
  }
  const agentCount = endNode.agents?.length ?? 0;
  if (agentCount !== 1) {
    throw new WorkflowValidationError(
      `endNode "${endNode.name}" must have exactly 1 agent (has ${agentCount}); ` +
        `end nodes own the workflow completion signal via task.reportedStatus`
    );
  }
}
