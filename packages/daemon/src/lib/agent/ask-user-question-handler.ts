import type {
  PendingUserQuestion,
  QuestionCancelReason,
  QuestionDraftResponse,
  Session,
} from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus.ts';
import type { Database } from '../../storage/database.ts';
import type {
  CanUseTool,
  HookCallback,
  PermissionResult,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { ProcessingStateManager } from './processing-state-manager.ts';
import type { MessageQueue } from './message-queue.ts';
import { Logger } from '../logger.ts';

export interface AskUserQuestionHandlerContext {
  readonly session: Session;
  readonly db: Database;
  readonly stateManager: ProcessingStateManager;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  readonly messageQueue: MessageQueue;
  ensureQueryStarted?(): Promise<void>;
}

interface AskUserQuestionInput {
  questions: Array<{
    question: string;
    header: string;
    options: Array<{
      label: string;
      description: string;
    }>;
    multiSelect: boolean;
  }>;
  answers?: Record<string, string>;
}

interface PendingQuestionResolver {
  toolUseId: string;
  input: Record<string, unknown>;
  pendingQuestion: PendingUserQuestion;
  promise: Promise<PermissionResult>;
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
  attemptToken: { isLive(): boolean };
}

export const QUESTION_CANCEL_MESSAGE =
  'User cancelled: The user chose not to answer this question. Please proceed accordingly or ask a different question if needed.';

const ATTEMPT_TOKEN_ALWAYS_LIVE: { isLive(): boolean } = { isLive: () => true };

const MAX_QUESTION_STRING_LENGTH = 2000;

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MAX_OPTIONS_UNVALIDATED_CHANNEL = 64;

function truncateQuestionString(value: string | undefined): string {
  if (typeof value !== 'string') return '';
  return value.length > MAX_QUESTION_STRING_LENGTH
    ? value.slice(0, MAX_QUESTION_STRING_LENGTH)
    : value;
}

export class AskUserQuestionHandler {
  private logger: Logger;
  private pendingResolver: PendingQuestionResolver | null = null;
  private queuedAnswers: Map<string, PermissionResult> = new Map();

  constructor(private ctx: AskUserQuestionHandlerContext) {
    this.logger = new Logger(`AskUserQuestionHandler ${ctx.session.id}`);
  }

  private async interceptAskUserQuestion(
    toolUseID: string,
    input: Record<string, unknown>,
    viaChannel: 'can_use_tool' | 'pre_tool_use_hook',
    attemptToken: { isLive(): boolean }
  ): Promise<PermissionResult> {
    const { session, stateManager, internalEventBus } = this.ctx;

    const askInput = input as unknown as AskUserQuestionInput;
    const isHook = viaChannel === 'pre_tool_use_hook';
    const questionsWellFormed =
      Array.isArray(askInput.questions) &&
      askInput.questions.length >= 1 &&
      askInput.questions.length <= MAX_QUESTIONS &&
      askInput.questions.every(
        (q) =>
          q !== null &&
          typeof q === 'object' &&
          typeof q.question === 'string' &&
          typeof q.multiSelect === 'boolean' &&
          Array.isArray(q.options) &&
          q.options.length >= (isHook ? 2 : 1) &&
          q.options.length <= (isHook ? MAX_OPTIONS : MAX_OPTIONS_UNVALIDATED_CHANNEL) &&
          q.options.every((o) => o !== null && typeof o === 'object' && typeof o.label === 'string')
      );
    if (!questionsWellFormed) {
      this.logger.warn(
        `AskUserQuestion ${toolUseID}: malformed tool_input (questions missing, empty, or ill-formed); denying`
      );
      return {
        behavior: 'deny',
        message: 'AskUserQuestion input is malformed: no valid questions were provided.',
      };
    }

    const queued = this.queuedAnswers.get(toolUseID);
    if (queued) {
      this.queuedAnswers.delete(toolUseID);
      const merged: PermissionResult =
        queued.behavior === 'allow'
          ? {
              behavior: 'allow',
              updatedInput: { ...input, ...queued.updatedInput },
            }
          : queued;
      this.logger.info(
        `AskUserQuestion ${toolUseID}: consuming queued answer (behavior=${queued.behavior})`
      );
      void internalEventBus
        .publish('question.injected_as_tool_result', {
          sessionId: session.id,
          toolUseId: toolUseID,
          mode: queued.behavior === 'allow' ? 'submitted' : 'cancelled',
          via: viaChannel,
        })
        .catch((publishError: unknown) => {
          this.logger.warn(
            `AskUserQuestion ${toolUseID}: question.injected_as_tool_result publish failed (${
              publishError instanceof Error ? publishError.message : String(publishError)
            })`
          );
        });
      return merged;
    }

    const pendingQuestion: PendingUserQuestion = {
      toolUseId: toolUseID,
      questions: askInput.questions.map((q) => ({
        question: truncateQuestionString(q.question),
        header: truncateQuestionString(q.header),
        options: q.options.map((o) => ({
          label: truncateQuestionString(o.label),
          description: truncateQuestionString(o.description),
        })),
        multiSelect: q.multiSelect,
      })),
      askedAt: Date.now(),
    };

    if (this.pendingResolver?.toolUseId === toolUseID) {
      return this.pendingResolver.promise;
    }

    let resolvePending!: (result: PermissionResult) => void;
    let rejectPending!: (error: Error) => void;
    const pending = new Promise<PermissionResult>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });

    if (this.pendingResolver) {
      this.logger.warn(
        `AskUserQuestion ${this.pendingResolver.toolUseId}: superseded by a newer ` +
          `AskUserQuestion call (${toolUseID}); denying the older question`
      );
      this.pendingResolver.resolve({
        behavior: 'deny',
        message:
          'Superseded by a newer AskUserQuestion call; that question is now awaiting the user.',
      });
    }
    this.pendingResolver = {
      toolUseId: toolUseID,
      input,
      pendingQuestion,
      promise: pending,
      resolve: resolvePending,
      reject: rejectPending,
      attemptToken,
    };

    try {
      await stateManager.setWaitingForInput(pendingQuestion);
    } catch (err) {
      resolvePending({
        behavior: 'deny',
        message: 'AskUserQuestion failed to surface; the question was not answered.',
      });
      if (this.pendingResolver?.toolUseId === toolUseID) {
        this.pendingResolver = null;
      }
      throw err;
    }

    const stateAfterSetWaiting = stateManager.getState();
    const inFlightResponse =
      stateAfterSetWaiting.status === 'processing' && stateAfterSetWaiting.messageId === toolUseID;

    if (inFlightResponse) {
      this.logger.warn(
        `AskUserQuestion ${toolUseID}: response arrived while waiting state was still publishing; ` +
          `letting the response handler resolve the question`
      );
      return pending;
    }

    const stillCurrent =
      attemptToken.isLive() &&
      this.pendingResolver?.toolUseId === toolUseID &&
      stateAfterSetWaiting.status === 'waiting_for_input' &&
      stateAfterSetWaiting.pendingQuestion.toolUseId === toolUseID;

    if (!stillCurrent) {
      this.logger.warn(
        `AskUserQuestion ${toolUseID}: superseded before the question could be published; ` +
          `dropping the stale question.asked event`
      );
      this.trackResolvedQuestion(toolUseID, pendingQuestion, 'cancelled', []);
      resolvePending({
        behavior: 'deny',
        message:
          'Superseded by a newer AskUserQuestion call; that question is now awaiting the user.',
      });
      if (this.pendingResolver?.toolUseId === toolUseID) {
        this.pendingResolver = null;
      }
      const currentState = stateManager.getState();
      if (
        currentState.status === 'waiting_for_input' &&
        currentState.pendingQuestion.toolUseId === toolUseID
      ) {
        try {
          await stateManager.setIdle({
            suppressIdlePublish: true,
            suppressIdleCallback: true,
            suppressDeliveryWaiters: true,
          });
        } catch (idleError) {
          this.logger.warn(
            `AskUserQuestion ${toolUseID}: failed to roll back stale waiting state`,
            idleError
          );
        }
      }
      return pending;
    }

    try {
      await internalEventBus.publish('question.asked', {
        sessionId: session.id,
        pendingQuestion,
      });
    } catch (publishError) {
      this.logger.warn(
        `AskUserQuestion ${toolUseID}: question.asked publish failed (${
          publishError instanceof Error ? publishError.message : String(publishError)
        })`
      );
    }

    return pending;
  }

  createPreToolUseHook(attemptToken?: { isLive(): boolean }): HookCallback {
    const token = attemptToken ?? ATTEMPT_TOKEN_ALWAYS_LIVE;
    return async (input) => {
      const preInput = input as PreToolUseHookInput;
      if (preInput.hook_event_name !== 'PreToolUse' || preInput.tool_name !== 'AskUserQuestion') {
        return {};
      }

      const result = await this.interceptAskUserQuestion(
        preInput.tool_use_id,
        (preInput.tool_input ?? {}) as Record<string, unknown>,
        'pre_tool_use_hook',
        token
      );

      if (result.behavior === 'allow') {
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'allow' as const,
            updatedInput: result.updatedInput,
          },
        };
      }
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: result.message,
        },
      };
    };
  }

  createCanUseToolCallback(attemptToken?: { isLive(): boolean }): CanUseTool {
    const token = attemptToken ?? ATTEMPT_TOKEN_ALWAYS_LIVE;
    return async (
      toolName,
      input,
      options: {
        signal: AbortSignal;
        toolUseID: string;
        suggestions?: unknown[];
        blockedPath?: string;
        decisionReason?: string;
        agentID?: string;
        matchedAskRule?: { source: string; toolName: string; ruleContent?: string };
      }
    ): Promise<PermissionResult> => {
      if (toolName !== 'AskUserQuestion') {
        if (options.matchedAskRule) {
          return {
            behavior: 'deny',
            message: `Permission required by ask rule: ${options.matchedAskRule.ruleContent ?? options.matchedAskRule.toolName}`,
          };
        }
        return { behavior: 'allow', updatedInput: input };
      }

      return this.interceptAskUserQuestion(options.toolUseID, input, 'can_use_tool', token);
    };
  }

  async handleQuestionResponse(
    toolUseId: string,
    responses: QuestionDraftResponse[]
  ): Promise<void> {
    const { stateManager } = this.ctx;
    const currentState = stateManager.getState();

    if (currentState.status !== 'waiting_for_input') {
      throw new Error(
        `Cannot respond to question: agent is not waiting for input (status: ${currentState.status})`
      );
    }

    if (currentState.pendingQuestion.toolUseId !== toolUseId) {
      throw new Error(
        `Tool use ID mismatch: expected ${currentState.pendingQuestion.toolUseId}, got ${toolUseId}`
      );
    }

    const pendingQuestion = currentState.pendingQuestion;

    const resolver = this.pendingResolver;
    const resolverMatches = !!resolver && resolver.toolUseId === toolUseId;

    if (resolverMatches && resolver && !resolver.attemptToken.isLive()) {
      this.logger.warn(
        `AskUserQuestion ${toolUseId}: submit for a superseded attempt; settling the stale ` +
          `callback with deny so the closed query can finish without mutating the ` +
          `successor's state`
      );
      this.trackResolvedQuestion(toolUseId, pendingQuestion, 'cancelled', responses);
      this.pendingResolver = null;
      resolver.resolve({
        behavior: 'deny',
        message:
          'The query attempt that asked this question was superseded; the answer could not ' +
          'be delivered.',
      });
      await this.rollbackStaleWaitingState(toolUseId);
      return;
    }

    const answers = this.buildAnswers(
      pendingQuestion,
      responses,
      resolverMatches ? resolver.input : undefined
    );

    this.trackResolvedQuestion(toolUseId, pendingQuestion, 'submitted', responses);

    if (resolverMatches) {
      try {
        await stateManager.setProcessing(toolUseId, 'streaming');
      } catch (err) {
        resolver.resolve({
          behavior: 'deny',
          message: 'AskUserQuestion failed to transition; the question was not answered.',
        });
        this.trackResolvedQuestion(toolUseId, pendingQuestion, 'cancelled', responses);
        if (this.pendingResolver === resolver) {
          this.pendingResolver = null;
        }
        throw err;
      }
      if (this.pendingResolver !== resolver) {
        this.logger.warn(
          `AskUserQuestion ${toolUseId}: submit arrived after the question was superseded; dropping it`
        );
        this.trackResolvedQuestion(toolUseId, pendingQuestion, 'cancelled', responses);
        const current = this.pendingResolver;
        if (current) {
          try {
            await stateManager.setWaitingForInput(current.pendingQuestion);
          } catch (restoreError) {
            current.resolve({
              behavior: 'deny',
              message: 'AskUserQuestion failed to restore the card; the question was not answered.',
            });
            if (this.pendingResolver === current) {
              this.pendingResolver = null;
            }
            throw restoreError;
          }
        }
        return;
      }
      this.pendingResolver = null;
      resolver.resolve({
        behavior: 'allow',
        updatedInput: {
          ...resolver.input,
          answers,
        },
      });
      return;
    }

    if (resolver) {
      this.logger.warn(
        `AskUserQuestion ${toolUseId}: submit for a superseded question; dropping it`
      );
      this.trackResolvedQuestion(toolUseId, pendingQuestion, 'cancelled', responses);
      return;
    }

    await this.deliverQueuedAnswer(toolUseId, pendingQuestion, {
      behavior: 'allow',
      updatedInput: { answers },
    });
  }

  async handleQuestionCancel(toolUseId: string): Promise<void> {
    const { stateManager } = this.ctx;
    const currentState = stateManager.getState();

    if (currentState.status !== 'waiting_for_input') {
      throw new Error(
        `Cannot cancel question: agent is not waiting for input (status: ${currentState.status})`
      );
    }

    if (currentState.pendingQuestion.toolUseId !== toolUseId) {
      throw new Error(
        `Tool use ID mismatch: expected ${currentState.pendingQuestion.toolUseId}, got ${toolUseId}`
      );
    }

    const pendingQuestion = currentState.pendingQuestion;

    const resolver = this.pendingResolver;
    if (resolver && resolver.toolUseId === toolUseId && !resolver.attemptToken.isLive()) {
      this.logger.warn(
        `AskUserQuestion ${toolUseId}: cancel for a superseded attempt; settling the stale ` +
          `callback with deny so the closed query can finish without mutating the ` +
          `successor's state`
      );
      this.trackResolvedQuestion(toolUseId, pendingQuestion, 'cancelled', []);
      this.pendingResolver = null;
      resolver.resolve({
        behavior: 'deny',
        message: QUESTION_CANCEL_MESSAGE,
      });
      await this.rollbackStaleWaitingState(toolUseId);
      return;
    }

    this.trackResolvedQuestion(toolUseId, pendingQuestion, 'cancelled', [], 'user_cancelled');

    if (resolver && resolver.toolUseId === toolUseId) {
      try {
        await stateManager.setProcessing(toolUseId, 'streaming');
      } catch (err) {
        resolver.resolve({
          behavior: 'deny',
          message: 'AskUserQuestion failed to transition; the question was not cancelled.',
        });
        if (this.pendingResolver === resolver) {
          this.pendingResolver = null;
        }
        throw err;
      }
      if (this.pendingResolver !== resolver) {
        this.logger.warn(
          `AskUserQuestion ${toolUseId}: cancel arrived after the question was superseded; dropping it`
        );
        const current = this.pendingResolver;
        if (current) {
          try {
            await stateManager.setWaitingForInput(current.pendingQuestion);
          } catch (restoreError) {
            current.resolve({
              behavior: 'deny',
              message:
                'AskUserQuestion failed to restore the card; the question was not cancelled.',
            });
            if (this.pendingResolver === current) {
              this.pendingResolver = null;
            }
            throw restoreError;
          }
        }
        return;
      }
      this.pendingResolver = null;
      resolver.resolve({
        behavior: 'deny',
        message: QUESTION_CANCEL_MESSAGE,
      });
      return;
    }

    if (resolver) {
      this.logger.warn(
        `AskUserQuestion ${toolUseId}: cancel for a superseded question; dropping it`
      );
      return;
    }

    await this.deliverQueuedAnswer(toolUseId, pendingQuestion, {
      behavior: 'deny',
      message: QUESTION_CANCEL_MESSAGE,
    });
  }

  async markQuestionOrphaned(
    telemetryReason: 'agent_session_terminated' | 'rehydrate_failed' = 'agent_session_terminated'
  ): Promise<boolean> {
    const { stateManager, internalEventBus, session } = this.ctx;
    const currentState = stateManager.getState();
    if (currentState.status !== 'waiting_for_input') {
      return false;
    }

    const pendingQuestion = currentState.pendingQuestion;

    this.trackResolvedQuestion(
      pendingQuestion.toolUseId,
      pendingQuestion,
      'cancelled',
      [],
      'agent_session_terminated'
    );

    if (this.pendingResolver) {
      try {
        this.pendingResolver.reject(new Error('Question orphaned: agent session ended'));
      } catch {}
      this.pendingResolver = null;
    }
    this.queuedAnswers.delete(pendingQuestion.toolUseId);

    await stateManager.setIdle();

    try {
      await internalEventBus.publish('question.orphaned', {
        sessionId: session.id,
        toolUseId: pendingQuestion.toolUseId,
        reason: telemetryReason,
      });
    } catch (publishError) {
      this.logger.warn(
        `AskUserQuestion ${pendingQuestion.toolUseId}: question.orphaned publish failed (${
          publishError instanceof Error ? publishError.message : String(publishError)
        })`
      );
    }

    this.logger.info(
      `AskUserQuestion ${pendingQuestion.toolUseId} orphaned (telemetryReason=${telemetryReason}); UI card cleaned up`
    );
    return true;
  }

  private buildAnswers(
    pendingQuestion: PendingUserQuestion,
    responses: QuestionDraftResponse[],
    rawInput?: Record<string, unknown>
  ): Record<string, string> {
    const rawQuestions =
      (rawInput?.questions as AskUserQuestionInput['questions'] | undefined) ?? [];
    const answers: Record<string, string> = {};
    for (const response of responses) {
      const question = pendingQuestion.questions[response.questionIndex];
      if (!question) continue;
      const questionText = rawQuestions[response.questionIndex]?.question ?? question.question;

      if (response.customText) {
        answers[questionText] = response.customText;
      } else if (response.selectedLabels.length > 0) {
        answers[questionText] = response.selectedLabels.join(', ');
      }
    }
    return answers;
  }

  private async rollbackStaleWaitingState(toolUseId: string): Promise<void> {
    const { stateManager } = this.ctx;
    const currentState = stateManager.getState();
    if (
      currentState.status === 'waiting_for_input' &&
      currentState.pendingQuestion.toolUseId === toolUseId
    ) {
      try {
        await stateManager.setIdle({
          suppressIdleCallback: true,
          suppressDeliveryWaiters: true,
        });
      } catch (idleError) {
        this.logger.warn(
          `AskUserQuestion ${toolUseId}: failed to roll back stale waiting state`,
          idleError
        );
      }
    }
  }

  private async deliverQueuedAnswer(
    toolUseId: string,
    pendingQuestion: PendingUserQuestion,
    result: PermissionResult
  ): Promise<void> {
    const { stateManager, internalEventBus, session, messageQueue, ensureQueryStarted } = this.ctx;

    this.queuedAnswers.set(toolUseId, result);

    try {
      await stateManager.setIdle({ suppressDeliveryWaiters: true });
    } catch (idleError) {
      stateManager.releaseIdleWaiters();
      throw idleError;
    }

    const toolResultText =
      result.behavior === 'allow'
        ? JSON.stringify({
            answers:
              (result.updatedInput as { answers?: Record<string, string> } | undefined)?.answers ??
              {},
          })
        : result.message;

    const mode: 'submitted' | 'cancelled' = result.behavior === 'allow' ? 'submitted' : 'cancelled';

    try {
      await internalEventBus.publish('question.injected_as_tool_result', {
        sessionId: session.id,
        toolUseId,
        mode,
        via: 'tool_result',
      });
    } catch (publishError) {
      stateManager.releaseIdleWaiters();
      throw publishError;
    }

    if (!ensureQueryStarted) {
      this.logger.warn(
        `AskUserQuestion ${toolUseId}: no ensureQueryStarted on context; answer queued only`
      );
      return;
    }

    try {
      await ensureQueryStarted();
      await messageQueue.enqueueWithId(`question-${toolUseId}-${Date.now()}`, [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content: toolResultText,
        },
      ]);
    } catch (error) {
      this.logger.error(
        `AskUserQuestion ${toolUseId}: failed to inject tool_result after restart`,
        error
      );
      try {
        await stateManager.setIdle();
      } catch {}
    }

    this.logger.info(
      `AskUserQuestion ${toolUseId}: queued ${result.behavior} answer + injected tool_result for ${pendingQuestion.questions.length} question(s)`
    );
  }

  private trackResolvedQuestion(
    toolUseId: string,
    pendingQuestion: PendingUserQuestion,
    state: 'submitted' | 'cancelled',
    responses: QuestionDraftResponse[],
    cancelReason?: QuestionCancelReason
  ): void {
    const { session, db } = this.ctx;

    const resolvedQuestions = { ...session.metadata?.resolvedQuestions };
    resolvedQuestions[toolUseId] = {
      question: pendingQuestion,
      state,
      responses,
      resolvedAt: Date.now(),
      ...(state === 'cancelled' && cancelReason ? { cancelReason } : {}),
    };

    const updatedMetadata = { ...session.metadata, resolvedQuestions };
    session.metadata = updatedMetadata;

    db.updateSession(session.id, { metadata: updatedMetadata });
  }

  async updateQuestionDraft(draftResponses: QuestionDraftResponse[]): Promise<void> {
    const { stateManager } = this.ctx;
    await stateManager.updateQuestionDraft(draftResponses);
  }

  cleanup(): void {
    if (this.pendingResolver) {
      this.pendingResolver.reject(new Error('Session cleanup'));
      this.pendingResolver = null;
    }
    this.queuedAnswers.clear();
  }

  getQueuedAnswersForTesting(): Map<string, PermissionResult> {
    return new Map(this.queuedAnswers);
  }
}
