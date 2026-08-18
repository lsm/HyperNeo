import type { AnthropicErrorType } from './error-envelope.js';
import {
  GLM_RATE_LIMIT_CODE,
  GLM_TRANSIENT_BODY_SUBSTRINGS,
  OVERLOAD_MESSAGE_PATTERN,
  RATE_LIMIT_MESSAGE_PATTERN,
  TRANSIENT_OVERLOAD_CODES,
  TRANSIENT_RATE_LIMIT_CODES,
} from '@hyperneo/shared/provider/error-taxonomy';

export type NormalizedUpstreamError = {
  type: AnthropicErrorType;
  status: number;
  message: string;
};

export const GLM_TRANSIENT_ERROR_SUBSTRINGS: readonly string[] = GLM_TRANSIENT_BODY_SUBSTRINGS;

function rateLimit(message: string): NormalizedUpstreamError {
  return { type: 'rate_limit_error', status: 429, message };
}

function overloaded(message: string): NormalizedUpstreamError {
  return { type: 'overloaded_error', status: 529, message };
}

function tryParseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function readStringField(
  obj: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = obj?.[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

export function isJsonContentType(contentType: string): boolean {
  return /application\/(?:[\w.+-]+\+)?json/i.test(contentType);
}

export function normalizeGlmUpstreamError(
  body: string,
  _status: number
): NormalizedUpstreamError | null {
  if (!body) return null;

  const parsed = tryParseJsonObject(body);
  const errorObj =
    parsed?.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
      ? (parsed.error as Record<string, unknown>)
      : undefined;
  const codeField = readStringField(errorObj, 'code') ?? readStringField(parsed, 'code');
  const messageForMatching =
    readStringField(errorObj, 'message') ??
    readStringField(parsed, 'message') ??
    readStringField(errorObj, 'detail') ??
    readStringField(parsed, 'detail');
  const messageField = messageForMatching ?? body;

  const isTransientCode = codeField === GLM_RATE_LIMIT_CODE;
  const hasOverloadText = parsed
    ? messageForMatching !== undefined &&
      containsAny(messageForMatching, GLM_TRANSIENT_ERROR_SUBSTRINGS)
    : containsAny(body, GLM_TRANSIENT_ERROR_SUBSTRINGS);

  if (!isTransientCode && !hasOverloadText) return null;

  if (isTransientCode) {
    return rateLimit(messageField);
  }
  return overloaded(messageField);
}

const OPENAI_RATE_LIMIT_PATTERN = RATE_LIMIT_MESSAGE_PATTERN;
const OPENAI_OVERLOAD_PATTERN = OVERLOAD_MESSAGE_PATTERN;
const TRANSIENT_RATE_LIMIT_TYPES = TRANSIENT_RATE_LIMIT_CODES;
const TRANSIENT_OVERLOAD_TYPES = TRANSIENT_OVERLOAD_CODES;

export function isOpenAiTransientErrorType(type: string): boolean {
  const t = type.toLowerCase();
  return TRANSIENT_RATE_LIMIT_TYPES.has(t) || TRANSIENT_OVERLOAD_TYPES.has(t);
}

export function normalizeOpenAiUpstreamError(
  body: string,
  status: number
): NormalizedUpstreamError | null {
  if (!body) return null;

  const parsed = tryParseJsonObject(body);
  const errorValue = parsed?.error;
  const errorObj =
    errorValue && typeof errorValue === 'object' && !Array.isArray(errorValue)
      ? (errorValue as Record<string, unknown>)
      : undefined;
  const errorString = typeof errorValue === 'string' ? errorValue : undefined;
  const typeField = (
    readStringField(errorObj, 'type') ?? readStringField(parsed, 'type')
  )?.toLowerCase();
  const codeField = (
    readStringField(errorObj, 'code') ??
    readStringField(parsed, 'code') ??
    readStringField(errorObj, 'status') ??
    readStringField(parsed, 'status') ??
    errorString
  )?.toLowerCase();
  const messageForMatching =
    readStringField(errorObj, 'message') ??
    readStringField(parsed, 'message') ??
    readStringField(errorObj, 'detail') ??
    readStringField(parsed, 'detail') ??
    errorString;
  const messageField = messageForMatching ?? body;

  const isRateType =
    (typeField !== undefined && TRANSIENT_RATE_LIMIT_TYPES.has(typeField)) ||
    (codeField !== undefined && TRANSIENT_RATE_LIMIT_TYPES.has(codeField));
  const isServerType =
    (typeField !== undefined && TRANSIENT_OVERLOAD_TYPES.has(typeField)) ||
    (codeField !== undefined && TRANSIENT_OVERLOAD_TYPES.has(codeField));

  const isRateMessage =
    messageForMatching !== undefined && OPENAI_RATE_LIMIT_PATTERN.test(messageForMatching);
  const isOverloadMessage =
    messageForMatching !== undefined && OPENAI_OVERLOAD_PATTERN.test(messageForMatching);

  const isRate = isRateType || isRateMessage;
  const isOverload = isServerType || isOverloadMessage;

  if (!isRate && !isOverload) return null;

  const isExplicitClientStatus = status >= 400 && status < 500;
  if (isExplicitClientStatus && !isRateType && !isServerType) return null;

  if (isRateType) return rateLimit(messageField);
  if (isServerType) return overloaded(messageField);
  if (isRateMessage) return rateLimit(messageField);
  return overloaded(messageField);
}

export function normalizeUpstreamError(
  body: string,
  status: number
): NormalizedUpstreamError | null {
  return normalizeGlmUpstreamError(body, status) ?? normalizeOpenAiUpstreamError(body, status);
}
