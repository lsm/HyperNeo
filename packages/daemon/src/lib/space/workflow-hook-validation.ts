/**
 * Workflow Hook v2 validation — see `docs/features/workflow-hooks-v2.md`.
 *
 * Validates the two-layer model on workflow create/update: that each
 * {@link HookBinding} places a resolvable hook (a registered built-in or a
 * declared {@link CustomHook}) on a real route, and that each custom hook is
 * well-formed. The engine does its own caller-authorization at runtime; this
 * module only guards persistence against malformed workflow definitions.
 */

import { BUILT_IN_HOOKS } from '@hyperneo/extensions-hooks';
import type {
  CustomHook,
  HookDataFieldType,
  HookMethod,
  WorkflowNodeInput,
} from '@hyperneo/shared';
import { resolveHook } from './runtime/hook-registry';

const BUILT_IN_HOOK_IDS = new Set(BUILT_IN_HOOKS.map((h) => h.id));

const VALID_METHODS = new Set<HookMethod>([
  'send_message',
  'save_artifact',
  'create_standalone_task',
  'mark_complete',
  'submit_for_approval',
  'approve_task',
]);

const VALID_DATA_FIELD_TYPES = new Set<HookDataFieldType>(['string', 'number', 'boolean', 'link']);

const MAX_SCRIPT_BYTES = 32_768;

/**
 * Upper bound for a custom hook's `run.timeoutMs`. Exported so the portable
 * export schema accepts exactly the values runtime validation admits (the
 * runtime check allows any positive number up to this bound — fractional
 * values included — so the export schema must not require integers).
 */
export const MAX_CUSTOM_HOOK_TIMEOUT_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nodeNames(nodes: WorkflowNodeInput[]): Set<string> {
  return new Set(nodes.map((node) => node.name));
}

function agentSlotNamesByNode(nodes: WorkflowNodeInput[]): Map<string, Set<string>> {
  const byNode = new Map<string, Set<string>>();
  for (const node of nodes) {
    byNode.set(node.name, new Set((node.agents ?? []).map((agent) => agent.name)));
  }
  return byNode;
}

function validateCaller(
  caller: unknown,
  index: number,
  locPrefix: string,
  validNodes: Set<string>,
  validSlotsByNode: Map<string, Set<string>>
): string[] {
  const errors: string[] = [];
  const loc = `${locPrefix}.authorizedCallers[${index}]`;
  if (!isRecord(caller)) {
    errors.push(`${loc}: expected object`);
    return errors;
  }
  if (typeof caller.sourceNode !== 'string' || caller.sourceNode.trim().length === 0) {
    errors.push(`${loc}.sourceNode: expected non-empty node name`);
  } else if (!validNodes.has(caller.sourceNode)) {
    errors.push(`${loc}.sourceNode: unknown node "${caller.sourceNode}"`);
  }

  if (caller.agentSlots !== undefined) {
    if (!Array.isArray(caller.agentSlots) || caller.agentSlots.length === 0) {
      errors.push(`${loc}.agentSlots: expected non-empty string array when present`);
    } else {
      const validSlots = validSlotsByNode.get(caller.sourceNode as string) ?? new Set<string>();
      for (let i = 0; i < caller.agentSlots.length; i++) {
        const slot = caller.agentSlots[i];
        if (typeof slot !== 'string' || slot.trim().length === 0) {
          errors.push(`${loc}.agentSlots[${i}]: expected non-empty agent slot name`);
        } else if (!validSlots.has(slot)) {
          errors.push(
            `${loc}.agentSlots[${i}]: unknown agent slot "${slot}" for node "${caller.sourceNode}"`
          );
        }
      }
    }
  }
  return errors;
}

function validateRequiredData(value: unknown, loc: string): string[] {
  const errors: string[] = [];
  if (!Array.isArray(value)) {
    errors.push(`${loc}: expected array`);
    return errors;
  }
  for (let i = 0; i < value.length; i++) {
    const field = value[i];
    const fieldLoc = `${loc}[${i}]`;
    if (!isRecord(field)) {
      errors.push(`${fieldLoc}: expected object`);
      continue;
    }
    if (typeof field.key !== 'string' || field.key.trim().length === 0) {
      errors.push(`${fieldLoc}.key: expected non-empty string`);
    }
    if (
      typeof field.type !== 'string' ||
      !VALID_DATA_FIELD_TYPES.has(field.type as HookDataFieldType)
    ) {
      errors.push(`${fieldLoc}.type: expected one of string|number|boolean|link`);
    }
    if (typeof field.required !== 'boolean') {
      errors.push(`${fieldLoc}.required: expected boolean`);
    }
    if (field.description !== undefined && typeof field.description !== 'string') {
      errors.push(`${fieldLoc}.description: expected string`);
    }
  }
  return errors;
}

/** Validate a workflow's custom (script) hook definitions. */
export function validateCustomHooks(customHooks: unknown): string[] {
  if (customHooks === undefined || customHooks === null) return [];
  if (!Array.isArray(customHooks))
    return [`customHooks: expected array, got ${typeof customHooks}`];

  const errors: string[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < customHooks.length; i++) {
    const loc = `customHooks[${i}]`;
    const hook = customHooks[i];
    if (!isRecord(hook)) {
      errors.push(`${loc}: expected object`);
      continue;
    }
    if (typeof hook.id !== 'string' || hook.id.trim().length === 0) {
      errors.push(`${loc}.id: expected non-empty string`);
    } else if (BUILT_IN_HOOK_IDS.has(hook.id)) {
      // Bindings resolve built-ins first, so a custom hook shadowing a built-in
      // id is silently ignored — reject it so the author's script isn't dead.
      errors.push(`${loc}.id: custom hook id "${hook.id}" shadows a built-in hook`);
    } else if (ids.has(hook.id)) {
      errors.push(`${loc}.id: duplicate custom hook id "${hook.id}"`);
    } else {
      ids.add(hook.id);
    }

    errors.push(...validateRequiredData(hook.requiredData, `${loc}.requiredData`));

    const run = hook.run;
    if (!isRecord(run)) {
      errors.push(`${loc}.run: expected object`);
    } else {
      if (run.kind !== 'script') errors.push(`${loc}.run.kind: expected "script"`);
      if (run.interpreter !== 'bash') errors.push(`${loc}.run.interpreter: expected "bash"`);
      if (typeof run.source !== 'string' || run.source.trim().length === 0) {
        errors.push(`${loc}.run.source: expected non-empty string`);
      } else if (new TextEncoder().encode(run.source).length > MAX_SCRIPT_BYTES) {
        errors.push(`${loc}.run.source: must be at most ${MAX_SCRIPT_BYTES} bytes`);
      }
      if (run.timeoutMs !== undefined) {
        if (
          typeof run.timeoutMs !== 'number' ||
          run.timeoutMs <= 0 ||
          run.timeoutMs > MAX_CUSTOM_HOOK_TIMEOUT_MS
        ) {
          errors.push(
            `${loc}.run.timeoutMs: expected positive number <= ${MAX_CUSTOM_HOOK_TIMEOUT_MS}`
          );
        }
      }
    }
  }
  return errors;
}

/**
 * Validate a workflow's hook bindings: each places a resolvable hook on a real
 * route with valid authorized callers. `customHooks` is the workflow's declared
 * custom hooks (so a binding may reference one).
 */
export function validateWorkflowHookBindings(
  bindings: unknown,
  customHooks: CustomHook[] | undefined,
  nodes: WorkflowNodeInput[]
): string[] {
  if (bindings === undefined || bindings === null) return [];
  if (!Array.isArray(bindings)) return [`hookBindings: expected array, got ${typeof bindings}`];

  const errors: string[] = [];
  const validNodes = nodeNames(nodes);
  const validSlotsByNode = agentSlotNamesByNode(nodes);

  for (let i = 0; i < bindings.length; i++) {
    const loc = `hookBindings[${i}]`;
    const binding = bindings[i];
    if (!isRecord(binding)) {
      errors.push(`${loc}: expected object`);
      continue;
    }

    if (typeof binding.hookId !== 'string' || binding.hookId.trim().length === 0) {
      errors.push(`${loc}.hookId: expected non-empty string`);
    } else if (!resolveHook(binding.hookId, customHooks)) {
      errors.push(
        `${loc}.hookId: "${binding.hookId}" is neither a registered built-in hook nor a declared custom hook`
      );
    }

    if (typeof binding.enabled !== 'boolean') {
      errors.push(`${loc}.enabled: expected boolean`);
    }

    if (typeof binding.sourceNode !== 'string' || binding.sourceNode.trim().length === 0) {
      errors.push(`${loc}.sourceNode: expected non-empty node name`);
    } else if (!validNodes.has(binding.sourceNode)) {
      errors.push(`${loc}.sourceNode: unknown node "${binding.sourceNode}"`);
    }

    // targetNode is required for routed methods (send_message) and optional for
    // non-routed methods (mark_complete, save_artifact, …) that have no target.
    if (binding.targetNode !== undefined) {
      if (typeof binding.targetNode !== 'string' || binding.targetNode.trim().length === 0) {
        errors.push(`${loc}.targetNode: expected non-empty node name when present`);
      } else if (!validNodes.has(binding.targetNode)) {
        errors.push(`${loc}.targetNode: unknown node "${binding.targetNode}"`);
      }
    } else if (binding.method === 'send_message') {
      errors.push(`${loc}.targetNode: required for send_message bindings`);
    }

    if (typeof binding.method !== 'string' || !VALID_METHODS.has(binding.method as HookMethod)) {
      errors.push(`${loc}.method: unknown method ${JSON.stringify(binding.method)}`);
    }

    if (binding.order !== undefined) {
      if (typeof binding.order !== 'number' || !Number.isFinite(binding.order)) {
        errors.push(`${loc}.order: expected finite number`);
      }
    }

    // The engine fails closed on a binding with no authorizedCallers (it never
    // matches), so require a non-empty array — otherwise the binding is silently
    // dead.
    if (!Array.isArray(binding.authorizedCallers) || binding.authorizedCallers.length === 0) {
      errors.push(`${loc}.authorizedCallers: required non-empty array`);
    } else {
      binding.authorizedCallers.forEach((caller, callerIndex) => {
        errors.push(...validateCaller(caller, callerIndex, loc, validNodes, validSlotsByNode));
      });
    }
  }

  return errors;
}

/** Union of all hook ids resolvable on a workflow: built-in ids + custom ids. */
export function availableHookIds(customHooks: CustomHook[] | undefined): Set<string> {
  const ids = new Set<string>(BUILT_IN_HOOK_IDS);
  for (const hook of customHooks ?? []) ids.add(hook.id);
  return ids;
}
