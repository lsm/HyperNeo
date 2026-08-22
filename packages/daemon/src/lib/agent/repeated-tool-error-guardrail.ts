import type { SpaceTask } from '@hyperneo/shared';
import { Logger } from '../logger';
import {
  buildRecoveryMessage,
  buildRepeatedToolErrorEvidence,
  classifyToolResultContent,
  decideConsecutiveError,
  type RepeatedToolErrorKey,
  type ToolResultError,
} from './repeated-tool-error-gates';

export interface RepeatedToolErrorGuardrailDeps {
  getTaskForSession: () => SpaceTask | null | undefined;
  emitEvidence: (params: {
    scopeId: string;
    summary: string;
    metadata: Record<string, unknown>;
  }) => { id: string } | undefined | void;
  routeRecoveryMessage: (text: string) => Promise<void> | void;
  threshold?: number;
  errorFingerprintLength?: number;
  maxTrackedToolUseIds?: number;
  interventionCooldownMs?: number;
}

interface State {
  toolUseIdToName: Map<string, string>;
  lastError: RepeatedToolErrorKey | null;
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

  recordToolUse(toolUseId: string, toolName: string): void {
    if (!toolUseId) return;

    if (this.state.toolUseIdToName.size >= this.maxTrackedToolUseIds) {
      const oldestKey = this.state.toolUseIdToName.keys().next().value;
      if (oldestKey !== undefined) {
        this.state.toolUseIdToName.delete(oldestKey);
      }
    }

    this.state.toolUseIdToName.set(toolUseId, toolName || 'unknown');
  }

  async observeToolResultErrors(message: unknown): Promise<boolean> {
    const task = this.deps.getTaskForSession();
    if (!task?.evolutionScopeId) return false;

    const content = (message as { message?: { content?: unknown } }).message?.content;
    const classification = classifyToolResultContent(
      content,
      this.state.toolUseIdToName,
      this.errorFingerprintLength
    );

    if (classification.kind === 'reset') {
      this.reset();
      return false;
    }
    if (classification.kind === 'ignore') return false;

    let triggered = false;
    for (const error of classification.errors) {
      const decision = decideConsecutiveError({
        toolName: error.toolName,
        fingerprint: error.fingerprint,
        state: this.state,
        lastInterventionAt: this.state.lastInterventionByKey.get(
          `${error.toolName}:${error.fingerprint}`
        ),
        threshold: this.threshold,
        interventionCooldownMs: this.interventionCooldownMs,
        now: Date.now(),
      });

      if (decision.action === 'cooldown_reset') {
        this.reset();
        continue;
      }
      if (decision.action === 'count') {
        this.state.lastError = decision.lastError;
        this.state.consecutiveCount = decision.consecutiveCount;
        continue;
      }

      triggered = true;
      await this.intervene(error, decision.consecutiveCount, task);
    }

    return triggered;
  }

  private reset(): void {
    this.state.lastError = null;
    this.state.consecutiveCount = 0;
  }

  private async intervene(error: ToolResultError, count: number, task: SpaceTask): Promise<void> {
    this.state.lastInterventionByKey.set(`${error.toolName}:${error.fingerprint}`, Date.now());
    this.reset();

    try {
      this.deps.emitEvidence(
        buildRepeatedToolErrorEvidence({
          scopeId: task.evolutionScopeId as string,
          toolName: error.toolName,
          fingerprint: error.fingerprint,
          count,
        })
      );
    } catch (err) {
      this.logger.warn('Failed to emit repeated_tool_error evidence:', err);
    }

    const message = buildRecoveryMessage(error.toolName, error.errorText, count);
    try {
      await this.deps.routeRecoveryMessage(message);
    } catch (err) {
      this.logger.warn('Failed to deliver repeated tool error recovery message:', err);
    }
  }
}
