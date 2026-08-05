/**
 * Unified Gate Evaluator — script-based + field-based
 *
 * `evaluateGate(gate, data, scriptExecutor?)` optionally runs a gate script
 * (when `gate.script` is defined and `scriptExecutor` is provided), then walks
 * `gate.fields` and checks each field against the runtime data store. The gate
 * opens when ALL checks pass.
 *
 * Evaluation order:
 *   1. If script exists + scriptExecutor provided → run script
 *      - On failure: gate blocked immediately
 *      - On success: deep-merge script output data into `data`
 *   2. Field-based evaluation (existing logic)
 *   3. No script, no fields → gate open
 *
 * Field check types:
 *   scalar (boolean/string/number) — ops: exists / == / !=
 *   map — op: count (count entries matching a value, check >= min)
 *
 * Channels without a gate are always open — use `isChannelOpen()` as the entry
 * point. `isChannelOpen()` remains synchronous (no script execution).
 */

import type {
  Channel,
  Gate,
  GateField,
  GateFieldCheck,
  GateScript,
  WorkflowHookResult,
} from '@hyperneo/shared';
import { hasEnabledGateFeature } from '@hyperneo/shared';
import { getBuiltInValidator } from './built-in-validator-registry';
import {
  hasRegisteredGateFeatures,
  isRegisteredGateFeature,
  validateGateFeatures,
} from './gate-features';
import {
  deepMergeWithDepthLimit,
  type GateScriptContext,
  type GateScriptResult,
} from './gate-script-executor';
import type { HookExecutorContext } from './hook-executor';
import { RATE_LIMIT_MIN_BACKOFF_MS } from './rate-limit-detector';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Result of evaluating a gate. */
export interface GateEvalResult {
  /** Whether the gate is open (all fields passed). */
  open: boolean;
  /** Human-readable explanation when the gate is closed. */
  reason?: string;
  /**
   * Gate data after script pre-check, including any deep-merged script
   * output. Present when evaluation reached the field-check stage (i.e.
   * not present when the script itself failed). Consumers can persist
   * selected keys back to storage without re-running the script.
   */
  data?: Record<string, unknown>;
  /**
   * True when the gate's script failed because GitHub returned a rate-limit
   * error. Surfaced so workflow engines can defer re-evaluation rather than
   * re-run the script on every gate write. The gate is still closed
   * (`open: false`); this flag is informational.
   */
  rateLimited?: boolean;
  /**
   * Suggested backoff in milliseconds when `rateLimited` is true. Consumers
   * use this to schedule a re-evaluation instead of re-running the script on
   * every gate write.
   */
  retryAfterMs?: number;
}

// Re-export executor types from gate-script-executor for consumer convenience.
export type {
  GateScriptContext as GateScriptExecutorContext,
  GateScriptResult as GateScriptExecutorResult,
};

/**
 * Callback type for executing gate scripts.
 *
 * The gate evaluator calls this when `gate.script` is defined. Implementations
 * are responsible for spawning the process, enforcing timeouts, and returning
 * the result. See `executeGateScript()` in `gate-script-executor.ts` for the
 * reference implementation.
 */
export type GateScriptExecutorFn = (
  script: GateScript,
  context: GateScriptContext
) => Promise<GateScriptResult>;

// ---------------------------------------------------------------------------
// Runtime validation
// ---------------------------------------------------------------------------

const VALID_FIELD_TYPES = new Set(['boolean', 'string', 'number', 'map']);
const VALID_SCALAR_OPS = new Set(['exists', '==', '!=']);

/**
 * Validates an array of GateField objects at runtime.
 *
 * Since fields are deserialized from JSON (SQLite, RPC), they may be
 * malformed. This function checks structural validity before evaluation.
 *
 * @returns Array of human-readable error strings. Empty array = valid.
 */
export function validateGateFields(fields: unknown, path = 'fields'): string[] {
  const errors: string[] = [];

  if (!Array.isArray(fields)) {
    errors.push(`${path}: expected an array, got ${typeof fields}`);
    return errors;
  }

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const fp = `${path}[${i}]`;

    if (!field || typeof field !== 'object') {
      errors.push(`${fp}: expected an object, got ${typeof field}`);
      continue;
    }

    const f = field as Record<string, unknown>;

    if (typeof f.name !== 'string' || f.name.length === 0) {
      errors.push(`${fp}.name: expected non-empty string`);
    }

    if (typeof f.type !== 'string' || !VALID_FIELD_TYPES.has(f.type)) {
      errors.push(
        `${fp}.type: expected one of [boolean, string, number, map], got ${JSON.stringify(f.type)}`
      );
    }

    if (!Array.isArray(f.writers)) {
      errors.push(`${fp}.writers: expected array, got ${typeof f.writers}`);
    }

    // Validate check
    if (!f.check || typeof f.check !== 'object') {
      errors.push(`${fp}.check: expected an object, got ${typeof f.check}`);
    } else {
      const check = f.check as Record<string, unknown>;
      if (f.type === 'map') {
        if (check.op !== 'count') {
          errors.push(
            `${fp}.check.op: expected "count" for map field, got ${JSON.stringify(check.op)}`
          );
        }
        if (typeof check.min !== 'number') {
          errors.push(`${fp}.check.min: expected number, got ${typeof check.min}`);
        }
        if (check.match === undefined) {
          errors.push(`${fp}.check.match: required but missing`);
        }
      } else {
        if (typeof check.op !== 'string' || !VALID_SCALAR_OPS.has(check.op)) {
          errors.push(
            `${fp}.check.op: expected one of [exists, ==, !=], got ${JSON.stringify(check.op)}`
          );
        }
        if (check.op === 'exists' && check.value !== undefined) {
          errors.push(`${fp}.check: "value" is set but ignored when op is "exists"`);
        }
      }
    }
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Gate creation/modification validators
// ---------------------------------------------------------------------------

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const VALID_INTERPRETERS = new Set(['bash', 'node', 'python3']);

/**
 * Validates a gate badge color.
 *
 * @param color  The color value to validate.
 * @returns Array of human-readable error strings. Empty array = valid.
 */
export function validateGateColor(color: unknown): string[] {
  const errors: string[] = [];

  if (color === undefined || color === null) {
    return errors;
  }

  if (typeof color !== 'string') {
    errors.push(`color: expected string, got ${typeof color}`);
    return errors;
  }

  if (!HEX_COLOR_RE.test(color)) {
    errors.push(`color: expected hex format #rrggbb, got "${color}"`);
  }

  return errors;
}

/**
 * Validates a gate label.
 *
 * @param label  The label value to validate.
 * @returns Array of human-readable error strings. Empty array = valid.
 */
export function validateGateLabel(label: unknown): string[] {
  const errors: string[] = [];

  if (label === undefined || label === null) {
    return errors;
  }

  if (typeof label !== 'string') {
    errors.push(`label: expected string, got ${typeof label}`);
    return errors;
  }

  if (label.length > 20) {
    errors.push(`label: must be at most 20 characters, got ${label.length}`);
  }

  return errors;
}

/**
 * Validates a gate script configuration.
 *
 * @param script  The script object to validate.
 * @returns Array of human-readable error strings. Empty array = valid.
 */
export function validateGateScript(script: unknown): string[] {
  const errors: string[] = [];

  if (script === undefined || script === null) {
    return errors;
  }

  if (typeof script !== 'object') {
    errors.push(`script: expected object, got ${typeof script}`);
    return errors;
  }

  const s = script as Record<string, unknown>;

  if (typeof s.interpreter !== 'string' || !VALID_INTERPRETERS.has(s.interpreter)) {
    errors.push(
      `script.interpreter: expected one of [bash, node, python3], got ${JSON.stringify(s.interpreter)}`
    );
  }

  if (typeof s.source !== 'string' || s.source.length === 0) {
    errors.push('script.source: expected non-empty string');
  }

  if (s.timeoutMs !== undefined) {
    if (typeof s.timeoutMs !== 'number') {
      errors.push(`script.timeoutMs: expected number, got ${typeof s.timeoutMs}`);
    } else if (s.timeoutMs <= 0) {
      errors.push(`script.timeoutMs: must be positive, got ${s.timeoutMs}`);
    } else if (s.timeoutMs > 120000) {
      errors.push(`script.timeoutMs: must be at most 120000ms (120s), got ${s.timeoutMs}`);
    }
  }

  return errors;
}

/**
 * Validates a gate poll configuration.
 *
 * @param poll  The poll object to validate.
 * @returns Array of human-readable error strings. Empty array = valid.
 */
export function validateGatePoll(poll: unknown): string[] {
  const errors: string[] = [];

  if (poll === undefined || poll === null) {
    return errors;
  }

  if (typeof poll !== 'object') {
    errors.push(`poll: expected object, got ${typeof poll}`);
    return errors;
  }

  const p = poll as Record<string, unknown>;

  if (typeof p.intervalMs !== 'number' || !Number.isFinite(p.intervalMs) || p.intervalMs < 10_000) {
    errors.push(
      `poll.intervalMs: must be a finite number >= 10000 (10 seconds), got ${p.intervalMs}`
    );
  }

  if (typeof p.script !== 'string' || p.script.trim().length === 0) {
    errors.push('poll.script: expected non-empty string');
  }

  if (p.target !== 'from' && p.target !== 'to') {
    errors.push(`poll.target: expected "from" or "to", got ${JSON.stringify(p.target)}`);
  }

  if (p.messageTemplate !== undefined && typeof p.messageTemplate !== 'string') {
    errors.push(`poll.messageTemplate: expected string, got ${typeof p.messageTemplate}`);
  }

  return errors;
}

/**
 * Validates a gate definition for creation or modification.
 *
 * This validator enforces structural rules on new/updated gates:
 *   - At least one of `fields` (non-empty) or `script` must be present.
 *   - When `fields` is present, existing field validation runs (handles non-array gracefully).
 *   - Optional `color`, `label`, and `script` are validated when provided.
 *
 * **Important:** This validator should only be applied to new/updated gates
 * (e.g. via `GateEditorPanel` or MCP tool handlers), never to existing gates
 * loaded from storage. Existing gates with `fields: []` remain valid at runtime.
 *
 * TODO: Wire into RPC handlers and GateEditorPanel in follow-on tasks.
 *
 * @param gate  The gate object to validate.
 * @returns Array of human-readable error strings. Empty array = valid.
 */
export function validateGate(gate: unknown): string[] {
  const errors: string[] = [];

  if (!gate || typeof gate !== 'object') {
    errors.push(`gate: expected object, got ${typeof gate}`);
    return errors;
  }

  const g = gate as Record<string, unknown>;

  // Validate optional fields — sub-validators handle null/undefined gracefully
  errors.push(...validateGateColor(g.color));
  errors.push(...validateGateLabel(g.label));
  errors.push(...validateGateScript(g.script));
  errors.push(...validateGatePoll(g.poll));

  // Validate fields when present (validateGateFields handles non-array gracefully)
  if (g.fields !== undefined && g.fields !== null) {
    errors.push(...validateGateFields(g.fields));
  }

  // At least one of fields (non-empty array), features, a script, or a validator must be present
  // Note: poll does NOT count as a gate check mechanism — it is a side-channel
  // for message injection only. A gate still needs fields, features, a script,
  // or a built-in validator reference.
  const hasFields = Array.isArray(g.fields) && g.fields.length > 0;
  const hasScript = g.script !== undefined && g.script !== null;
  const hasValidator = g.validator !== undefined && g.validator !== null;
  const hasPoll = g.poll !== undefined && g.poll !== null;
  const hasFeatures = hasRegisteredGateFeatures(g as { features?: Gate['features'] });
  if (!hasFields && !hasScript && !hasValidator && !hasFeatures) {
    errors.push(
      'gate: must have at least one non-empty "fields" array, "features", a "script", or a "validator"'
    );
  }

  // A built-in validator reference is an alternative check mechanism — it must
  // not be combined with a custom script/poll (which would be silently
  // ignored) or with registered features (which compile into a script). The
  // gate evaluator runs at most one of validator/script.
  if (hasValidator && (hasScript || hasPoll || hasFeatures)) {
    errors.push(
      'gate: cannot combine a "validator" with a "script", "poll", or registered features. ' +
        'A built-in validator is an alternative check mechanism; remove the others.'
    );
  }

  // Reject unknown/unregistered feature names so misspelled features do not
  // silently pass validation when the gate also has fields or a script.
  const enabledFeatures = Object.keys(
    (g.features as Record<string, unknown> | undefined) ?? {}
  ).filter((name) => hasEnabledGateFeature(g as { features?: Gate['features'] }, name));
  for (const name of enabledFeatures) {
    if (!isRegisteredGateFeature(name)) {
      errors.push(`gate: unknown feature "${name}" — must be a registered gate feature`);
    }
  }

  // Reject feature + custom script/poll combinations to prevent silent override.
  // Features compile into script/poll at runtime; mixing them with custom
  // script/poll would silently drop the custom checks. Remove the custom
  // script/poll or disable the feature, not both.
  if (hasFeatures && (hasScript || hasPoll)) {
    errors.push(
      'gate: cannot combine registered features with a custom "script" or "poll". ' +
        'Either remove the custom script/poll or disable the feature.'
    );
  }

  // Reject gates that enable multiple features defining the same runtime
  // artifact (script or poll) so nothing is silently dropped.
  if (hasFeatures) {
    errors.push(...validateGateFeatures(gate as Gate));
  }

  return errors;
}

// ---------------------------------------------------------------------------
// Channel helper
// ---------------------------------------------------------------------------

/**
 * Checks whether a channel is open for message delivery.
 *
 * - Channels without a `gateId` are always open (no evaluation needed).
 * - Channels with a `gateId` look up the gate in `gates` and evaluate it.
 * - If the gate is not found in the map, the channel is treated as closed
 *   (missing gate = misconfiguration, fail closed).
 *
 * @param channel  The channel to check.
 * @param gates    Map of gate ID -> Gate definition (declared in the workflow).
 * @param gateData Map of gate ID -> current gate data. Loaded from the
 *                 `gate_data` SQLite table by `GateDataRepository`. Agents
 *                 write to this data via the `write_gate` MCP tool. When
 *                 absent, the gate is evaluated against an empty object
 *                 (no fields satisfied).
 */
export function isChannelOpen(
  channel: Channel,
  gates: ReadonlyMap<string, Gate> | Record<string, Gate>,
  gateData?: ReadonlyMap<string, Record<string, unknown>> | Record<string, Record<string, unknown>>
): GateEvalResult {
  if (!channel.gateId) {
    return { open: true };
  }

  const gate =
    gates instanceof Map
      ? gates.get(channel.gateId)
      : (gates as Record<string, Gate>)[channel.gateId];
  if (!gate) {
    return {
      open: false,
      reason: `Gate "${channel.gateId}" not found — channel "${channel.id}" is closed (misconfiguration)`,
    };
  }

  // Load runtime data if provided
  let data: Record<string, unknown> = {};
  if (gateData) {
    const d =
      gateData instanceof Map
        ? gateData.get(channel.gateId)
        : (gateData as Record<string, Record<string, unknown>>)[channel.gateId];
    if (d) data = d;
  }

  return evaluateFields(gate, data);
}

// ---------------------------------------------------------------------------
// Gate validator dispatch (gate-on-external-state primitive)
// ---------------------------------------------------------------------------

/**
 * Map a `WorkflowHookResult` (the shape built-in validators return) to a
 * `GateEvalResult`. `allow` opens the gate (carrying the validator's projected
 * data for deep-merge); `block`/`retryable_block` close it. The retryable case
 * is tagged `rateLimited` so the channel router defers re-evaluation rather
 * than re-running the validator on every gate write (mirroring the script
 * path's rate-limit handling). Hook-only result types (`patch_params`,
 * `emit_follow_up`, `record_state`) have no gate equivalent — a gate must
 * decide open/closed, so they fail closed.
 */
function mapHookResultToGateEval(result: WorkflowHookResult): GateEvalResult {
  switch (result.type) {
    case 'allow':
      return { open: true, data: result.data };
    case 'block':
      return { open: false, reason: result.reason };
    case 'retryable_block':
      return {
        open: false,
        reason: result.reason,
        retryAfterMs: result.retryAfterMs ?? RATE_LIMIT_MIN_BACKOFF_MS,
        rateLimited: true,
      };
    default:
      return {
        open: false,
        reason: `Gate validator returned unsupported result type "${result.type}"`,
      };
  }
}

/**
 * Dispatch a gate's built-in validator. The validator (an `external_state`
 * preset such as `review_posted`) is looked up from the built-in registry and
 * invoked with a `HookExecutorContext` synthesised from the gate context:
 * gate data is projected into `params.data` / `hookLocalState` so the preset's
 * param resolver finds its inputs (e.g. `pr_url`), and `workflowStartIso` is
 * carried via `hookLocalState` + `workflowRunCreatedAt`.
 */
async function runGateValidator(
  validator: NonNullable<Gate['validator']>,
  gateData: Record<string, unknown>,
  context: GateScriptContext
): Promise<GateEvalResult> {
  const fn = getBuiltInValidator(validator.id);
  if (!fn) {
    return { open: false, reason: `Gate validator "${validator.id}" is not registered` };
  }
  const hookContext: HookExecutorContext = {
    workspacePath: context.workspacePath,
    runId: context.runId,
    hookId: context.gateId,
    methodName: 'send_message',
    params: { data: gateData },
    rawParams: { data: gateData },
    nodeId: '',
    nodeName: '',
    sessionId: '',
    taskId: '',
    workflowRunCreatedAt: context.workflowStartIso
      ? Date.parse(context.workflowStartIso)
      : undefined,
    hookLocalState: {
      ...gateData,
      pr_url: gateData.pr_url ?? context.prUrl,
      workflowStartIso: context.workflowStartIso,
    },
    currentArtifacts: [],
    permittedExternalLookups: [],
  };
  const result = await fn(hookContext);
  return mapHookResultToGateEval(result);
}

// ---------------------------------------------------------------------------
// Gate evaluator
// ---------------------------------------------------------------------------

/**
 * Evaluates a Gate's declared fields against current gate data.
 *
 * Pure function — no I/O or side effects. The gate opens when ALL fields pass.
 * Used internally by `evaluateGate()` (after script pre-check) and by
 * `isChannelOpen()` (which remains synchronous).
 *
 * @param gate     The gate definition (fields, checks).
 * @param gateData Current runtime data for this gate. Sourced from the
 *                 `gate_data` SQLite table via `GateDataRepository`, or
 *                 computed by `computeGateDefaults()` when no record exists.
 *                 Agents write to this data via the `write_gate` MCP tool.
 */
export function evaluateFields(gate: Gate, gateData: Record<string, unknown>): GateEvalResult {
  for (const field of gate.fields ?? []) {
    const result = evaluateFieldCheck(field, gateData);
    if (!result.open) return result;
  }
  return { open: true };
}

/**
 * Evaluates a gate: optionally runs a script pre-check, then evaluates fields.
 *
 * Evaluation flow:
 *   1. If `gate.validator` is defined AND `context` is provided → the named
 *      built-in validator is dispatched (the "gate-on-external-state"
 *      primitive). On failure → gate blocked; on success → its projected data
 *      is deep-merged into `gateData`.
 *   2. If `gate.script` is defined AND `scriptExecutor` + `context` are
 *      provided → the script executor is called.
 *      - On failure → gate blocked immediately with script error.
 *      - On success → script output data is deep-merged into `gateData`,
 *        then fields are evaluated against the merged data.
 *   3. If no script/validator or no executor → fields are evaluated directly
 *      (synchronously under the hood).
 *   4. No script/validator, no fields → gate open.
 *
 * `validator` and `script` are mutually exclusive (enforced by `validateGate`).
 *
 * @param gate           The gate definition (validator, script, fields, checks).
 * @param gateData       Current runtime data for this gate. Sourced from the
 *                       `gate_data` SQLite table via `GateDataRepository`,
 *                       or computed by `computeGateDefaults()` when no record
 *                       exists. Agents write to this data via the `write_gate`
 *                       MCP tool. When a script executor is provided, script
 *                       output is deep-merged into this data before field
 *                       evaluation.
 * @param scriptExecutor Optional callback to execute gate scripts.
 * @param context        Execution context for the script/validator (workspace
 *                       path, gate ID, run ID, workflow-start ISO). Required
 *                       when `scriptExecutor` is provided or `gate.validator`
 *                       is set.
 */
export async function evaluateGate(
  gate: Gate,
  gateData: Record<string, unknown>,
  scriptExecutor?: GateScriptExecutorFn,
  context?: GateScriptContext
): Promise<GateEvalResult> {
  // ── Validator pre-check (gate-on-external-state primitive) ────────────
  if (gate.validator && context) {
    const validatorResult = await runGateValidator(gate.validator, gateData, context);
    if (!validatorResult.open) return validatorResult;
    if (validatorResult.data && Object.keys(validatorResult.data).length > 0) {
      gateData = deepMergeWithDepthLimit({ ...gateData }, validatorResult.data);
    }
  }

  // ── Script pre-check ──────────────────────────────────────────────────
  if (gate.script && scriptExecutor && context) {
    const scriptResult = await scriptExecutor(gate.script, context);
    if (!scriptResult.success) {
      return {
        open: false,
        reason: `Script check failed: ${scriptResult.error ?? 'unknown error'}`,
        rateLimited: scriptResult.rateLimited,
        retryAfterMs: scriptResult.rateLimited
          ? (scriptResult.retryAfterMs ?? RATE_LIMIT_MIN_BACKOFF_MS)
          : undefined,
      };
    }

    // Deep-merge script output into gateData (spread avoids mutating caller's object)
    if (scriptResult.data && Object.keys(scriptResult.data).length > 0) {
      gateData = deepMergeWithDepthLimit({ ...gateData }, scriptResult.data);
    }
  }

  // ── Field evaluation ──────────────────────────────────────────────────
  const fieldResult = evaluateFields(gate, gateData);
  return { ...fieldResult, data: gateData };
}

/**
 * Evaluates a single GateField's check against the provided data.
 */
export function evaluateFieldCheck(
  field: GateField,
  data: Record<string, unknown>
): GateEvalResult {
  const check: GateFieldCheck = field.check;

  if (check.op === 'count') {
    // Map check
    return evaluateCount(field.name, check.match, check.min, data);
  }

  // Scalar check
  return evaluateScalar(field.name, check.op, check.value, data);
}

// ---------------------------------------------------------------------------
// Primitive evaluators
// ---------------------------------------------------------------------------

function evaluateScalar(
  fieldName: string,
  op: '==' | '!=' | 'exists',
  expected: unknown,
  data: Record<string, unknown>
): GateEvalResult {
  switch (op) {
    case 'exists': {
      if (data[fieldName] !== undefined) {
        return { open: true };
      }
      return {
        open: false,
        reason: `Gate check failed: data["${fieldName}"] does not exist`,
      };
    }

    case '==': {
      const actual = data[fieldName];
      if (actual === expected) {
        return { open: true };
      }
      return {
        open: false,
        reason: `Gate check failed: data["${fieldName}"] is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
      };
    }

    case '!=': {
      const actual = data[fieldName];
      if (actual !== expected) {
        return { open: true };
      }
      return {
        open: false,
        reason: `Gate check failed: data["${fieldName}"] is ${JSON.stringify(actual)}, expected != ${JSON.stringify(expected)}`,
      };
    }

    default: {
      return {
        open: false,
        reason: `Gate check failed: unknown op "${op as string}"`,
      };
    }
  }
}

function evaluateCount(
  fieldName: string,
  matchValue: unknown,
  min: number,
  data: Record<string, unknown>
): GateEvalResult {
  const raw = data[fieldName];

  // Field must be a non-null object (Record/map). Missing or non-object -> count 0.
  let count = 0;
  if (raw !== null && raw !== undefined && typeof raw === 'object' && !Array.isArray(raw)) {
    const map = raw as Record<string, unknown>;
    for (const val of Object.values(map)) {
      if (val === matchValue) count++;
    }
  }

  if (count >= min) {
    return { open: true };
  }
  return {
    open: false,
    reason: `Gate count failed: data["${fieldName}"] has ${count} entries matching ${JSON.stringify(matchValue)}, need >= ${min}`,
  };
}
