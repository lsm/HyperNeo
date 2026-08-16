import type {
  WorkflowHook,
  WorkflowHookAuthorizedCaller,
  WorkflowHookResult,
  WorkflowNodeInput,
} from '@hyperneo/shared';
import {
  getRegisteredConnectorIds,
  isConnectorsLayerEnabled,
  isRegisteredConnector,
} from './runtime/connectors/connector';
// Side-effect import: seeds the built-in validator registry (named presets:
// `pr_ready`, `pr_merged`, …) so admission below is populated before any
// validation runs. (epic #2299, P2 #2302)
import './runtime/built-in-validators';
import { TOOL_PR_IDENTITY_HOOK_ID } from './runtime/workflow-hook-engine';
import {
  getRegisteredBuiltInValidatorIds,
  isRegisteredBuiltInValidator,
} from './runtime/built-in-validator-registry';

const VALID_METHODS = new Set([
  'send_message',
  'save_artifact',
  'create_standalone_task',
  'mark_complete',
  'submit_for_approval',
  'approve_task',
  'complete_validation_task',
]);
const VALID_RESULT_TYPES = new Set([
  'allow',
  'block',
  'retryable_block',
  'patch_params',
  'emit_follow_up',
  'record_state',
]);
/**
 * Admit a `externalLookups` entry when it names a registered connector. Driven
 * by the connector registry (no hardcoded `'github'`); the legacy literal is the
 * fallback when the connectors layer is disabled.
 */
function isValidExternalLookup(id: string): boolean {
  if (!isConnectorsLayerEnabled()) return id === 'github';
  return isRegisteredConnector(id);
}

/** Human-readable list of admitted connector ids, for error messages. */
function describeValidExternalLookups(): string {
  if (!isConnectorsLayerEnabled()) return '"github"';
  const ids = getRegisteredConnectorIds();
  return ids.length > 0 ? ids.map((id) => `"${id}"`).join(', ') : '(none registered)';
}
const FORBIDDEN_HOOK_KEYS = new Set(['fields', 'writers', 'requiredLevel', 'resetOnCycle']);
const MAX_TEMPLATE_DATA_BYTES = 16_384;
const MAX_SCRIPT_BYTES = 32_768;
const MAX_TIMEOUT_MS = 120_000;
const MIN_POLL_INTERVAL_MS = 10_000;
const MAX_HOOK_RESULT_BYTES = 65_536;

export interface WorkflowHookInvocationContext {
  kind: 'agent' | 'human';
  sourceNode?: string;
  agentSlot?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function jsonByteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
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
  caller: WorkflowHookAuthorizedCaller,
  index: number,
  validNodes: Set<string>,
  validSlotsByNode: Map<string, Set<string>>
): string[] {
  const errors: string[] = [];
  const loc = `authorizedCallers[${index}]`;
  if (typeof caller.sourceNode !== 'string' || caller.sourceNode.trim().length === 0) {
    errors.push(`${loc}.sourceNode: expected non-empty node name`);
  } else if (!validNodes.has(caller.sourceNode)) {
    errors.push(`${loc}.sourceNode: unknown node "${caller.sourceNode}"`);
  }

  if (caller.agentSlots !== undefined) {
    if (!Array.isArray(caller.agentSlots) || caller.agentSlots.length === 0) {
      errors.push(`${loc}.agentSlots: expected non-empty string array when present`);
    } else {
      const validSlots = validSlotsByNode.get(caller.sourceNode) ?? new Set<string>();
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

export function validateWorkflowHookResult(result: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(result)) return [`result: expected object, got ${typeof result}`];
  if (jsonByteLength(result) > MAX_HOOK_RESULT_BYTES) {
    errors.push(`result: must be at most ${MAX_HOOK_RESULT_BYTES} bytes`);
  }
  if (typeof result.type !== 'string' || !VALID_RESULT_TYPES.has(result.type)) {
    errors.push(
      `result.type: expected bounded hook result type, got ${JSON.stringify(result.type)}`
    );
    return errors;
  }
  if (result.message !== undefined && typeof result.message !== 'string') {
    errors.push('result.message: expected string');
  }
  switch (result.type as WorkflowHookResult['type']) {
    case 'allow':
      break;
    case 'block':
    case 'retryable_block':
      if (typeof result.reason !== 'string' || result.reason.trim().length === 0) {
        errors.push('result.reason: expected non-empty string');
      }
      if (result.type === 'retryable_block' && result.retryAfterMs !== undefined) {
        if (typeof result.retryAfterMs !== 'number' || result.retryAfterMs <= 0) {
          errors.push('result.retryAfterMs: expected positive number');
        }
      }
      break;
    case 'patch_params':
      if (!isRecord(result.patch)) errors.push('result.patch: expected object');
      break;
    case 'emit_follow_up':
      if (typeof result.targetNode !== 'string' || result.targetNode.trim().length === 0) {
        errors.push('result.targetNode: expected non-empty node name');
      }
      if (typeof result.message !== 'string' || result.message.trim().length === 0) {
        errors.push('result.message: expected non-empty string');
      }
      break;
    case 'record_state':
      if (!isRecord(result.state) && !isRecord(result.stateForHook)) {
        errors.push('result.state or result.stateForHook: expected object');
      }
      if (result.stateForHook !== undefined && !isRecord(result.stateForHook)) {
        errors.push('result.stateForHook: expected object');
      }
      break;
  }
  if (result.data !== undefined && !isRecord(result.data))
    errors.push('result.data: expected object');
  return errors;
}

export function validateWorkflowHooks(hooks: unknown, nodes: WorkflowNodeInput[]): string[] {
  if (hooks === undefined || hooks === null) return [];
  if (!Array.isArray(hooks)) return [`hooks: expected array, got ${typeof hooks}`];

  const errors: string[] = [];
  const ids = new Set<string>();
  const validNodes = nodeNames(nodes);
  const validSlotsByNode = agentSlotNamesByNode(nodes);

  // Pre-scan hook IDs so cross-hook references (e.g. recentResultRef) can be validated.
  const hookIds = new Set<string>();
  for (const hook of hooks) {
    if (isRecord(hook) && typeof hook.id === 'string') {
      hookIds.add(hook.id);
    }
  }

  for (let i = 0; i < hooks.length; i++) {
    const loc = `hooks[${i}]`;
    const hook = hooks[i];
    if (!isRecord(hook)) {
      errors.push(`${loc}: expected object, got ${typeof hook}`);
      continue;
    }

    for (const key of Object.keys(hook)) {
      if (key.toLowerCase().includes('role'))
        errors.push(`${loc}.${key}: role terminology is not allowed`);
      if (FORBIDDEN_HOOK_KEYS.has(key))
        errors.push(`${loc}.${key}: gate-only field is not allowed on hooks`);
    }

    if (typeof hook.id !== 'string' || hook.id.trim().length === 0) {
      errors.push(`${loc}.id: expected non-empty string`);
    } else if (ids.has(hook.id)) {
      errors.push(`${loc}.id: duplicate hook id "${hook.id}"`);
    } else {
      ids.add(hook.id);
    }

    if (typeof hook.enabled !== 'boolean') errors.push(`${loc}.enabled: expected boolean`);

    if (
      hook.classification !== undefined &&
      hook.classification !== 'validation' &&
      hook.classification !== 'side_effect'
    ) {
      errors.push(`${loc}.classification: expected "validation" or "side_effect"`);
    }

    if (hook.order !== undefined) {
      if (typeof hook.order !== 'number' || !Number.isFinite(hook.order)) {
        errors.push(`${loc}.order: expected finite number`);
      }
    }

    if (hook.label !== undefined && typeof hook.label !== 'string') {
      errors.push(`${loc}.label: expected string`);
    }

    if (hook.humanOnly === true) {
      errors.push(`${loc}.humanOnly: human-only hooks are not yet supported`);
    }

    if (isRecord(hook.localState)) {
      if (hook.localState.defaults !== undefined && !isRecord(hook.localState.defaults)) {
        errors.push(`${loc}.localState.defaults: expected object`);
      }
      if (hook.localState.recentResultRef !== undefined) {
        const ref = hook.localState.recentResultRef;
        if (!isRecord(ref)) {
          errors.push(`${loc}.localState.recentResultRef: expected object`);
        } else {
          if (typeof ref.hookId !== 'string' || ref.hookId.trim().length === 0) {
            errors.push(`${loc}.localState.recentResultRef.hookId: expected non-empty string`);
          } else if (!hookIds.has(ref.hookId)) {
            errors.push(
              `${loc}.localState.recentResultRef.hookId: unknown hook id "${ref.hookId}"`
            );
          }
          if (typeof ref.key !== 'string' || ref.key.trim().length === 0) {
            errors.push(`${loc}.localState.recentResultRef.key: expected non-empty string`);
          }
        }
      }
    } else if (hook.localState !== undefined) {
      errors.push(`${loc}.localState: expected object`);
    }

    if (typeof hook.sourceNode !== 'string' || hook.sourceNode.trim().length === 0) {
      errors.push(`${loc}.sourceNode: expected non-empty node name`);
    } else if (!validNodes.has(hook.sourceNode)) {
      errors.push(`${loc}.sourceNode: unknown node "${hook.sourceNode}"`);
    }

    if (hook.targetNode !== undefined) {
      if (typeof hook.targetNode !== 'string' || hook.targetNode.trim().length === 0) {
        errors.push(`${loc}.targetNode: expected non-empty node name`);
      } else if (!validNodes.has(hook.targetNode)) {
        errors.push(`${loc}.targetNode: unknown node "${hook.targetNode}"`);
      }
    }

    if (hook.id === TOOL_PR_IDENTITY_HOOK_ID) {
      errors.push(
        `${loc}.id: reserved by the runtime (${TOOL_PR_IDENTITY_HOOK_ID}); user-defined hooks may not use it`
      );
    }

    if (typeof hook.method !== 'string' || !VALID_METHODS.has(hook.method)) {
      errors.push(`${loc}.method: unknown MCP method ${JSON.stringify(hook.method)}`);
    }

    if (hook.templateData !== undefined) {
      if (!isRecord(hook.templateData)) {
        errors.push(`${loc}.templateData: expected object`);
      } else if (jsonByteLength(hook.templateData) > MAX_TEMPLATE_DATA_BYTES) {
        errors.push(`${loc}.templateData: must be at most ${MAX_TEMPLATE_DATA_BYTES} bytes`);
      }
    }

    const humanOnly = hook.humanOnly === true;
    if (hook.humanOnly !== undefined && typeof hook.humanOnly !== 'boolean') {
      errors.push(`${loc}.humanOnly: expected boolean`);
    }
    if (!humanOnly) {
      if (!Array.isArray(hook.authorizedCallers) || hook.authorizedCallers.length === 0) {
        errors.push(`${loc}.authorizedCallers: required non-empty array unless humanOnly is true`);
      }
    }
    if (hook.authorizedCallers !== undefined) {
      if (!Array.isArray(hook.authorizedCallers)) {
        errors.push(`${loc}.authorizedCallers: expected array`);
      } else {
        hook.authorizedCallers.forEach((caller, callerIndex) => {
          if (!isRecord(caller)) {
            errors.push(`${loc}.authorizedCallers[${callerIndex}]: expected object`);
            return;
          }
          errors.push(
            ...validateCaller(
              caller as unknown as WorkflowHookAuthorizedCaller,
              callerIndex,
              validNodes,
              validSlotsByNode
            ).map((err) => `${loc}.${err}`)
          );
        });
      }
    }

    const validator = hook.validator;
    if (!isRecord(validator)) {
      errors.push(`${loc}.validator: expected object`);
    } else if (validator.kind === 'built_in') {
      // A built-in id is admitted iff it is a REGISTERED named preset (compiled
      // to a connector + predicate). The registry is the source of truth — the
      // engine enumerates no ids (epic #2299, ADR #2). Unregistered ids fail
      // closed so workflows cannot declare capabilities that block at runtime.
      if (typeof validator.id !== 'string' || !isRegisteredBuiltInValidator(validator.id)) {
        const implemented = getRegisteredBuiltInValidatorIds();
        const allowed =
          implemented.length > 0 ? implemented.map((id) => `"${id}"`).join(', ') : '(none)';
        errors.push(
          `${loc}.validator.id: unknown built-in validator ${JSON.stringify(validator.id)} (registered presets: ${allowed})`
        );
      }
    } else if (validator.kind === 'script') {
      if (validator.interpreter !== 'bash') {
        errors.push(`${loc}.validator.interpreter: expected "bash"`);
      }
      if (typeof validator.source !== 'string' || validator.source.trim().length === 0) {
        errors.push(`${loc}.validator.source: expected non-empty string`);
      } else if (new TextEncoder().encode(validator.source).length > MAX_SCRIPT_BYTES) {
        errors.push(`${loc}.validator.source: must be at most ${MAX_SCRIPT_BYTES} bytes`);
      }
      if (validator.timeoutMs !== undefined) {
        if (
          typeof validator.timeoutMs !== 'number' ||
          validator.timeoutMs <= 0 ||
          validator.timeoutMs > MAX_TIMEOUT_MS
        ) {
          errors.push(`${loc}.validator.timeoutMs: expected positive number <= ${MAX_TIMEOUT_MS}`);
        }
      }
      if (validator.externalLookups !== undefined) {
        if (!Array.isArray(validator.externalLookups)) {
          errors.push(`${loc}.validator.externalLookups: expected array`);
        } else {
          for (let j = 0; j < validator.externalLookups.length; j++) {
            if (!isValidExternalLookup(validator.externalLookups[j] as string)) {
              errors.push(
                `${loc}.validator.externalLookups[${j}]: "${
                  validator.externalLookups[j]
                }" is not a registered connector (allowed: ${describeValidExternalLookups()})`
              );
            }
          }
        }
      }
    } else {
      errors.push(`${loc}.validator.kind: expected "built_in" or "script"`);
    }

    if (hook.retry !== undefined) {
      if (!isRecord(hook.retry)) {
        errors.push(`${loc}.retry: expected object`);
      } else {
        if (
          typeof hook.retry.maxAttempts !== 'number' ||
          hook.retry.maxAttempts < 0 ||
          hook.retry.maxAttempts > 20
        ) {
          errors.push(`${loc}.retry.maxAttempts: expected number between 0 and 20`);
        }
        if (
          typeof hook.retry.delayMs !== 'number' ||
          hook.retry.delayMs < 0 ||
          hook.retry.delayMs > 86_400_000
        ) {
          errors.push(`${loc}.retry.delayMs: expected number between 0 and 86400000`);
        }
        if (
          hook.retry.backoffMultiplier !== undefined &&
          (typeof hook.retry.backoffMultiplier !== 'number' ||
            hook.retry.backoffMultiplier < 1 ||
            hook.retry.backoffMultiplier > 10)
        ) {
          errors.push(`${loc}.retry.backoffMultiplier: expected number between 1 and 10`);
        }
      }
    }

    if (hook.poll !== undefined) {
      if (!isRecord(hook.poll)) {
        errors.push(`${loc}.poll: expected object`);
      } else {
        if (
          typeof hook.poll.intervalMs !== 'number' ||
          hook.poll.intervalMs < MIN_POLL_INTERVAL_MS
        ) {
          errors.push(`${loc}.poll.intervalMs: expected number >= ${MIN_POLL_INTERVAL_MS}`);
        }
        if (
          hook.poll.maxDurationMs !== undefined &&
          (typeof hook.poll.maxDurationMs !== 'number' || hook.poll.maxDurationMs <= 0)
        ) {
          errors.push(`${loc}.poll.maxDurationMs: expected positive number`);
        }
      }
      errors.push(`${loc}.poll: hook polling is not yet supported`);
    }
  }

  return errors;
}

export function isWorkflowHookCallerAuthorized(
  hook: WorkflowHook,
  context: WorkflowHookInvocationContext
): boolean {
  if (!hook.enabled) return false;
  if (hook.humanOnly) return context.kind === 'human';
  if (context.kind !== 'agent') return false;
  if (!hook.authorizedCallers || hook.authorizedCallers.length === 0) return false;
  return hook.authorizedCallers.some((caller) => {
    if (caller.sourceNode !== context.sourceNode) return false;
    if (!caller.agentSlots || caller.agentSlots.length === 0) return true;
    return !!context.agentSlot && caller.agentSlots.includes(context.agentSlot);
  });
}
