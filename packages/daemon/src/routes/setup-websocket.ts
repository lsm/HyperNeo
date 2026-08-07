/**
 * MessageHub WebSocket Handlers using Bun Native WebSocket
 *
 * UNIFIED WebSocket endpoint - all messages routed by sessionId field
 * Following MessageHub architectural principle: "sessionId in message, not URL"
 */

import type { RuntimeSocket } from '../lib/runtime-server';
import {
  createEventMessage,
  createErrorResponseMessage,
  MessageType,
  generateUUID,
} from '@hyperneo/shared';
import type { HubMessage } from '@hyperneo/shared/message-hub/protocol';
import type { WebSocketServerTransport } from '../lib/websocket-server-transport';
import type { SessionManager } from '../lib/session-manager';

const GLOBAL_SESSION_ID = 'global';

// FIX P1.1: Message size validation constants (DoS prevention)
// Note: Increased from 10MB to 50MB to support large session state snapshots
// with long conversation histories
const MAX_MESSAGE_SIZE = 50 * 1024 * 1024; // 50MB max message size
const MAX_MESSAGE_SIZE_MB = MAX_MESSAGE_SIZE / (1024 * 1024);

/**
 * WebSocket data stored on each connection
 */
interface WebSocketData {
  connectionSessionId: string;
  clientId?: string;
  // FIX P2: Track channels client has joined for self-healing
  joinedChannels?: Set<string>;
}

/**
 * Parsed WebSocket message with sessionId for routing
 */
interface ParsedWebSocketMessage {
  id?: string;
  type: string;
  method?: string;
  sessionId: string;
  timestamp?: string;
  data?: unknown;
  [key: string]: unknown;
}

export function createWebSocketHandlers(
  transport: WebSocketServerTransport,
  sessionManager: SessionManager
) {
  return {
    open(ws: RuntimeSocket<WebSocketData>) {
      // Register client with transport (starts in global session)
      const clientId = transport.registerClient(ws, GLOBAL_SESSION_ID);

      // Store clientId on websocket data for cleanup and message handling
      ws.data.clientId = clientId;

      // NOTE: Clients receive events automatically through the MessageHub protocol.
      // No explicit subscription mechanism needed.

      // Send connection confirmation as a proper EVENT message
      const connectionEvent = createEventMessage({
        method: 'connection.established',
        sessionId: GLOBAL_SESSION_ID,
        data: {
          message: 'WebSocket connection established',
          protocol: 'MessageHub',
          version: '1.0.0',
        },
      });
      ws.send(JSON.stringify(connectionEvent));
    },

    async message(ws: RuntimeSocket<WebSocketData>, message: string | Buffer) {
      try {
        // FIX P1.1: Validate message size before parsing (DoS prevention)
        const messageStr = typeof message === 'string' ? message : message.toString();
        const messageSize = new TextEncoder().encode(messageStr).length;

        if (messageSize > MAX_MESSAGE_SIZE) {
          // Message size limit exceeded - send error response
          const errorMsg = createErrorResponseMessage({
            method: 'message.process',
            error: {
              code: 'MESSAGE_TOO_LARGE',
              message: `Message size ${(messageSize / (1024 * 1024)).toFixed(2)}MB exceeds maximum ${MAX_MESSAGE_SIZE_MB}MB`,
            },
            sessionId: GLOBAL_SESSION_ID,
            requestId: '',
          });
          ws.send(JSON.stringify(errorMsg));
          return;
        }

        const data: ParsedWebSocketMessage = JSON.parse(messageStr);

        // Handle ping/pong
        if (data.type === 'ping' || data.type === 'PING') {
          // Update client activity time for stale connection detection
          const clientId = ws.data.clientId;
          if (clientId) {
            transport.updateClientActivity(clientId);

            // FIX P2: Self-healing - re-verify channel membership on PING
            // This ensures clients are re-added to channels if they were removed by stale cleanup
            const expectedChannels: string[] = ws.data.joinedChannels
              ? ['global', ...Array.from<string>(ws.data.joinedChannels)]
              : ['global'];
            transport.verifyChannelMembership(clientId, expectedChannels);
          }

          const pongMsg = {
            id: generateUUID(),
            type: MessageType.PONG,
            sessionId: data.sessionId || GLOBAL_SESSION_ID,
            method: 'heartbeat',
            timestamp: new Date().toISOString(),
            requestId: data.id,
          };
          ws.send(JSON.stringify(pongMsg));
          return;
        }

        // Get client ID for subscription tracking
        const clientId = ws.data.clientId;

        // Validate sessionId exists in message
        if (!data.sessionId) {
          data.sessionId = GLOBAL_SESSION_ID;
        }

        // For session-specific messages, verify session exists (except for global)
        if (data.sessionId !== GLOBAL_SESSION_ID) {
          const session = await sessionManager.getSessionAsync(data.sessionId);
          if (!session) {
            const errorMsg = createErrorResponseMessage({
              method: data.method || 'unknown.method',
              error: {
                code: 'SESSION_NOT_FOUND',
                message: `Session not found: ${data.sessionId}`,
              },
              sessionId: data.sessionId,
              requestId: data.id || '',
            });
            ws.send(JSON.stringify(errorMsg));
            return;
          }
        }

        // Pass to transport which will notify MessageHub
        // Message routing is handled by sessionId field, not connection
        // Cast to HubMessage - the parsed JSON has the same structure
        if (clientId) {
          // FIX P2: Track channel joins/leaves for self-healing on PING
          if (
            data.method === 'channel.join' &&
            data.data &&
            typeof (data.data as Record<string, unknown>).channel === 'string'
          ) {
            const channel = (data.data as Record<string, unknown>).channel as string;
            if (!ws.data.joinedChannels) {
              ws.data.joinedChannels = new Set();
            }
            ws.data.joinedChannels.add(channel);
          } else if (
            data.method === 'channel.leave' &&
            data.data &&
            typeof (data.data as Record<string, unknown>).channel === 'string'
          ) {
            const channel = (data.data as Record<string, unknown>).channel as string;
            if (ws.data.joinedChannels) {
              ws.data.joinedChannels.delete(channel);
            }
          }

          transport.handleClientMessage(data as unknown as HubMessage, clientId);
        }
      } catch (error) {
        // Error processing message - send error response
        const errorMsg = createErrorResponseMessage({
          method: 'message.process',
          error: {
            code: 'INVALID_MESSAGE',
            message: error instanceof Error ? error.message : 'Invalid message format',
          },
          sessionId: GLOBAL_SESSION_ID,
          requestId: '',
        });
        ws.send(JSON.stringify(errorMsg));
      }
    },

    close(ws: RuntimeSocket<WebSocketData>) {
      const clientId = ws.data.clientId;
      if (clientId) {
        transport.unregisterClient(clientId);
      }
    },

    error(ws: RuntimeSocket<WebSocketData>, _error: Error) {
      // WebSocket error - unregister client
      const clientId = ws.data.clientId;
      if (clientId) {
        transport.unregisterClient(clientId);
      }
    },
  };
}
