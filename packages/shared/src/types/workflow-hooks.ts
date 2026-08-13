/**
 * Workflow Hooks v2 — see `docs/features/workflow-hooks-v2.md`.
 *
 * Two layers:
 *   - Layer 1: a reusable {@link Hook} (or {@link CustomHook}) — `requiredData`
 *     (the input contract, data) + `run` (the rule, code). A hook knows nothing
 *     about nodes or methods.
 *   - Layer 2: a {@link HookBinding} that places a hook on a workflow route
 *     (source/target/method/order).
 *
 * Hook bodies are business logic and live in `@hyperneo/extensions-hooks`; this
 * module defines only the contracts. The daemon implements {@link HookContext}
 * and injects it — the extensions package never imports daemon internals.
 *
 * Hooks own their side effects: a hook performs them inside `run` by calling
 * {@link HookContext} methods. {@link HookReturn} only signals flow control
 * (plus an optional transform of the action params and an optional audit
 * record the engine never acts on).
 */

// ---------------------------------------------------------------------------
// Input contract (Layer 1, data)
// ---------------------------------------------------------------------------

export type HookDataFieldType = 'string' | 'number' | 'boolean' | 'link';

/**
 * One field of a hook's required input contract. Drives agent-prompt
 * generation: the runtime unions the `requiredData` of every hook bound to a
 * route and tells the agent what to put in `send_message.data`.
 */
export interface HookDataField {
  /** Data key the agent must supply (e.g. `pr_link`). */
  key: string;
  type: HookDataFieldType;
  required: boolean;
  description?: string;
}

// ---------------------------------------------------------------------------
// Action passed into a hook
// ---------------------------------------------------------------------------

export type HookMethod =
  | 'send_message'
  | 'save_artifact'
  | 'create_standalone_task'
  | 'mark_complete'
  | 'submit_for_approval'
  | 'approve_task';

/** The MCP action being hooked. */
export interface HookAction {
  method: HookMethod;
  /** Bounded action params, safe for serialization into a script env. */
  params: Record<string, unknown>;
  /** Original unbounded params; built-in hooks may inspect routing fields here. */
  rawParams?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// HookContext — capabilities the daemon injects (hooks own side effects)
// ---------------------------------------------------------------------------

export interface HookArtifactInput {
  artifactType: string;
  artifactKey: string;
  data: Record<string, unknown>;
  nodeId?: string;
}

export interface HookArtifact {
  artifactType: string;
  artifactKey: string;
  data: Record<string, unknown>;
}

/**
 * Everything a hook can do beyond deciding flow. The daemon implements every
 * method; the hook decides *what* to do, the daemon *executes* it. This is
 * what keeps the extensions package free of daemon internals.
 */
export interface HookContext {
  runId: string;
  workspacePath: string;
  taskId: string;
  taskStatus?: string;
  /** When the run started (ms epoch). Hooks use it to scope "fresh" external evidence (e.g. a review posted since the run started). */
  runStartedAt?: number;
  /** Route the hook is bound to. */
  sourceNode: string;
  targetNode?: string;

  readState(key: string): unknown;
  recordState(key: string, value: unknown): void;
  queueFollowUp(targetNode: string, message: string): void;
  writeArtifact(artifact: HookArtifactInput): void;
  readArtifacts(): HookArtifact[];
}

// ---------------------------------------------------------------------------
// Hook return
// ---------------------------------------------------------------------------

export type HookFlow = 'continue' | 'stop' | 'retry';

export interface HookReturn {
  flow: HookFlow;
  /** Shown to the agent on `stop` / `retry`. */
  reason?: string;
  /** Optional rewrite of the action params before delivery. */
  payload?: Record<string, unknown>;
  /** Backoff hint for `retry`. The engine owns backoff scheduling. */
  retryAfterMs?: number;
  /**
   * Optional record of what the hook did (audit/log/UI). The engine logs or
   * ignores it; it NEVER acts on it — side effects are the hook's own work via
   * {@link HookContext}.
   */
  result?: unknown;
}

// ---------------------------------------------------------------------------
// Layer 1 — the hook definitions
// ---------------------------------------------------------------------------

/** A built-in hook: id + requiredData + a TS `run` function. Lives in extensions/hooks. */
export interface Hook {
  id: string;
  requiredData: HookDataField[];
  run: (action: HookAction, ctx: HookContext) => Promise<HookReturn>;
}

/** A user-authored script hook, defined per-workflow. */
export interface CustomHook {
  id: string;
  requiredData: HookDataField[];
  run: { kind: 'script'; interpreter: 'bash'; source: string; timeoutMs?: number };
}

// ---------------------------------------------------------------------------
// Layer 2 — the binding (placement on a workflow route)
// ---------------------------------------------------------------------------

/**
 * The ids of the built-in hooks registered in `@hyperneo/extensions-hooks`.
 * Part of the cross-package contract: consumers that cannot depend on the
 * extensions package (the web client, portable validators) resolve binding and
 * transition hookId references against this list. The extensions registry must
 * keep it in sync.
 */
export const BUILT_IN_HOOK_IDS: readonly string[] = [
  'pr_ready',
  'review_posted',
  'post_approval_only',
  'pr_merged',
  'codex_review_approved',
];

export interface HookAuthorizedCaller {
  sourceNode: string;
  agentSlots?: string[];
}

/**
 * Places a hook on a workflow route. References a built-in {@link Hook.id} or a
 * {@link CustomHook.id} defined on the same workflow.
 */
export interface HookBinding {
  hookId: string;
  sourceNode: string;
  /**
   * Target node for routed methods (`send_message`). Optional for non-routed
   * methods (e.g. `mark_complete`, `save_artifact`) that have no destination —
   * a binding without a targetNode matches any such action from `sourceNode`.
   */
  targetNode?: string;
  method: HookMethod;
  order: number;
  enabled: boolean;
  authorizedCallers?: HookAuthorizedCaller[];
}

// ---------------------------------------------------------------------------
// Engine-managed per-run state + user-facing state
// ---------------------------------------------------------------------------

export interface HookStateSnapshot {
  runId: string;
  hookId: string;
  version: number;
  localState: Record<string, unknown>;
  lastFlow?: HookFlow;
  lastReason?: string;
  retryCount: number;
  nextRetryAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface HookUserState {
  status: 'allowed' | 'blocked' | 'waiting_on_retry';
  hookId?: string;
  reason?: string;
  sourceNode?: string;
  targetNode?: string;
  retryAfterMs?: number;
  retryCount?: number;
  nextRetryAt?: number;
}
