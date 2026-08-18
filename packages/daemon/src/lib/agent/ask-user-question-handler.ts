import type {
  PendingUserQuestion,
  QuestionCancelReason,
  QuestionDraftResponse,
  Session,
} from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Database } from '../../storage/database';
import type { CanUseTool, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { ProcessingStateManager } from './processing-state-manager';
import type { MessageQueue } from './message-queue';
import { Logger } from '../logger';

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
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
}

export const QUESTION_CANCEL_MESSAGE =
  'User cancelled: The user chose not to answer this question. Please proceed accordingly or ask a different question if needed.';

export class AskUserQuestionHandler {
  private logger: Logger;
  private pendingResolver: PendingQuestionResolver | null = null;
  private queuedAnswers: Map<string, PermissionResult> = new Map();

  constructor(private ctx: AskUserQuestionHandlerContext) {
    this.logger = new Logger(`AskUserQuestionHandler ${ctx.session.id}`);
  }

  createCanUseToolCallback(): CanUseTool {
    return async (
      toolName: string,
      input: Record<string, unknown>,
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
      const { session, stateManager, internalEventBus } = this.ctx;

      if (toolName !== 'AskUserQuestion') {
        if (options.matchedAskRule) {
          return {
            behavior: 'deny',
            message: `Permission required by ask rule: ${options.matchedAskRule.ruleContent ?? options.matchedAskRule.toolName}`,
          };
        }
        return { behavior: 'allow', updatedInput: input };
      }

      const queued = this.queuedAnswers.get(options.toolUseID);
      if (queued) {
        this.queuedAnswers.delete(options.toolUseID);
        const merged: PermissionResult =
          queued.behavior === 'allow'
            ? {
                behavior: 'allow',
                updatedInput: { ...input, ...queued.updatedInput },
              }
            : queued;
        this.logger.info(
          `AskUserQuestion ${options.toolUseID}: consuming queued answer (behavior=${queued.behavior})`
        );
        await internalEventBus.publish('question.injected_as_tool_result', {
          sessionId: session.id,
          toolUseId: options.toolUseID,
          mode: queued.behavior === 'allow' ? 'submitted' : 'cancelled',
          viaCanUseTool: true,
        });
        return merged;
      }

      const askInput = input as unknown as AskUserQuestionInput;

      const pendingQuestion: PendingUserQuestion = {
        toolUseId: options.toolUseID,
        questions: askInput.questions.map((q) => ({
          question: q.question,
          header: q.header,
          options: q.options.map((o) => ({
            label: o.label,
            description: o.description,
          })),
          multiSelect: q.multiSelect,
        })),
        askedAt: Date.now(),
      };

      await stateManager.setWaitingForInput(pendingQuestion);

      await internalEventBus.publish('question.asked', {
        sessionId: session.id,
        pendingQuestion,
      });

      return new Promise<PermissionResult>((resolve, reject) => {
        this.pendingResolver = {
          toolUseId: options.toolUseID,
          input,
          resolve,
          reject,
        };
      });
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

    const answers = this.buildAnswers(pendingQuestion, responses);

    this.trackResolvedQuestion(toolUseId, pendingQuestion, 'submitted', responses);

    if (this.pendingResolver && this.pendingResolver.toolUseId === toolUseId) {
      await stateManager.setProcessing(toolUseId, 'streaming');
      const resolver = this.pendingResolver;
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

    this.trackResolvedQuestion(toolUseId, pendingQuestion, 'cancelled', [], 'user_cancelled');

    if (this.pendingResolver && this.pendingResolver.toolUseId === toolUseId) {
      await stateManager.setProcessing(toolUseId, 'streaming');
      const resolver = this.pendingResolver;
      this.pendingResolver = null;
      resolver.resolve({
        behavior: 'deny',
        message: QUESTION_CANCEL_MESSAGE,
      });
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
      } catch {
        // Ignore — best-effort cleanup
      }
      this.pendingResolver = null;
    }
    this.queuedAnswers.delete(pendingQuestion.toolUseId);

    await stateManager.setIdle();

    await internalEventBus.publish('question.orphaned', {
      sessionId: session.id,
      toolUseId: pendingQuestion.toolUseId,
      reason: telemetryReason,
    });

    this.logger.info(
      `AskUserQuestion ${pendingQuestion.toolUseId} orphaned (telemetryReason=${telemetryReason}); UI card cleaned up`
    );
    return true;
  }

  private buildAnswers(
    pendingQuestion: PendingUserQuestion,
    responses: QuestionDraftResponse[]
  ): Record<string, string> {
    const answers: Record<string, string> = {};
    for (const response of responses) {
      const question = pendingQuestion.questions[response.questionIndex];
      if (!question) continue;

      if (response.customText) {
        answers[question.question] = response.customText;
      } else if (response.selectedLabels.length > 0) {
        answers[question.question] = response.selectedLabels.join(', ');
      }
    }
    return answers;
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
        viaCanUseTool: false,
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
      } catch {
        /* non-fatal — the turn is abandoned either way */
      }
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
