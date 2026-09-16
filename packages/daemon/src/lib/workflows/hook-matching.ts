import type { SpaceWorkflow, WorkflowHook } from '@hyperneo/shared';
import { parseAddress } from '../../../../messaging/src/address.ts';
import { ChannelResolver } from '../messaging/channel-resolver.ts';
import type { HookActionMeta } from './hook-engine.ts';

export function resolveMatchingHooks(
  workflow: SpaceWorkflow,
  workflowRunId: string,
  methodName: string,
  params: Record<string, unknown>,
  meta: HookActionMeta
): WorkflowHook[] {
  if (!workflow?.hooks) return [];

  const nodeName = workflow.nodes.find((n) => n.id === meta.nodeId)?.name ?? meta.agentName;

  const slotToNodes = new Map<string, string[]>();
  for (const node of workflow.nodes) {
    for (const agent of node.agents ?? []) {
      const arr = slotToNodes.get(agent.name) ?? [];
      if (!arr.includes(node.name)) {
        arr.push(node.name);
      }
      slotToNodes.set(agent.name, arr);
    }
  }

  const fromNode = nodeName;
  const nodeIdToName = new Map(workflow.nodes.map((n) => [n.id, n.name]));
  const nodeNames = new Set(workflow.nodes.map((n) => n.name));
  const resolver = new ChannelResolver(workflow.channels ?? []);

  const actionTargets = new Set<string>();
  let allRequestedTargetsRoutable = true;
  const isRoutableTarget = (targetNode: string): boolean =>
    nodeNames.has(targetNode) &&
    (resolver.canSend(fromNode, targetNode) || resolver.canSend(meta.agentName, targetNode));
  const hasValidAddressTarget = (targetValue: string): boolean => {
    const trimmed = targetValue.trim();
    if (!trimmed.startsWith('@')) return true;
    try {
      const address = parseAddress(trimmed);
      if (address.kind === 'worker') {
        return (
          (address.workflowRunId === undefined || address.workflowRunId === workflowRunId) &&
          !!address.agentName
        );
      }
      if (address.kind === 'role') {
        return address.role.startsWith('actor-role:');
      }
      return false;
    } catch {
      return false;
    }
  };

  if (methodName === 'send_message') {
    const target = params.target;
    if (typeof target === 'string') {
      if (target.trim() === '*') {
        const permittedNode = resolver.getPermittedTargets(fromNode);
        const permittedSlot = resolver.getPermittedTargets(meta.agentName);
        const permitted = [...new Set([...permittedNode, ...permittedSlot])];
        if (permitted.includes('*')) {
          for (const node of workflow.nodes) {
            actionTargets.add(node.name);
          }
        } else {
          for (const t of permitted) {
            for (const resolved of resolveTargetEntries(t, nodeIdToName, slotToNodes, nodeNames)) {
              actionTargets.add(resolved);
            }
          }
        }
      } else {
        const resolvedTargets = resolveTargetEntries(target, nodeIdToName, slotToNodes, nodeNames);
        for (const resolved of resolvedTargets) {
          actionTargets.add(resolved);
        }
        if (!hasValidAddressTarget(target)) {
          allRequestedTargetsRoutable = false;
        }
      }
    } else if (Array.isArray(target)) {
      for (const t of target) {
        if (typeof t !== 'string') {
          allRequestedTargetsRoutable = false;
          continue;
        }
        if (t.trim() === '*') {
          const permittedNode = resolver.getPermittedTargets(fromNode);
          const permittedSlot = resolver.getPermittedTargets(meta.agentName);
          const permitted = [...new Set([...permittedNode, ...permittedSlot])];
          if (permitted.includes('*')) {
            for (const node of workflow.nodes) {
              actionTargets.add(node.name);
            }
          } else {
            for (const pt of permitted) {
              for (const resolved of resolveTargetEntries(
                pt,
                nodeIdToName,
                slotToNodes,
                nodeNames
              )) {
                actionTargets.add(resolved);
              }
            }
          }
        } else {
          const resolvedTargets = resolveTargetEntries(t, nodeIdToName, slotToNodes, nodeNames);
          for (const resolved of resolvedTargets) {
            actionTargets.add(resolved);
          }
          if (
            !hasValidAddressTarget(t) ||
            resolvedTargets.some((resolved) => !isRoutableTarget(resolved))
          ) {
            allRequestedTargetsRoutable = false;
          }
        }
      }
    }
  }

  return workflow.hooks.filter((hook) => {
    if (!hook.enabled) return false;
    if (hook.method !== methodName) return false;

    if (hook.sourceNode !== nodeName) return false;

    if (hook.targetNode) {
      if (methodName !== 'send_message') return false;
      if (!allRequestedTargetsRoutable) return false;
      if (!actionTargets.has(hook.targetNode)) return false;
    }

    if (hook.humanOnly) return false;
    if (!hook.authorizedCallers || hook.authorizedCallers.length === 0) return false;

    return hook.authorizedCallers.some((caller) => {
      if (caller.sourceNode !== nodeName) return false;
      if (!caller.agentSlots || caller.agentSlots.length === 0) return true;
      return caller.agentSlots.includes(meta.agentName);
    });
  });
}

export function sortHooks(hooks: WorkflowHook[]): WorkflowHook[] {
  return [...hooks].sort((a, b) => {
    const aClass = a.classification ?? 'validation';
    const bClass = b.classification ?? 'validation';
    if (aClass !== bClass) {
      return aClass === 'validation' ? -1 : 1;
    }
    const orderA = a.order ?? 0;
    const orderB = b.order ?? 0;
    if (orderA !== orderB) return orderA - orderB;
    return a.id.localeCompare(b.id);
  });
}

function resolveTargetEntries(
  target: string,
  nodeIdToName: Map<string, string>,
  slotToNodes: Map<string, string[]>,
  nodeNames: Set<string>
): string[] {
  const trimmed = target.trim();
  if (nodeIdToName.has(trimmed)) {
    return [nodeIdToName.get(trimmed)!];
  }
  if (nodeNames.has(trimmed)) {
    return [trimmed];
  }
  const slotMatches = slotToNodes.get(trimmed);
  if (slotMatches) {
    return [...slotMatches];
  }
  if (trimmed.startsWith('@worker:')) {
    try {
      const addr = parseAddress(trimmed);
      if (addr.kind === 'worker') {
        const decoded = decodeURIComponent(addr.nodeId);
        if (nodeIdToName.has(decoded)) {
          return [nodeIdToName.get(decoded)!];
        }
        const slotMatches = slotToNodes.get(decoded);
        if (slotMatches) {
          return [...slotMatches];
        }
        return [decoded];
      }
    } catch {}
  }
  if (trimmed.startsWith('@role:')) {
    const role = trimmed.slice(6);
    const actorRolePrefix = 'actor-role:';
    if (role.startsWith(actorRolePrefix)) {
      const actorRoleValue = decodeURIComponent(role.slice(actorRolePrefix.length));
      if (nodeIdToName.has(actorRoleValue)) {
        return [nodeIdToName.get(actorRoleValue)!];
      }
      const actorRoleSlotMatches = slotToNodes.get(actorRoleValue);
      if (actorRoleSlotMatches) {
        return [...actorRoleSlotMatches];
      }
      return [actorRoleValue];
    }
    if (nodeIdToName.has(role)) {
      return [nodeIdToName.get(role)!];
    }
    const roleSlotMatches = slotToNodes.get(role);
    if (roleSlotMatches) {
      return [...roleSlotMatches];
    }
    return [role];
  }
  return [trimmed];
}
