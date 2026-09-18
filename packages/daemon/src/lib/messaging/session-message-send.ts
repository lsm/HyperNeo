import { generateUUID } from '@hyperneo/shared';
import { z } from 'zod';
import type { AgentSession } from '../agent/agent-session.ts';
import { defineOperation } from '../operations/registry.ts';

export interface SessionMessageSendRow {
  status: string;
  processing_state: string | null;
}

export interface SendSessionMessageDependencies {
  getSessionRow: (
    spaceId: string,
    sessionId: string
  ) => SessionMessageSendRow | null | Promise<SessionMessageSendRow | null>;
  getLiveSession: (sessionId: string) => AgentSession | null | Promise<AgentSession | null>;
  sendUserMessage?: (data: {
    sessionId: string;
    messageId: string;
    content: string;
  }) => Promise<void>;
  audit?: (name: string, data: Record<string, unknown>) => void;
}

type QuestionDraftResponse = {
  questionIndex: number;
  selectedLabels: string[];
  customText: string | undefined;
};

export const SendSessionMessageInputSchema = z.object({
  spaceId: z.string().min(1),
  sessionId: z.string().min(1),
  message: z.string().min(1),
  answerQuestion: z.boolean().optional(),
});

export const SendSessionMessageResultSchema = z.union([
  z.object({
    success: z.literal(true),
    delivered: z.literal(true),
    message_id: z.string(),
  }),
  z.object({
    success: z.literal(false),
    error: z.string(),
  }),
]);

type SendInput = z.infer<typeof SendSessionMessageInputSchema>;
type SendResult = z.infer<typeof SendSessionMessageResultSchema>;

function parseJsonValue(value: string | null | undefined): unknown {
  if (value === null || value === undefined) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function parseProcessingState(value: string | null | undefined): Record<string, unknown> {
  const parsed = parseJsonValue(value);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return { status: value ?? 'idle' };
}

function buildQuestionResponses(
  pendingQuestion: Record<string, unknown>,
  answerText: string
): QuestionDraftResponse[] {
  const questions = Array.isArray(pendingQuestion.questions) ? pendingQuestion.questions : [];
  return questions.map((question, questionIndex) => {
    const options =
      question &&
      typeof question === 'object' &&
      Array.isArray((question as { options?: unknown }).options)
        ? ((question as { options: Array<{ label?: unknown }> }).options ?? [])
        : [];
    const firstMatchingLabel = options.find(
      (option) => typeof option.label === 'string' && option.label === answerText
    )?.label as string | undefined;
    return {
      questionIndex,
      selectedLabels: firstMatchingLabel ? [firstMatchingLabel] : [],
      customText: firstMatchingLabel ? undefined : answerText,
    };
  });
}

async function requireMutableSessionRow(
  getSessionRow: SendSessionMessageDependencies['getSessionRow'],
  spaceId: string,
  sessionId: string
): Promise<{ value: SessionMessageSendRow } | { reason: SendResult }> {
  const row = await getSessionRow(spaceId, sessionId);
  if (!row) {
    return { reason: { success: false, error: `Session not found in this space: ${sessionId}` } };
  }
  if (row.status === 'archived') {
    return { reason: { success: false, error: `Session is archived: ${sessionId}` } };
  }
  return { value: row };
}

function admitAnswerQuestion(
  input: SendInput,
  row: SessionMessageSendRow
): { value: SendInput } | { reason: SendResult } {
  const state = parseProcessingState(row.processing_state);
  if (state.status !== 'waiting_for_input') {
    return { reason: { success: false, error: 'Session is not waiting for input' } };
  }
  const pendingQuestion = state.pendingQuestion;
  if (!pendingQuestion || typeof pendingQuestion !== 'object') {
    return { reason: { success: false, error: 'Session has no pending question to answer' } };
  }
  const toolUseId = (pendingQuestion as { toolUseId?: unknown }).toolUseId;
  if (typeof toolUseId !== 'string' || !toolUseId) {
    return { reason: { success: false, error: 'Pending question is missing toolUseId' } };
  }
  const questions = Array.isArray((pendingQuestion as { questions?: unknown }).questions)
    ? (pendingQuestion as { questions: unknown[] }).questions
    : [];
  if (questions.length !== 1) {
    return {
      reason: {
        success: false,
        error:
          'answer_question only supports pending prompts with exactly one question. Use the UI for multi-question prompts.',
      },
    };
  }
  return { value: input };
}

async function requireLiveSession(
  getLiveSession: SendSessionMessageDependencies['getLiveSession'],
  sessionId: string
): Promise<{ value: AgentSession } | { reason: SendResult }> {
  const liveSession = await getLiveSession(sessionId);
  if (!liveSession) {
    return { reason: { success: false, error: `Live session not available: ${sessionId}` } };
  }
  return { value: liveSession };
}

async function deliverAnswerQuestion(
  deps: SendSessionMessageDependencies,
  input: SendInput
): Promise<SendResult> {
  const rowOutcome = await requireMutableSessionRow(
    deps.getSessionRow,
    input.spaceId,
    input.sessionId
  );
  if ('reason' in rowOutcome) return rowOutcome.reason;
  const answerOutcome = admitAnswerQuestion(input, rowOutcome.value);
  if ('reason' in answerOutcome) return answerOutcome.reason;

  const liveOutcome = await requireLiveSession(deps.getLiveSession, input.sessionId);
  if ('reason' in liveOutcome) return liveOutcome.reason;

  const state = parseProcessingState(rowOutcome.value.processing_state);
  const pendingQuestion = state.pendingQuestion as Record<string, unknown>;
  const toolUseId = pendingQuestion.toolUseId as string;
  await liveOutcome.value.handleQuestionResponse(
    toolUseId,
    buildQuestionResponses(pendingQuestion, input.message)
  );
  deps.audit?.('send_session_message', {
    session_id: input.sessionId,
    answer_question: true,
    message_length: input.message.length,
  });
  return { success: true, delivered: true, message_id: toolUseId };
}

async function deliverSessionMessage(
  deps: SendSessionMessageDependencies,
  input: SendInput
): Promise<SendResult> {
  const rowOutcome = await requireMutableSessionRow(
    deps.getSessionRow,
    input.spaceId,
    input.sessionId
  );
  if ('reason' in rowOutcome) return rowOutcome.reason;

  const messageId = generateUUID();
  if (deps.sendUserMessage) {
    await deps.sendUserMessage({
      sessionId: input.sessionId,
      messageId,
      content: input.message,
    });
  } else {
    const liveOutcome = await requireLiveSession(deps.getLiveSession, input.sessionId);
    if ('reason' in liveOutcome) return liveOutcome.reason;
    await liveOutcome.value.startQueryAndEnqueue(messageId, input.message);
  }
  deps.audit?.('send_session_message', {
    session_id: input.sessionId,
    answer_question: false,
    message_length: input.message.length,
  });
  return { success: true, delivered: true, message_id: messageId };
}

export function createSendSessionMessageOperation(deps: SendSessionMessageDependencies) {
  return defineOperation({
    name: 'session.message.send',
    policy: { safetyClass: 'mutate', audit: { redactKeys: ['message'] } },
    description:
      'Send a user message to an ad-hoc session in a Space and optionally clear a pending question; returns the delivery result.',
    inputSchema: SendSessionMessageInputSchema,
    resultSchema: SendSessionMessageResultSchema,
    execute: async (input) => {
      try {
        return input.answerQuestion
          ? await deliverAnswerQuestion(deps, input)
          : await deliverSessionMessage(deps, input);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { success: false, error: message };
      }
    },
  });
}
