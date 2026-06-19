/**
 * RepeatedToolErrorGuardrail
 *
 * Detects repeated identical tool-use errors during Forge-scoped task execution
 * and breaks the retry loop by emitting a recovery message. Each intervention is
 * logged as `conversation_friction` evidence on the linked task's evolution scope.
 */

import type { SpaceTask } from '@neokai/shared';
import { Logger } from '../logger';

export interface RepeatedToolErrorGuardrailDeps {
  /** Resolve the Forge task owning the current session, if any. */
  getTaskForSession: () => SpaceTask | null | undefined;
  /** Persist a `conversation_friction` evidence row. Returns the created evidence or undefined on failure. */
  emitEvidence: (params: {
    scopeId: string;
    summary: string;
    metadata: Record<string, unknown>;
  }) => { id: string } | undefined | void;
  /** Broadcast a synthetic assistant recovery message into the session. */
  displayRecoveryMessage: (text: string) => Promise<void> | void;
  /** Threshold for consecutive identical errors before intervening. */
  threshold?: number;
  /** Length of the normalized error substring used for identity. */
  errorFingerprintLength?: number;
  /** Maximum tool_use_id -> tool_name mappings to retain. */
  maxTrackedToolUseIds?: number;
  /** Cooldown (ms) before the same tool+error can trigger another intervention. */
  interventionCooldownMs?: number;
}

interface ErrorKey {
  toolName: string;
  error: string;
}

interface State {
  toolUseIdToName: Map<string, string>;
  lastError: ErrorKey | null;
  consecutiveCount: number;
  lastInterventionByKey: Map<string, number>;
}

const DEFAULT_THRESHOLD = 2;
const DEFAULT_ERROR_FINGERPRINT_LENGTH = 160;
const DEFAULT_MAX_TRACKED_TOOL_USE_IDS = 200;
const DEFAULT_INTERVENTION_COOLDOWN_MS = 60_000;

export class RepeatedToolErrorGuardrail {
  private logger: Logger;
  private state: State;
  private threshold: number;
  private errorFingerprintLength: number;
  private maxTrackedToolUseIds: number;
  private interventionCooldownMs: number;

  constructor(private deps: RepeatedToolErrorGuardrailDeps) {
    this.logger = new Logger('RepeatedToolErrorGuardrail');
    this.threshold = deps.threshold ?? DEFAULT_THRESHOLD;
    this.errorFingerprintLength = deps.errorFingerprintLength ?? DEFAULT_ERROR_FINGERPRINT_LENGTH;
    this.maxTrackedToolUseIds = deps.maxTrackedToolUseIds ?? DEFAULT_MAX_TRACKED_TOOL_USE_IDS;
    this.interventionCooldownMs = deps.interventionCooldownMs ?? DEFAULT_INTERVENTION_COOLDOWN_MS;
    this.state = {
      toolUseIdToName: new Map(),
      lastError: null,
      consecutiveCount: 0,
      lastInterventionByKey: new Map(),
    };
  }

  /**
   * Record a tool use so that subsequent error tool_results can be attributed to
   * a tool name.
   */
  recordToolUse(toolUseId: string, toolName: string): void {
    if (!toolUseId) return;

    // Cap the lookup map so long-lived sessions cannot grow it without bound.
    if (this.state.toolUseIdToName.size >= this.maxTrackedToolUseIds) {
      const oldestKey = this.state.toolUseIdToName.keys().next().value;
      if (oldestKey !== undefined) {
        this.state.toolUseIdToName.delete(oldestKey);
      }
    }

    this.state.toolUseIdToName.set(toolUseId, toolName || 'unknown');
  }

  /**
   * Inspect a user message's content blocks for error tool_results. Called from
   * the session execution loop for every user message.
   *
   * Returns true if an intervention was triggered on this message.
   */
  async observeToolResultErrors(message: unknown): Promise<boolean> {
    // Scoped to Forge task execution: nothing to do if this session is not
    // attached to an evolution scope.
    const task = this.deps.getTaskForSession();
    if (!task?.evolutionScopeId) return false;

    const content = (message as { message?: { content?: unknown } }).message?.content;
    if (!Array.isArray(content)) return false;

    let triggered = false;
    for (const block of content) {
      const error = extractToolResultError(block, this.state.toolUseIdToName);
      if (!error) {
        // Non-error tool_results break an error streak.
        if (isToolResultBlock(block)) {
          this.reset();
        }
        continue;
      }

      const didTrigger = this.observeError(error.toolName, error.errorText);
      if (didTrigger) {
        triggered = true;
        await this.intervene(error.toolName, error.errorText, task);
      }
    }

    return triggered;
  }

  private observeError(toolName: string, errorText: string): boolean {
    const fingerprint = normalizeError(errorText, this.errorFingerprintLength);
    const key: ErrorKey = { toolName, error: fingerprint };
    const keyString = `${toolName}:${fingerprint}`;

    // If we recently intervened for this exact tool+error, swallow repeats
    // until the cooldown elapses to avoid evidence/message spam.
    const lastIntervention = this.state.lastInterventionByKey.get(keyString);
    if (
      lastIntervention !== undefined &&
      Date.now() - lastIntervention < this.interventionCooldownMs
    ) {
      this.reset();
      return false;
    }

    const sameAsLast =
      this.state.lastError !== null &&
      this.state.lastError.toolName === key.toolName &&
      this.state.lastError.error === key.error;

    if (sameAsLast) {
      this.state.consecutiveCount += 1;
    } else {
      this.state.lastError = key;
      this.state.consecutiveCount = 1;
    }

    return this.state.consecutiveCount >= this.threshold;
  }

  private reset(): void {
    this.state.lastError = null;
    this.state.consecutiveCount = 0;
  }

  private async intervene(toolName: string, errorText: string, task: SpaceTask): Promise<void> {
    const count = this.state.consecutiveCount;
    const fingerprint = normalizeError(errorText, this.errorFingerprintLength);
    const keyString = `${toolName}:${fingerprint}`;
    this.state.lastInterventionByKey.set(keyString, Date.now());
    this.reset();

    try {
      this.deps.emitEvidence({
        scopeId: task.evolutionScopeId as string,
        summary: `Repeated tool error: ${toolName} failed ${count} consecutive times with the same error`,
        metadata: {
          tool: toolName,
          error: fingerprint,
          count,
        },
      });
    } catch (err) {
      this.logger.warn('Failed to emit repeated_tool_error evidence:', err);
    }

    const message = buildRecoveryMessage(toolName, errorText, count);
    try {
      await this.deps.displayRecoveryMessage(message);
    } catch (err) {
      this.logger.warn('Failed to display repeated tool error recovery message:', err);
    }
  }
}

function buildRecoveryMessage(toolName: string, errorText: string, count: number): string {
  const shortError = errorText.length > 200 ? `${errorText.slice(0, 200)}…` : errorText;
  return [
    `⚠️ Repeated tool error detected: \`${toolName}\` failed ${count} consecutive times with the same error.`,
    '',
    `Error: ${shortError}`,
    '',
    'Stop retrying this operation. Re-validate the arguments, try an alternative path, or ask the operator for help.',
  ].join('\n');
}

function normalizeError(errorText: string, maxLength: number): string {
  const normalized = errorText.trim().toLowerCase().replace(/\s+/g, ' ');
  return normalized.length > maxLength ? normalized.slice(0, maxLength) : normalized;
}

function isToolResultBlock(block: unknown): boolean {
  return (
    block !== null &&
    typeof block === 'object' &&
    (block as { type?: unknown }).type === 'tool_result'
  );
}

function extractToolResultError(
  block: unknown,
  toolUseIdToName: Map<string, string>
): { toolUseId: string; toolName: string; errorText: string } | null {
  if (!isToolResultBlock(block)) return null;

  const b = block as {
    tool_use_id?: unknown;
    is_error?: unknown;
    content?: unknown;
  };

  if (b.is_error !== true) return null;
  const toolUseId = typeof b.tool_use_id === 'string' ? b.tool_use_id : '';
  if (!toolUseId) return null;

  const errorText = extractText(b.content);
  if (!errorText) return null;

  const toolName = toolUseIdToName.get(toolUseId) ?? 'unknown';
  return { toolUseId, toolName, errorText };
}

function extractText(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const item of content) {
      if (
        item &&
        typeof item === 'object' &&
        typeof (item as { text?: unknown }).text === 'string'
      ) {
        parts.push((item as { text: string }).text);
      } else if (typeof item === 'string') {
        parts.push(item);
      }
    }
    return parts.join(' ');
  }

  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}
