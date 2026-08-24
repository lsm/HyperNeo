import type { RuntimeSocket } from '../lib/runtime-server/index.ts';
import {
  createEventMessage,
  createErrorResponseMessage,
  MessageType,
  generateUUID,
} from '@hyperneo/shared';
import { DEFAULT_MAX_OUTBOUND_MESSAGE_SIZE } from '@hyperneo/shared/message-hub/router';
import type { HubMessage } from '@hyperneo/shared/message-hub/protocol';
import type { WebSocketServerTransport } from '../lib/websocket-server-transport.ts';
import type { SessionManager } from '../lib/session-manager.ts';

const GLOBAL_SESSION_ID = 'global';

const MAX_MESSAGE_SIZE = 32 * 1024 * 1024;
const MAX_MESSAGE_SIZE_MB = MAX_MESSAGE_SIZE / (1024 * 1024);

interface WebSocketData {
  connectionSessionId: string;
  clientId?: string;
  joinedChannels?: Set<string>;
}

function sendCapped(ws: RuntimeSocket<WebSocketData>, message: HubMessage): void {
  const json = JSON.stringify(message);
  if (new Blob([json]).size <= DEFAULT_MAX_OUTBOUND_MESSAGE_SIZE) {
    ws.send(json);
    return;
  }

  const fallback = createErrorResponseMessage({
    method: message.method,
    error: {
      code: 'MESSAGE_TOO_LARGE',
      message: 'Response is too large to send',
    },
    sessionId: GLOBAL_SESSION_ID,
    requestId: message.requestId ?? message.id,
  });
  ws.send(JSON.stringify(fallback));
}

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
      const clientId = transport.registerClient(ws, GLOBAL_SESSION_ID);

      ws.data.clientId = clientId;

      const connectionEvent = createEventMessage({
        method: 'connection.established',
        sessionId: GLOBAL_SESSION_ID,
        data: {
          message: 'WebSocket connection established',
          protocol: 'MessageHub',
          version: '1.0.0',
        },
      });
      sendCapped(ws, connectionEvent);
    },

    async message(ws: RuntimeSocket<WebSocketData>, message: string | Buffer) {
      try {
        const messageStr = typeof message === 'string' ? message : message.toString();
        const messageSize = new TextEncoder().encode(messageStr).length;

        if (messageSize > MAX_MESSAGE_SIZE) {
          const errorMsg = createErrorResponseMessage({
            method: 'message.process',
            error: {
              code: 'MESSAGE_TOO_LARGE',
              message: `Message size ${(messageSize / (1024 * 1024)).toFixed(2)}MB exceeds maximum ${MAX_MESSAGE_SIZE_MB}MB`,
            },
            sessionId: GLOBAL_SESSION_ID,
            requestId: '',
          });
          sendCapped(ws, errorMsg);
          return;
        }

        const data: ParsedWebSocketMessage = JSON.parse(messageStr);

        if (data.type === 'ping' || data.type === 'PING') {
          const clientId = ws.data.clientId;
          if (clientId) {
            transport.updateClientActivity(clientId);

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
          sendCapped(ws, pongMsg);
          return;
        }

        const clientId = ws.data.clientId;

        if (!data.sessionId) {
          data.sessionId = GLOBAL_SESSION_ID;
        }

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
            sendCapped(ws, errorMsg);
            return;
          }
        }

        if (clientId) {
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
        const errorMsg = createErrorResponseMessage({
          method: 'message.process',
          error: {
            code: 'INVALID_MESSAGE',
            message: error instanceof Error ? error.message : 'Invalid message format',
          },
          sessionId: GLOBAL_SESSION_ID,
          requestId: '',
        });
        sendCapped(ws, errorMsg);
      }
    },

    close(ws: RuntimeSocket<WebSocketData>) {
      const clientId = ws.data.clientId;
      if (clientId) {
        transport.unregisterClient(clientId);
      }
    },

    error(ws: RuntimeSocket<WebSocketData>, _error: Error) {
      const clientId = ws.data.clientId;
      if (clientId) {
        transport.unregisterClient(clientId);
      }
    },
  };
}
