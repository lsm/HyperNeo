import { createLogger } from '../logger.ts';
import { generateUUID } from '../utils.ts';

const log = createLogger('hyperneo:messagehub:protocol');

const PROTOCOL_VERSION = '1.0.0';

export enum MessageType {
  EVENT = 'EVENT',

  PING = 'PING',

  PONG = 'PONG',

  REQUEST = 'REQ',

  RESPONSE = 'RSP',
}

export interface HubMessage {
  id: string;

  type: MessageType;

  sessionId: string;

  method: string;

  data?: unknown;

  requestId?: string;

  error?: string;

  errorCode?: string;

  timestamp: string;

  version?: string;

  channel?: string;

  _transportName?: string;
}

export interface EventMessage extends HubMessage {
  type: MessageType.EVENT;
  method: string;
  data?: unknown;
}

export interface RequestMessage extends HubMessage {
  type: MessageType.REQUEST;
  method: string;
  data?: unknown;
}

export interface ResponseMessage extends HubMessage {
  type: MessageType.RESPONSE;
  method: string;
  requestId: string;
  data?: unknown;
  error?: string;
  errorCode?: string;
}

export function isEventMessage(msg: HubMessage): msg is EventMessage {
  return msg.type === MessageType.EVENT;
}

export function isRequestMessage(msg: HubMessage): msg is RequestMessage {
  return msg.type === MessageType.REQUEST;
}

export function isResponseMessage(msg: HubMessage): msg is ResponseMessage {
  return msg.type === MessageType.RESPONSE;
}

export interface HubMessageWithMetadata extends HubMessage {
  clientId?: string;
}

export const GLOBAL_SESSION_ID = 'global';

export function validateMethod(method: string): boolean {
  if (!method.includes('.')) {
    return false;
  }

  if (method.startsWith('.') || method.endsWith('.')) {
    return false;
  }

  if (method.includes(':')) {
    return false;
  }

  return /^[a-zA-Z0-9._-]+$/.test(method);
}

export enum ErrorCode {
  INVALID_MESSAGE = 'INVALID_MESSAGE',
  INVALID_METHOD = 'INVALID_METHOD',
  PROTOCOL_VERSION_MISMATCH = 'PROTOCOL_VERSION_MISMATCH',

  METHOD_NOT_FOUND = 'METHOD_NOT_FOUND',
  HANDLER_ERROR = 'HANDLER_ERROR',
  TIMEOUT = 'TIMEOUT',
  INVALID_PARAMS = 'INVALID_PARAMS',

  INVALID_SESSION = 'INVALID_SESSION',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',

  TRANSPORT_ERROR = 'TRANSPORT_ERROR',
  NOT_CONNECTED = 'NOT_CONNECTED',
  MESSAGE_TOO_LARGE = 'MESSAGE_TOO_LARGE',

  TOO_MANY_SUBSCRIPTIONS = 'TOO_MANY_SUBSCRIPTIONS',

  INTERNAL_ERROR = 'INTERNAL_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
}

export interface ErrorDetail {
  code: string;
  message: string;
}

export interface CreateEventMessageParams {
  method: string;
  data: unknown;
  sessionId: string;
  id?: string;
}

export interface CreateRequestMessageParams {
  method: string;
  data?: unknown;
  sessionId: string;
  channel?: string;
  id?: string;
}

export interface CreateResponseMessageParams {
  method: string;
  data?: unknown;
  sessionId: string;
  requestId: string;
  channel?: string;
  id?: string;
}

export interface CreateErrorResponseMessageParams {
  method: string;
  error: string | ErrorDetail;
  sessionId: string;
  requestId: string;
  channel?: string;
  id?: string;
}

export function createEventMessage(params: CreateEventMessageParams): EventMessage {
  const { method, data, sessionId, id } = params;
  return {
    id: id || generateUUID(),
    type: MessageType.EVENT,
    sessionId,
    method,
    data,
    timestamp: new Date().toISOString(),
    version: PROTOCOL_VERSION,
  };
}

export function createRequestMessage(params: CreateRequestMessageParams): RequestMessage {
  const { method, data, sessionId, channel, id } = params;
  return {
    id: id || generateUUID(),
    type: MessageType.REQUEST,
    sessionId,
    method,
    data,
    channel,
    timestamp: new Date().toISOString(),
    version: PROTOCOL_VERSION,
  };
}

export function createResponseMessage(params: CreateResponseMessageParams): ResponseMessage {
  const { method, data, sessionId, requestId, channel, id } = params;
  return {
    id: id || generateUUID(),
    type: MessageType.RESPONSE,
    sessionId,
    method,
    data,
    requestId,
    channel,
    timestamp: new Date().toISOString(),
    version: PROTOCOL_VERSION,
  };
}

export function createErrorResponseMessage(
  params: CreateErrorResponseMessageParams
): ResponseMessage {
  const { method, error: errorParam, sessionId, requestId, channel, id } = params;
  const errorMessage = typeof errorParam === 'string' ? errorParam : errorParam.message;
  const code = typeof errorParam === 'string' ? undefined : errorParam.code;

  return {
    id: id || generateUUID(),
    type: MessageType.RESPONSE,
    sessionId,
    method,
    error: errorMessage,
    errorCode: code,
    requestId,
    channel,
    timestamp: new Date().toISOString(),
    version: PROTOCOL_VERSION,
  };
}

export function isValidMessage(msg: unknown): msg is HubMessage {
  if (!msg || typeof msg !== 'object') {
    return false;
  }

  const m = msg as Record<string, unknown>;

  if (typeof m.id !== 'string' || m.id.length === 0) {
    return false;
  }

  if (typeof m.type !== 'string' || !Object.values(MessageType).includes(m.type as MessageType)) {
    return false;
  }

  if (typeof m.sessionId !== 'string' || m.sessionId.length === 0) {
    return false;
  }

  if (typeof m.method !== 'string' || m.method.length === 0) {
    return false;
  }

  if (typeof m.timestamp !== 'string') {
    return false;
  }

  if (m.version !== undefined && m.version !== null) {
    if (typeof m.version !== 'string') {
      return false;
    }

    if (m.version !== PROTOCOL_VERSION) {
      log.warn(
        `Version mismatch: received ${m.version}, expected ${PROTOCOL_VERSION}. ` +
          `Message will be processed but may have compatibility issues.`
      );
    }
  }

  if (m.type !== MessageType.PING && m.type !== MessageType.PONG) {
    if (!validateMethod(m.method)) {
      return false;
    }
  }

  if (m.type === MessageType.RESPONSE && typeof m.requestId !== 'string') {
    return false;
  }

  return true;
}
