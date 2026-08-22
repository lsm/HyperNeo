import { PROMPT_TOO_LONG_CONTINUE_NAG } from '@hyperneo/prompts';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import { PROMPT_TOO_LONG_RE } from '@hyperneo/shared/provider/error-taxonomy';

export const MAX_PROMPT_TOO_LONG_RECOVERY_ATTEMPTS = 2;

export const COMPACT_RESULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface PromptTooLongRecoveryState {
  compactAttempts: number;
  compactRetryPending: boolean;
  awaitingContinue: boolean;
  awaitingContinueAfterDbId: string | null;
  awaitingContinueSince: number | null;
  continueNagPending: boolean;
  continueNagAttempts: number;
  awaitingResume: boolean;
  awaitingResumeAfterDbId: string | null;
  awaitingResumeSince: number | null;
  awaitingResumeLastProgressDbId: string | null;
}

export function createPromptTooLongRecoveryState(): PromptTooLongRecoveryState {
  return {
    compactAttempts: 0,
    compactRetryPending: false,
    awaitingContinue: false,
    awaitingContinueAfterDbId: null,
    awaitingContinueSince: null,
    continueNagPending: false,
    continueNagAttempts: 0,
    awaitingResume: false,
    awaitingResumeAfterDbId: null,
    awaitingResumeSince: null,
    awaitingResumeLastProgressDbId: null,
  };
}

const LOCAL_COMMAND_STDERR_RE = /<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/gi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function extractUserMessageText(message: SDKMessage): string {
  const user = message as { message?: { content?: unknown } };
  const content = user.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block;
        if (isRecord(block)) {
          if (typeof block.text === 'string') return block.text;
          if (typeof block.content === 'string') return block.content;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function extractStderrText(text: string): string {
  const parts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = LOCAL_COMMAND_STDERR_RE.exec(text)) !== null) {
    parts.push(match[1]);
  }
  LOCAL_COMMAND_STDERR_RE.lastIndex = 0;
  return parts.join('\n');
}

export function isPromptTooLongResult(message: SDKMessage | null | undefined): boolean {
  if (!message) return false;
  const msg = message as {
    type?: string;
    terminal_reason?: string;
    errors?: unknown;
    is_error?: boolean;
    result?: unknown;
  };
  if (msg.type !== 'result') return false;
  if (msg.terminal_reason === 'prompt_too_long') return true;
  if (Array.isArray(msg.errors)) {
    for (const err of msg.errors) {
      if (typeof err === 'string' && PROMPT_TOO_LONG_RE.test(err)) {
        return true;
      }
    }
  }
  if (
    msg.is_error === true &&
    typeof msg.result === 'string' &&
    PROMPT_TOO_LONG_RE.test(msg.result)
  ) {
    return true;
  }
  return false;
}

export function isPromptTooLongUserMessage(message: SDKMessage | null | undefined): boolean {
  if (!message) return false;
  if ((message as { type?: string }).type !== 'user') return false;
  const text = extractUserMessageText(message);
  const stderr = extractStderrText(text);
  return stderr.length > 0 && PROMPT_TOO_LONG_RE.test(stderr);
}

export function isPromptTooLongErrorMessage(message: SDKMessage | null | undefined): boolean {
  return isPromptTooLongResult(message) || isPromptTooLongUserMessage(message);
}

export function buildPromptTooLongContinueNag(): string {
  return PROMPT_TOO_LONG_CONTINUE_NAG;
}
