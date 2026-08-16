/**
 * MessageHub Protocol
 *
 * WAMP-inspired unified messaging protocol for bidirectional RPC and Pub/Sub.
 *
 * Key features:
 * - Bidirectional RPC (client↔server)
 * - Pub/Sub messaging
 * - Session-based routing (sessionId in message, not URL)
 * - Type-safe method registry
 */

import { createLogger } from '../logger.ts';
import { generateUUID } from '../utils.ts';

const log = createLogger('hyperneo:messagehub:protocol');

/**
 * Protocol version for compatibility checking
 */
const PROTOCOL_VERSION = '1.0.0';

/**
 * Message types following WAMP-inspired pattern
 */
export enum MessageType {
  /**
   * Event delivery to subscriber
   */
  EVENT = 'EVENT',

  /**
   * Heartbeat/ping for connection health
   */
  PING = 'PING',

  /**
   * Pong response to ping
   */
  PONG = 'PONG',

  /**
   * Request expecting a response
   */
  REQUEST = 'REQ',

  /**
   * Response to request
   */
  RESPONSE = 'RSP',
}

/**
 * Base message structure for all MessageHub communications
 */
export interface HubMessage {
  /**
   * Unique message identifier (UUID)
   */
  id: string;

  /**
   * Message type
   */
  type: MessageType;

  /**
   * Session routing identifier
   * - "global" for system-wide operations
   * - Specific session ID for session-scoped operations
   */
  sessionId: string;

  /**
   * Method/Event name
   * Format: <domain>.<action>[.<type>]
   * Examples: "session.create", "session.deleted", "client.getViewportInfo"
   */
  method: string;

  /**
   * Message payload (method-specific)
   */
  data?: unknown;

  /**
   * Original request ID (for RESULT/ERROR responses)
   */
  requestId?: string;

  /**
   * Error message (for ERROR type)
   */
  error?: string;

  /**
   * Error code (for ERROR type)
   */
  errorCode?: string;

  /**
   * ISO 8601 timestamp
   */
  timestamp: string;

  /**
   * Protocol version
   */
  version?: string;

  /**
   * Optional channel identifier for scoped messaging
   */
  channel?: string;

  /**
   * Optional transport name for response routing (internal use)
   * Tags message with the transport it came from so responses can be routed correctly
   */
  _transportName?: string;
}

/**
 * EVENT message (pub/sub event delivery)
 */
export interface EventMessage extends HubMessage {
  type: MessageType.EVENT;
  method: string;
  data?: unknown;
}

/**
 * REQUEST message (request expecting response)
 */
export interface RequestMessage extends HubMessage {
  type: MessageType.REQUEST;
  method: string;
  data?: unknown;
}

/**
 * RESPONSE message (response to request)
 */
export interface ResponseMessage extends HubMessage {
  type: MessageType.RESPONSE;
  method: string;
  requestId: string;
  data?: unknown;
  error?: string;
  errorCode?: string;
}

/**
 * Type guards
 */
export function isEventMessage(msg: HubMessage): msg is EventMessage {
  return msg.type === MessageType.EVENT;
}

/**
 * Check if message is a REQUEST
 */
export function isRequestMessage(msg: HubMessage): msg is RequestMessage {
  return msg.type === MessageType.REQUEST;
}

/**
 * Check if message is a RESPONSE
 */
export function isResponseMessage(msg: HubMessage): msg is ResponseMessage {
  return msg.type === MessageType.RESPONSE;
}

/**
 * HubMessage with internal metadata added by transport layer
 * This extends the protocol message with server-side routing metadata
 */
export interface HubMessageWithMetadata extends HubMessage {
  /**
   * Client ID added by server-side transport for subscription tracking and routing.
   * Not part of the wire protocol - added internally during message processing.
   */
  clientId?: string;
}

/**
 * Session ID constants
 */
export const GLOBAL_SESSION_ID = 'global';

/**
 * Validate method name
 *
 * Format: "domain.action" (e.g., "session.create", "user.update")
 * - Must contain at least one dot
 * - Can contain alphanumeric, dots, underscores, hyphens
 * - Colons are RESERVED for internal use (not allowed in user-defined methods)
 */
export function validateMethod(method: string): boolean {
  // Must have at least one dot (for the method part)
  if (!method.includes('.')) {
    return false;
  }

  // Must not start or end with dot
  if (method.startsWith('.') || method.endsWith('.')) {
    return false;
  }

  // Must not contain colons (reserved for internal routing)
  if (method.includes(':')) {
    return false;
  }

  // Must contain only alphanumeric, dots, underscores, and hyphens
  return /^[a-zA-Z0-9._-]+$/.test(method);
}

/**
 * Error codes
 */
export enum ErrorCode {
  // Protocol errors
  INVALID_MESSAGE = 'INVALID_MESSAGE',
  INVALID_METHOD = 'INVALID_METHOD',
  PROTOCOL_VERSION_MISMATCH = 'PROTOCOL_VERSION_MISMATCH',

  // RPC errors
  METHOD_NOT_FOUND = 'METHOD_NOT_FOUND',
  HANDLER_ERROR = 'HANDLER_ERROR',
  TIMEOUT = 'TIMEOUT',
  INVALID_PARAMS = 'INVALID_PARAMS',

  // Session errors
  INVALID_SESSION = 'INVALID_SESSION',
  SESSION_NOT_FOUND = 'SESSION_NOT_FOUND',

  // Transport errors
  TRANSPORT_ERROR = 'TRANSPORT_ERROR',
  NOT_CONNECTED = 'NOT_CONNECTED',
  MESSAGE_TOO_LARGE = 'MESSAGE_TOO_LARGE',

  // Ingress fan-out guardrail: per-client subscription limit exceeded
  TOO_MANY_SUBSCRIPTIONS = 'TOO_MANY_SUBSCRIPTIONS',

  // General errors
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  UNAUTHORIZED = 'UNAUTHORIZED',
}

/**
 * Error object with code and message
 */
export interface ErrorDetail {
  code: string;
  message: string;
}

/**
 * Parameters for creating an EVENT message
 */
export interface CreateEventMessageParams {
  method: string;
  data: unknown;
  sessionId: string;
  id?: string;
}

/**
 * Parameters for creating a REQUEST message
 */
export interface CreateRequestMessageParams {
  method: string;
  data?: unknown;
  sessionId: string;
  channel?: string;
  id?: string;
}

/**
 * Parameters for creating a RESPONSE message
 */
export interface CreateResponseMessageParams {
  method: string;
  data?: unknown;
  sessionId: string;
  requestId: string;
  channel?: string;
  id?: string;
}

/**
 * Parameters for creating an error RESPONSE message
 */
export interface CreateErrorResponseMessageParams {
  method: string;
  error: string | ErrorDetail;
  sessionId: string;
  requestId: string;
  channel?: string;
  id?: string;
}

/**
 * Create an EVENT message
 */
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

/**
 * Create a REQUEST message
 */
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

/**
 * Create a RESPONSE message (success)
 */
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

/**
 * Create an error RESPONSE message
 */
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

/**
 * Validate message structure
 * Checks all required fields and basic type correctness
 * FIX P2.3: Add protocol version validation
 */
export function isValidMessage(msg: unknown): msg is HubMessage {
  if (!msg || typeof msg !== 'object') {
    return false;
  }

  // Type assertion after basic check - we know it's an object now
  const m = msg as Record<string, unknown>;

  // Check required fields
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

  // FIX P2.3: Validate protocol version if present (warn on mismatch, but don't reject)
  // Note: Accept both undefined and null for optional fields (Zig serializes optionals as null)
  if (m.version !== undefined && m.version !== null) {
    if (typeof m.version !== 'string') {
      return false;
    }

    // Warn if version doesn't match (but allow for backward/forward compatibility)
    if (m.version !== PROTOCOL_VERSION) {
      log.warn(
        `Version mismatch: received ${m.version}, expected ${PROTOCOL_VERSION}. ` +
          `Message will be processed but may have compatibility issues.`
      );
    }
  }

  // Validate method format (except for PING/PONG which don't need method validation)
  if (m.type !== MessageType.PING && m.type !== MessageType.PONG) {
    if (!validateMethod(m.method)) {
      return false;
    }
  }

  // RESPONSE messages must have requestId
  if (m.type === MessageType.RESPONSE && typeof m.requestId !== 'string') {
    return false;
  }

  return true;
}
