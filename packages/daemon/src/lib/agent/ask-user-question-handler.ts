/**
 * AskUserQuestionHandler - Handles the AskUserQuestion tool
 *
 * Extracted from AgentSession to reduce complexity.
 * Takes AgentSession instance directly - handlers are internal parts of AgentSession.
 *
 * The interception is exposed through TWO delivery channels, both backed by the
 * same core flow:
 *
 * 1. `createPreToolUseHook()` — a PreToolUse hook callback registered in SDK
 *    options. This is the PRIMARY channel: the CLI invokes PreToolUse hooks in
 *    every permission mode (including `bypassPermissions`), and a hook result
 *    carrying `updatedInput` with answers satisfies the tool's user-interaction
 *    requirement directly ("Hook satisfied user interaction for <tool> via
 *    updatedInput, bypassing permission prompt"). Empirically verified against
 *    SDK 0.3.233: under bypassPermissions the hook fires, its
 *    allow+updatedInput is honored, and canUseTool is never consulted for
 *    AskUserQuestion.
 * 2. `createCanUseToolCallback()` — the legacy/ACP-fallback canUseTool callback.
 *    Under `bypassPermissions` the SDK auto-approves tool calls before
 *    consulting canUseTool (warning `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`), so
 *    this channel alone silently dropped AskUserQuestion handling in
 *    default-config sessions — and even in non-bypass modes the PreToolUse
 *    hook above now satisfies the interaction before canUseTool is consulted.
 *    The callback remains in use for non-AskUserQuestion permission decisions
 *    (matched-ask-rule fail-closed, allow-all) and — crucially — by the ACP
 *    query runner, which invokes it directly on ACP permission requests.
 *
 * Core flow (shared by both channels):
 *
 * 1. Intercept the AskUserQuestion call
 * 2. Transition the agent to waiting_for_input state
 * 3. Store a Promise that waits for user input
 * 4. When user responds via RPC, resolve the Promise with formatted answers
 * 5. The SDK automatically continues with the answers
 *
 * ## Restart-survival path (task #138)
 *
 * The in-memory `pendingResolver` is bound to the live SDK query process. When
 * the daemon restarts, the SDK process dies and the resolver is gone — but the
 * persisted `waiting_for_input` state still renders the question card in the
 * UI. To make Submit/Skip work after a restart we maintain a `queuedAnswers`
 * map keyed by toolUseId:
 *
 * - On user submit/cancel after restart (no resolver): we stash a
 *   `PermissionResult` in `queuedAnswers`, transition out of
 *   `waiting_for_input`, inject a synthetic user message containing a
 *   `tool_result` block referencing the original `tool_use_id`, and trigger
 *   `ensureQueryStarted()`. The SDK resumes the conversation with the answer
 *   delivered as a normal `tool_result` user message.
 * - On the chance the SDK re-issues the AskUserQuestion call after resume,
 *   the interception core consults `queuedAnswers` first and returns the
 *   queued result immediately without re-prompting the user.
 *
 * ## Orphan cleanup
 *
 * When a session is force-completed or fails to rehydrate while in
 * `waiting_for_input`, `markQuestionOrphaned()` flips the question to a
 * `cancelled` ResolvedQuestion with cancelReason `agent_session_terminated`.
 * The UI renders these distinctly so the user knows why the card disappeared.
 *
 * See: https://platform.claude.com/docs/en/agent-sdk/permissions#handling-the-askuserquestion-tool
 */

import type {
  PendingUserQuestion,
  QuestionCancelReason,
  QuestionDraftResponse,
  Session,
} from '@hyperneo/shared';
import type { DaemonInternalEventMap, InternalEventBus } from '../internal-event-bus';
import type { Database } from '../../storage/database';
import type {
  CanUseTool,
  HookCallback,
  PermissionResult,
  PreToolUseHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type { ProcessingStateManager } from './processing-state-manager';
import type { MessageQueue } from './message-queue';
import { Logger } from '../logger';

/**
 * Context interface - what AskUserQuestionHandler needs from AgentSession
 * Using interface instead of importing AgentSession to avoid circular deps
 */
export interface AskUserQuestionHandlerContext {
  readonly session: Session;
  readonly db: Database;
  readonly stateManager: ProcessingStateManager;
  readonly internalEventBus: InternalEventBus<DaemonInternalEventMap>;
  readonly messageQueue: MessageQueue;
  /**
   * Ensure the SDK query is running so a queued tool_result can flow through
   * the streaming input pipeline. Implemented by AgentSession via
   * QueryLifecycleManager. Optional because legacy tests/contexts may not
   * provide it; callers must handle the absent case.
   */
  ensureQueryStarted?(): Promise<void>;
}

/**
 * Type for the AskUserQuestion input from SDK
 */
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

/**
 * Stored resolver for pending question
 */
interface PendingQuestionResolver {
  toolUseId: string;
  input: Record<string, unknown>;
  /** The UI structure built for this question — used to restore the card if a
   *  newer question supersedes this one mid-response-transition. */
  pendingQuestion: PendingUserQuestion;
  resolve: (result: PermissionResult) => void;
  reject: (error: Error) => void;
}

/**
 * Cancellation message delivered to the agent when the user clicks Skip.
 * Exported so tests and other layers can assert on the exact wording.
 */
export const QUESTION_CANCEL_MESSAGE =
  'User cancelled: The user chose not to answer this question. Please proceed accordingly or ask a different question if needed.';

/**
 * Maximum length for a single AskUserQuestion string field (question, header,
 * option label/description). The input is model-supplied and pre-schema-
 * validation — and newly reachable in default (bypass) config where the
 * PreToolUse hook is the primary channel — so a prompt-injected model could
 * push multi-MB strings into session metadata and broadcast them to every
 * connected client. Cap the size when building the UI structure.
 */
const MAX_QUESTION_STRING_LENGTH = 2000;

/**
 * Maximum questions per AskUserQuestion call and options per question —
 * mirrors the SDK tool schema maxItems (sdk-tools.d.ts). Hooks run before
 * schema validation, so the counts are bounded here too.
 */
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;

/** Truncate a model-supplied string field to MAX_QUESTION_STRING_LENGTH. */
function truncateQuestionString(value: string | undefined): string {
  if (typeof value !== 'string') return '';
  return value.length > MAX_QUESTION_STRING_LENGTH
    ? value.slice(0, MAX_QUESTION_STRING_LENGTH)
    : value;
}

export class AskUserQuestionHandler {
  private logger: Logger;
  private pendingResolver: PendingQuestionResolver | null = null;
  /**
   * Answers received via RPC after the in-memory resolver was lost (e.g.
   * daemon restart). Keyed by toolUseId. If the SDK re-issues the same
   * AskUserQuestion call after resume, the interception core (PreToolUse
   * hook or canUseTool callback) consumes the queued answer instead of
   * re-prompting the user.
   */
  private queuedAnswers: Map<string, PermissionResult> = new Map();

  constructor(private ctx: AskUserQuestionHandlerContext) {
    this.logger = new Logger(`AskUserQuestionHandler ${ctx.session.id}`);
  }

  /**
   * Core interception shared by the canUseTool callback and the PreToolUse
   * hook: prompt the user for an AskUserQuestion call and wait for their
   * answer. Resolves with the SDK-agnostic {@link PermissionResult}; each
   * delivery channel maps it to its own envelope shape.
   *
   * @param viaChannel Which SDK delivery channel invoked the interception —
   *   reported on the `question.injected_as_tool_result` telemetry event when
   *   a queued (post-restart) answer is consumed.
   */
  private async interceptAskUserQuestion(
    toolUseID: string,
    input: Record<string, unknown>,
    viaChannel: 'can_use_tool' | 'pre_tool_use_hook'
  ): Promise<PermissionResult> {
    const { session, stateManager, internalEventBus } = this.ctx;

    // Malformed input guard: a missing/empty questions array — a question
    // entry without an options array, or an option entry without a label —
    // would throw in the mapping below and abort the tool call inside the
    // CLI (under bypass an errored hook is non-blocking, so the question
    // would proceed with no interaction and no card). Deny with a reason
    // instead so the model sees a recoverable error.
    const askInput = input as unknown as AskUserQuestionInput;
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
          q.options.length <= MAX_OPTIONS &&
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

    // Restart-survival fast path: if a queued answer is waiting for this
    // toolUseId, resolve immediately and skip the user prompt entirely.
    const queued = this.queuedAnswers.get(toolUseID);
    if (queued) {
      this.queuedAnswers.delete(toolUseID);
      // If the queued PermissionResult was an `allow`, the SDK expects
      // updatedInput to include the original input fields plus answers.
      // Patch in any missing fields from the live `input` so we don't
      // drop required schema fields just because the resolver was lost.
      //
      // Known divergence: queued answers were keyed by the PERSISTED
      // (truncated) question text at buildAnswers time — the raw tool_input
      // is gone after a restart — so for a >MAX_QUESTION_STRING_LENGTH
      // question the SDK's raw-text answer lookup will not match. Accepted:
      // the live path keys by raw text, and over-cap questions are
      // pathological.
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
      await internalEventBus.publish('question.injected_as_tool_result', {
        sessionId: session.id,
        toolUseId: toolUseID,
        mode: queued.behavior === 'allow' ? 'submitted' : 'cancelled',
        via: viaChannel,
      });
      return merged;
    }

    // Build the pending question structure for UI
    // Use the SDK's toolUseID for consistency. String fields are truncated to
    // bound what reaches session metadata and the client broadcast (the input
    // is model-supplied and pre-schema-validation).
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

    // Create the pending promise and store the resolver SYNCHRONOUSLY before
    // the awaits below: no window may exist where the state already reflects
    // this question (setWaitingForInput) but this.pendingResolver still points
    // at the previous question — a submit/cancel landing in that window would
    // be keyed against the wrong question's raw input and mis-routed down the
    // restart-survival path.
    const pending = new Promise<PermissionResult>((resolve, reject) => {
      // A previous interception can still be pending if the model issued two
      // AskUserQuestion calls in one turn (two tool_use blocks). The resolver
      // map is single-slot; settle the superseded one with a deny RESULT —
      // not a rejection — so the CLI gets an unambiguous denial for the older
      // call. (A rejection marshals as a channel error: under
      // bypassPermissions an errored PreToolUse hook is non-blocking, so the
      // superseded call could proceed with no interaction; in 'default' mode
      // the error fall-through can re-consult canUseTool for the same
      // tool_use_id and supersede the newer question's resolver.)
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
      // Store the resolver so handleQuestionResponse can complete it
      this.pendingResolver = {
        toolUseId: toolUseID,
        input,
        pendingQuestion,
        resolve,
        reject,
      };
    });

    // Transition to waiting_for_input state
    // This will persist to DB and broadcast to clients
    try {
      await stateManager.setWaitingForInput(pendingQuestion);

      // Emit event for logging/debugging
      await internalEventBus.publish('question.asked', {
        sessionId: session.id,
        pendingQuestion,
      });
    } catch (err) {
      // The card could not be shown — drop the resolver stored above so it
      // does not dangle against a question the user never saw.
      if (this.pendingResolver?.toolUseId === toolUseID) {
        this.pendingResolver = null;
      }
      throw err;
    }

    return pending;
  }

  /**
   * Create the PreToolUse hook callback that intercepts AskUserQuestion.
   *
   * This is the PRIMARY interception channel. The CLI runs PreToolUse hooks
   * in every permission mode — including `bypassPermissions`, where the
   * canUseTool callback is shadowed by auto-approval — and an `allow`
   * decision carrying `updatedInput` with answers satisfies the tool's
   * user-interaction requirement, so the answers flow back to the model
   * without any permission prompt.
   *
   * Register with `matcher: 'AskUserQuestion'` in the SDK options (the
   * builder does this in `buildHooks()`); the callback still guards on
   * `tool_name` in case it is invoked without a matcher.
   */
  createPreToolUseHook(): HookCallback {
    return async (input) => {
      // Only intercept the AskUserQuestion tool; everything else passes
      // through untouched (permission mode rules decide those).
      if (
        (input as PreToolUseHookInput).hook_event_name !== 'PreToolUse' ||
        (input as PreToolUseHookInput).tool_name !== 'AskUserQuestion'
      ) {
        return {};
      }

      const preInput = input as PreToolUseHookInput;
      const result = await this.interceptAskUserQuestion(
        preInput.tool_use_id,
        (preInput.tool_input ?? {}) as Record<string, unknown>,
        'pre_tool_use_hook'
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

  /**
   * Create the canUseTool callback for SDK options
   *
   * Legacy channel: under `bypassPermissions` the SDK never consults
   * canUseTool (see `createPreToolUseHook()`), so AskUserQuestion handling
   * here is a fallback for non-bypass modes. Also invoked directly by the
   * ACP query runner on ACP permission requests.
   */
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
      // Only intercept AskUserQuestion tool
      if (toolName !== 'AskUserQuestion') {
        // A user-configured permissions.ask rule forced this prompt. In an
        // auto-allow mode the generic path would silently bypass the user's
        // explicit ask, so fail closed rather than approve without consent.
        if (options.matchedAskRule) {
          return {
            behavior: 'deny',
            message: `Permission required by ask rule: ${options.matchedAskRule.ruleContent ?? options.matchedAskRule.toolName}`,
          };
        }
        // Allow all other tools (they go through permission mode settings)
        return { behavior: 'allow', updatedInput: input };
      }

      return this.interceptAskUserQuestion(options.toolUseID, input, 'can_use_tool');
    };
  }

  /**
   * Handle user's response to an AskUserQuestion
   *
   * This is called from the RPC handler when user submits their answer.
   * It resolves the pending Promise stored by the interception core (hook or
   * canUseTool channel) with the formatted answers.
   *
   * @param toolUseId - The tool use ID from the question (for validation)
   * @param responses - Array of user responses for each question
   */
  async handleQuestionResponse(
    toolUseId: string,
    responses: QuestionDraftResponse[]
  ): Promise<void> {
    const { stateManager } = this.ctx;
    const currentState = stateManager.getState();

    // Verify we're in waiting_for_input state
    if (currentState.status !== 'waiting_for_input') {
      throw new Error(
        `Cannot respond to question: agent is not waiting for input (status: ${currentState.status})`
      );
    }

    // Verify the toolUseId matches the persisted question
    if (currentState.pendingQuestion.toolUseId !== toolUseId) {
      throw new Error(
        `Tool use ID mismatch: expected ${currentState.pendingQuestion.toolUseId}, got ${toolUseId}`
      );
    }

    // Capture the pending question before transitioning state
    const pendingQuestion = currentState.pendingQuestion;

    // Capture the live resolver BEFORE building answers: answers must be keyed
    // against the RAW (untruncated) question text in the tool_input — the
    // pendingQuestion copy is truncated for the UI surface, and the live path
    // returns updatedInput: {...resolver.input, answers}, so a truncated key
    // would not match the text the SDK/model looks up answers by. Only use the
    // resolver's input when it actually belongs to this question.
    const resolver = this.pendingResolver;
    const resolverMatches = !!resolver && resolver.toolUseId === toolUseId;

    // Format the answers as expected by the SDK
    // Maps question text to selected option label(s)
    const answers = this.buildAnswers(
      pendingQuestion,
      responses,
      resolverMatches ? resolver.input : undefined
    );

    // Track resolved question in session metadata. We do this BEFORE the
    // state transition so the metadata is durable even if the deliver step
    // throws midway.
    this.trackResolvedQuestion(toolUseId, pendingQuestion, 'submitted', responses);

    // Happy path: a live SDK query is awaiting our resolver — resolve in-memory.
    // The resolver was captured before the state transition: if a second
    // AskUserQuestion supersedes during the await, the post-await capture
    // would resolve the newer resolver with this older question's answers.
    if (resolverMatches) {
      // Transition back to processing state
      await stateManager.setProcessing(toolUseId, 'streaming');
      // Re-verify after the await — the supersede block already denied the
      // old resolver, and this submit is stale. Restore the newer question's
      // card (this transition clobbered it) so it stays answerable.
      if (this.pendingResolver !== resolver) {
        this.logger.warn(
          `AskUserQuestion ${toolUseId}: submit arrived after the question was superseded; dropping it`
        );
        const current = this.pendingResolver;
        if (current) {
          await stateManager.setWaitingForInput(current.pendingQuestion);
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

    // A resolver exists but belongs to a different (newer) question: this
    // submit is for a question that was superseded while its card was being
    // replaced — drop it rather than mis-queueing it down the restart path.
    if (resolver) {
      this.logger.warn(
        `AskUserQuestion ${toolUseId}: submit for a superseded question; dropping it`
      );
      return;
    }

    // Restart-survival path: the original resolver is gone (daemon restart,
    // session cleanup, etc.). Queue the answer for the resumed SDK and
    // inject a synthetic tool_result user message to drive the conversation
    // forward.
    await this.deliverQueuedAnswer(toolUseId, pendingQuestion, {
      behavior: 'allow',
      updatedInput: { answers },
    });
  }

  /**
   * Handle user cancelling a pending question
   *
   * This denies the AskUserQuestion tool, which tells Claude the user
   * declined to answer.
   */
  async handleQuestionCancel(toolUseId: string): Promise<void> {
    const { stateManager } = this.ctx;
    const currentState = stateManager.getState();

    // Verify we're in waiting_for_input state
    if (currentState.status !== 'waiting_for_input') {
      throw new Error(
        `Cannot cancel question: agent is not waiting for input (status: ${currentState.status})`
      );
    }

    // Verify the toolUseId matches
    if (currentState.pendingQuestion.toolUseId !== toolUseId) {
      throw new Error(
        `Tool use ID mismatch: expected ${currentState.pendingQuestion.toolUseId}, got ${toolUseId}`
      );
    }

    // Capture the pending question before transitioning state
    const pendingQuestion = currentState.pendingQuestion;

    // Track cancelled question in session metadata (user-initiated cancel)
    this.trackResolvedQuestion(toolUseId, pendingQuestion, 'cancelled', [], 'user_cancelled');

    // Happy path: a live SDK query is awaiting our resolver.
    // Capture the resolver BEFORE the state transition and re-verify after —
    // a second AskUserQuestion superseding during the await would otherwise
    // cancel the newer question with this older question's intent.
    const resolver = this.pendingResolver;
    if (resolver && resolver.toolUseId === toolUseId) {
      await stateManager.setProcessing(toolUseId, 'streaming');
      if (this.pendingResolver !== resolver) {
        this.logger.warn(
          `AskUserQuestion ${toolUseId}: cancel arrived after the question was superseded; dropping it`
        );
        const current = this.pendingResolver;
        if (current) {
          await stateManager.setWaitingForInput(current.pendingQuestion);
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

    // A resolver exists but belongs to a different (newer) question: this
    // cancel is for a question that was superseded while its card was being
    // replaced — drop it rather than mis-queueing it down the restart path.
    if (resolver) {
      this.logger.warn(
        `AskUserQuestion ${toolUseId}: cancel for a superseded question; dropping it`
      );
      return;
    }

    // Restart-survival path: queue a deny + inject the cancellation message.
    await this.deliverQueuedAnswer(toolUseId, pendingQuestion, {
      behavior: 'deny',
      message: QUESTION_CANCEL_MESSAGE,
    });
  }

  /**
   * Mark a pending question as orphaned because the owning session is no
   * longer alive (force-completion, rehydrate failure, daemon shutdown, etc.).
   *
   * Idempotent: safe to call when the session is not in `waiting_for_input`
   * (returns false). The persisted question is flipped to a `cancelled`
   * ResolvedQuestion with cancelReason `agent_session_terminated` (always —
   * the UI only renders one orphan-cancelled state today) and the
   * processing state is reset to `idle` so the UI removes the dead-end card.
   *
   * @param telemetryReason Annotates the `question.orphaned` internalEventBus event
   *   only. Does NOT affect the persisted `cancelReason` on the resolved
   *   record — that's hardcoded to `agent_session_terminated` because the UI
   *   has no separate rendering for `rehydrate_failed`. If a future UX
   *   distinguishes the two, plumb this param through to `trackResolvedQuestion`.
   * @returns true if a question was actually orphaned, false if there was
   *   nothing to clean up.
   */
  async markQuestionOrphaned(
    telemetryReason: 'agent_session_terminated' | 'rehydrate_failed' = 'agent_session_terminated'
  ): Promise<boolean> {
    const { stateManager, internalEventBus, session } = this.ctx;
    const currentState = stateManager.getState();
    if (currentState.status !== 'waiting_for_input') {
      return false;
    }

    const pendingQuestion = currentState.pendingQuestion;

    // Track as cancelled. The persisted `cancelReason` is intentionally
    // always `agent_session_terminated` — see JSDoc on `telemetryReason`
    // for why we don't pass `telemetryReason` through here.
    this.trackResolvedQuestion(
      pendingQuestion.toolUseId,
      pendingQuestion,
      'cancelled',
      [],
      'agent_session_terminated'
    );

    // Reject any pending in-memory resolver so an awaiting SDK query (rare
    // but possible) doesn't leak a hanging Promise.
    if (this.pendingResolver) {
      try {
        this.pendingResolver.reject(new Error('Question orphaned: agent session ended'));
      } catch {
        // Ignore — best-effort cleanup
      }
      this.pendingResolver = null;
    }
    // Drop any queued answer for this question; nothing left to deliver to.
    this.queuedAnswers.delete(pendingQuestion.toolUseId);

    // Drop waiting_for_input state so the UI removes the live card. The
    // resolved-question record persisted above is what the UI renders going
    // forward.
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

  /**
   * Build the answers map from the user's responses.
   * Maps question text → selected option label(s) or custom text.
   *
   * Answers are keyed by the RAW question text from the tool_input (when a
   * live resolver is available): the `pendingQuestion` copy is truncated for
   * the UI surface, and the live path returns `updatedInput: {...resolver.input,
   * answers}` — a truncated key would not match the original text the
   * SDK/model looks answers up by. Without a live resolver (post-restart), the
   * persisted (truncated) question text is the only key available.
   */
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
        // User provided custom text via "Other" option
        answers[questionText] = response.customText;
      } else if (response.selectedLabels.length > 0) {
        // User selected one or more predefined options
        // Multi-select answers are comma-separated
        answers[questionText] = response.selectedLabels.join(', ');
      }
    }
    return answers;
  }

  /**
   * Restart-survival delivery: queue the answer for the resumed SDK and
   * inject a synthetic tool_result user message into the streaming queue so
   * the conversation moves forward even if the SDK does not re-issue the
   * AskUserQuestion call.
   *
   * Both halves are intentionally redundant:
   * 1. `queuedAnswers` covers the case where the SDK re-plays the
   *    AskUserQuestion call (the interception core — PreToolUse hook or
   *    canUseTool — consumes the queued answer).
   * 2. The injected `tool_result` user message covers the case where the SDK
   *    treats the prior tool_use as already-resolved and just needs the
   *    matching tool_result to continue the conversation cleanly.
   */
  private async deliverQueuedAnswer(
    toolUseId: string,
    pendingQuestion: PendingUserQuestion,
    result: PermissionResult
  ): Promise<void> {
    const { stateManager, internalEventBus, session, messageQueue, ensureQueryStarted } = this.ctx;

    this.queuedAnswers.set(toolUseId, result);

    // Drop waiting_for_input state — the question is resolved from the user's
    // perspective. Going to idle (rather than processing) lets the SDK
    // query restart cleanly via ensureQueryStarted(). Suppress the delivery-
    // waiter drain: this idle is a retry mid-point (the query restarts below to
    // inject the tool result), not a terminal turn-end. If the suppressed idle
    // rejects (e.g. a session.updated subscriber fails during publish), release
    // the waiter before propagating — this sits outside the reinjection try
    // below, so without the release the durable turn would hang `processing`.
    // (Codex P1.)
    try {
      await stateManager.setIdle({ suppressDeliveryWaiters: true });
    } catch (idleError) {
      stateManager.releaseIdleWaiters();
      throw idleError;
    }

    // Build the tool_result content text. For `allow`, serialize the answers
    // as JSON so the agent can parse them. For `deny`, use the cancellation
    // message as the tool_result content (matches what the SDK would have
    // produced in the live-resolver path).
    const toolResultText =
      result.behavior === 'allow'
        ? JSON.stringify({
            answers:
              (result.updatedInput as { answers?: Record<string, string> } | undefined)?.answers ??
              {},
          })
        : result.message;

    const mode: 'submitted' | 'cancelled' = result.behavior === 'allow' ? 'submitted' : 'cancelled';

    // This publish sits between the suppressed idle above and the reinjection
    // try below; a rejecting subscriber would stop execution before the
    // reinjection catch's terminal idle, leaving the durable turn waiter
    // pending (the question is already resolved, so nothing retries it). Wrap it
    // in the same release-on-failure cleanup. (Codex P1.)
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

    // Best-effort: start the SDK query and enqueue the tool_result. If the
    // agent session has no ensureQueryStarted (e.g. a unit-test context),
    // we still queue the answer for whenever the SDK eventually resumes.
    if (!ensureQueryStarted) {
      this.logger.warn(
        `AskUserQuestion ${toolUseId}: no ensureQueryStarted on context; answer queued only`
      );
      return;
    }

    try {
      await ensureQueryStarted();
      // Inject as a tool_result content block. MessageQueue extracts
      // `tool_use_id` from the block and forwards it as
      // `parent_tool_use_id` on the SDK user message — that's the wire
      // format the Anthropic API expects for a user→assistant tool reply.
      //
      // Redundancy note: if the resumed SDK query *also* re-fires the
      // interception for the same `tool_use_id` (path A — queuedAnswers
      // consumed), the SDK will see two responses for that tool_use:
      // the hook/canUseTool return and this enqueued tool_result. In
      // practice the SDK we use treats the interception response as
      // authoritative and forwards the tool_result as a regular user
      // message. We tolerate the duplicate rather than try to detect
      // which path the SDK will pick before it picks one.
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
      // The answer reinjection failed, so this turn can't continue: end it
      // (terminal setIdle) to release the durable-delivery turn waiter —
      // otherwise driveDeliveryTurn's job hangs `processing` waiting for an
      // idle that will never come. Best-effort; don't let a publish failure
      // mask the original error.
      try {
        await stateManager.setIdle();
      } catch {
        /* non-fatal — the turn is abandoned either way */
      }
      // Leave the queued answer in place — a future interception fire can
      // still consume it. Do not rethrow; the user's RPC already
      // succeeded from their perspective (the question is marked
      // resolved and removed from the UI).
    }

    // Mention the toolUseId in the closing log so production traces can
    // follow a single question end-to-end through restart.
    this.logger.info(
      `AskUserQuestion ${toolUseId}: queued ${result.behavior} answer + injected tool_result for ${pendingQuestion.questions.length} question(s)`
    );
  }

  /**
   * Track resolved question in session metadata
   *
   * Records whether the question was submitted or cancelled for history tracking.
   */
  private trackResolvedQuestion(
    toolUseId: string,
    pendingQuestion: PendingUserQuestion,
    state: 'submitted' | 'cancelled',
    responses: QuestionDraftResponse[],
    cancelReason?: QuestionCancelReason
  ): void {
    const { session, db } = this.ctx;

    // Build the resolved questions record
    const resolvedQuestions = { ...session.metadata?.resolvedQuestions };
    resolvedQuestions[toolUseId] = {
      question: pendingQuestion,
      state,
      responses,
      resolvedAt: Date.now(),
      ...(state === 'cancelled' && cancelReason ? { cancelReason } : {}),
    };

    // Update session metadata
    const updatedMetadata = { ...session.metadata, resolvedQuestions };
    session.metadata = updatedMetadata;

    // Persist to database
    db.updateSession(session.id, { metadata: updatedMetadata });
  }

  /**
   * Update draft responses for pending question
   * Called by question.saveDraft RPC to preserve user selections
   */
  async updateQuestionDraft(draftResponses: QuestionDraftResponse[]): Promise<void> {
    const { stateManager } = this.ctx;
    await stateManager.updateQuestionDraft(draftResponses);
  }

  /**
   * Cleanup any pending resolvers (called during session cleanup).
   *
   * Note: this does NOT mark the persisted question as cancelled — callers
   * that want the UI card to update should invoke `markQuestionOrphaned`
   * first. `cleanup()` only releases in-memory references.
   */
  cleanup(): void {
    if (this.pendingResolver) {
      this.pendingResolver.reject(new Error('Session cleanup'));
      this.pendingResolver = null;
    }
    this.queuedAnswers.clear();
  }

  /**
   * Inspect the current queued-answer map.
   *
   * @internal Test-only inspector. Production code MUST NOT depend on this
   * — it bypasses the live-interception delivery contract and is exposed solely so
   * unit tests can assert side-effects of `submitQuestionResponse` and
   * `cancelQuestion` along the post-restart path. Returns a shallow copy
   * so callers cannot mutate handler internals.
   */
  getQueuedAnswersForTesting(): Map<string, PermissionResult> {
    return new Map(this.queuedAnswers);
  }
}
