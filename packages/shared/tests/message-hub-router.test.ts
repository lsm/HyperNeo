import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createEventMessage, createRequestMessage, MessageType } from '../src/message-hub/protocol';
import { type ClientConnection, MessageHubRouter } from '../src/message-hub/router';
import type { HubMessage } from '../src/message-hub/types';
import { generateUUID } from '../src/utils';

class MockWebSocket {
  public readyState = 1;
  public sentMessages: string[] = [];

  send(data: string): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.readyState = 3;
  }
}

function createMockConnection(ws: MockWebSocket, id?: string): ClientConnection {
  return {
    id: id || generateUUID(),
    send: (data: string) => ws.send(data),
    isOpen: () => ws.readyState === 1,
    metadata: { ws },
  };
}

describe('MessageHubRouter', () => {
  let router: MessageHubRouter;
  let mockWs1: MockWebSocket;
  let mockWs2: MockWebSocket;

  beforeEach(() => {
    router = new MessageHubRouter();
    mockWs1 = new MockWebSocket();
    mockWs2 = new MockWebSocket();
  });

  describe('Client Registration', () => {
    test('should register a client and return clientId', () => {
      const conn1 = createMockConnection(mockWs1);
      const clientId = router.registerConnection(conn1);

      expect(clientId).toBeTruthy();
      expect(router.getClientCount()).toBe(1);
    });

    test('should register multiple clients', () => {
      const conn1 = createMockConnection(mockWs1);
      const conn2 = createMockConnection(mockWs2);
      const clientId1 = router.registerConnection(conn1);
      const clientId2 = router.registerConnection(conn2);

      expect(clientId1).toBeTruthy();
      expect(clientId2).toBeTruthy();
      expect(clientId1).not.toBe(clientId2);
      expect(router.getClientCount()).toBe(2);
    });

    test('should auto-join global room on registration', () => {
      const conn1 = createMockConnection(mockWs1);
      const clientId = router.registerConnection(conn1);

      const roomManager = router.getChannelManager();
      const globalMembers = roomManager.getChannelMembers('global');
      expect(globalMembers).toContain(clientId);
    });

    test('should unregister a client', () => {
      const conn1 = createMockConnection(mockWs1);
      const clientId = router.registerConnection(conn1);
      expect(router.getClientCount()).toBe(1);

      router.unregisterConnection(clientId);
      expect(router.getClientCount()).toBe(0);
    });

    test('should clean up room memberships when client is unregistered', () => {
      const conn1 = createMockConnection(mockWs1);
      const clientId = router.registerConnection(conn1);

      router.joinChannel(clientId, 'session1');
      router.joinChannel(clientId, 'session2');

      const roomManager = router.getChannelManager();
      expect(roomManager.getChannelMembers('session1')).toContain(clientId);
      expect(roomManager.getChannelMembers('session2')).toContain(clientId);

      router.unregisterConnection(clientId);

      expect(roomManager.getChannelMembers('session1')).not.toContain(clientId);
      expect(roomManager.getChannelMembers('session2')).not.toContain(clientId);
    });

    test('should get client info by clientId', () => {
      const conn1 = createMockConnection(mockWs1);
      const clientId = router.registerConnection(conn1);
      const info = router.getClientById(clientId);

      expect(info).toBeDefined();
      expect(info?.clientId).toBe(clientId);
      expect(info?.connection.metadata?.ws).toBe(mockWs1);
    });

    test('should prevent duplicate registration', () => {
      const conn1 = createMockConnection(mockWs1, 'client-123');
      const clientId1 = router.registerConnection(conn1);
      const clientId2 = router.registerConnection(conn1);

      expect(clientId1).toBe(clientId2);
      expect(router.getClientCount()).toBe(1);
    });
  });

  describe('Room Management', () => {
    test('should join client to a room', () => {
      const conn1 = createMockConnection(mockWs1);
      const clientId = router.registerConnection(conn1);

      router.joinChannel(clientId, 'session1');

      const roomManager = router.getChannelManager();
      const members = roomManager.getChannelMembers('session1');
      expect(members).toContain(clientId);
    });

    test('should join client to multiple rooms', () => {
      const conn1 = createMockConnection(mockWs1);
      const clientId = router.registerConnection(conn1);

      router.joinChannel(clientId, 'session1');
      router.joinChannel(clientId, 'session2');
      router.joinChannel(clientId, 'session3');

      const roomManager = router.getChannelManager();
      expect(roomManager.getChannelMembers('session1')).toContain(clientId);
      expect(roomManager.getChannelMembers('session2')).toContain(clientId);
      expect(roomManager.getChannelMembers('session3')).toContain(clientId);
    });

    test('should remove client from a room', () => {
      const conn1 = createMockConnection(mockWs1);
      const clientId = router.registerConnection(conn1);

      router.joinChannel(clientId, 'session1');
      const roomManager = router.getChannelManager();
      expect(roomManager.getChannelMembers('session1')).toContain(clientId);

      router.leaveChannel(clientId, 'session1');
      expect(roomManager.getChannelMembers('session1')).not.toContain(clientId);
    });

    test('should handle joining room for non-existent client', () => {
      expect(() => {
        router.joinChannel('non-existent-id', 'session1');
      }).not.toThrow();
    });

    test('should handle leaving room for non-existent client', () => {
      expect(() => {
        router.leaveChannel('non-existent-id', 'session1');
      }).not.toThrow();
    });
  });

  describe('Event Routing with Rooms', () => {
    test('should route event to all clients in the same room', () => {
      const conn1 = createMockConnection(mockWs1);
      const conn2 = createMockConnection(mockWs2);
      const clientId1 = router.registerConnection(conn1);
      const clientId2 = router.registerConnection(conn2);

      router.joinChannel(clientId1, 'session1');
      router.joinChannel(clientId2, 'session1');

      const eventMessage = createEventMessage({
        method: 'user.created',
        data: { userId: '123' },
        sessionId: 'session1',
      });
      eventMessage.channel = 'session1';

      const result = router.routeEvent(eventMessage);

      expect(mockWs1.sentMessages.length).toBe(1);
      expect(mockWs2.sentMessages.length).toBe(1);
      expect(result.sent).toBe(2);
      expect(result.failed).toBe(0);

      const sentMessage = JSON.parse(mockWs1.sentMessages[0]);
      expect(sentMessage.type).toBe(MessageType.EVENT);
      expect(sentMessage.method).toBe('user.created');
      expect(sentMessage.data).toEqual({ userId: '123' });
    });

    test('should route event to global room by default', () => {
      const conn1 = createMockConnection(mockWs1);
      const conn2 = createMockConnection(mockWs2);
      router.registerConnection(conn1);
      router.registerConnection(conn2);

      const eventMessage = createEventMessage({
        method: 'system.update',
        data: { version: '1.0.0' },
        sessionId: 'global',
      });

      const result = router.routeEvent(eventMessage);

      expect(mockWs1.sentMessages.length).toBe(1);
      expect(mockWs2.sentMessages.length).toBe(1);
      expect(result.sent).toBe(2);
    });

    test('should not route event to clients in different room', () => {
      const conn1 = createMockConnection(mockWs1);
      const conn2 = createMockConnection(mockWs2);
      const clientId1 = router.registerConnection(conn1);
      const clientId2 = router.registerConnection(conn2);

      router.joinChannel(clientId1, 'session1');
      router.joinChannel(clientId2, 'session2');

      const eventMessage = createEventMessage({
        method: 'user.created',
        data: { userId: '123' },
        sessionId: 'session1',
      });
      eventMessage.channel = 'session1';

      router.routeEvent(eventMessage);

      expect(mockWs1.sentMessages.length).toBe(1);
      expect(mockWs2.sentMessages.length).toBe(0);
    });

    test('should skip clients with closed connections', () => {
      const conn1 = createMockConnection(mockWs1);
      const clientId = router.registerConnection(conn1);

      router.joinChannel(clientId, 'session1');
      mockWs1.close();

      const eventMessage = createEventMessage({
        method: 'user.created',
        data: { userId: '123' },
        sessionId: 'session1',
      });
      eventMessage.channel = 'session1';

      const result = router.routeEvent(eventMessage);

      expect(mockWs1.sentMessages.length).toBe(0);
      expect(result.sent).toBe(0);
      expect(result.failed).toBe(1);
    });

    test('should return zero stats for room with no members', () => {
      const eventMessage = createEventMessage({
        method: 'unsubscribed.event',
        data: {},
        sessionId: 'session1',
      });
      eventMessage.channel = 'empty-room';

      const result = router.routeEvent(eventMessage);

      expect(result.sent).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.totalSubscribers).toBe(0);
    });
  });

  describe('routeEventToChannel', () => {
    test('should route event explicitly to room', () => {
      const conn1 = createMockConnection(mockWs1);
      const conn2 = createMockConnection(mockWs2);
      const clientId1 = router.registerConnection(conn1);
      const clientId2 = router.registerConnection(conn2);

      router.joinChannel(clientId1, 'session1');
      router.joinChannel(clientId2, 'session1');

      const eventMessage = createEventMessage({
        method: 'chat.message',
        data: { text: 'Hello' },
        sessionId: 'session1',
      });
      eventMessage.channel = 'session1';

      const result = router.routeEventToChannel(eventMessage);

      expect(result.sent).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.totalSubscribers).toBe(2);
      expect(result.sessionId).toBe('session1');
      expect(result.method).toBe('chat.message');
    });

    test('should return delivery statistics from routeEventToChannel', () => {
      const conn1 = createMockConnection(mockWs1);
      const conn2 = createMockConnection(mockWs2);
      const mockWs3 = new MockWebSocket();
      const conn3 = createMockConnection(mockWs3);
      const clientId1 = router.registerConnection(conn1);
      const clientId2 = router.registerConnection(conn2);
      const clientId3 = router.registerConnection(conn3);

      router.joinChannel(clientId1, 'session1');
      router.joinChannel(clientId2, 'session1');
      router.joinChannel(clientId3, 'session1');

      mockWs3.close();

      const eventMessage = createEventMessage({
        method: 'user.created',
        data: { userId: '123' },
        sessionId: 'session1',
      });
      eventMessage.channel = 'session1';

      const result = router.routeEventToChannel(eventMessage);

      expect(result.sent).toBe(2);
      expect(result.failed).toBe(1);
      expect(result.totalSubscribers).toBe(3);
      expect(result.sessionId).toBe('session1');
      expect(result.method).toBe('user.created');
    });
  });

  describe('Direct Messaging', () => {
    test('should send message to specific client', () => {
      const conn1 = createMockConnection(mockWs1);
      const clientId = router.registerConnection(conn1);

      const message: HubMessage = {
        id: 'msg1',
        type: MessageType.EVENT,
        method: 'test.event',
        sessionId: 'session1',
        data: { test: true },
        timestamp: new Date().toISOString(),
      };

      const success = router.sendToClient(clientId, message);

      expect(success).toBe(true);
      expect(mockWs1.sentMessages.length).toBe(1);

      const sentMessage = JSON.parse(mockWs1.sentMessages[0]);
      expect(sentMessage.method).toBe('test.event');
    });

    test('refuses oversized messages before writing to the connection', () => {
      router = new MessageHubRouter({ maxMessageSize: 512 });
      const conn1 = createMockConnection(mockWs1);
      const clientId = router.registerConnection(conn1);
      const message = createRequestMessage({
        method: 'test.request',
        data: { content: 'x'.repeat(512) },
        sessionId: 'session1',
      });

      expect(router.sendToClientDetailed(clientId, message)).toEqual({
        ok: false,
        reason: 'message_too_large',
      });
      expect(mockWs1.sentMessages).toHaveLength(0);
    });

    test('should return false when sending to non-existent client', () => {
      const message: HubMessage = {
        id: 'msg1',
        type: MessageType.EVENT,
        method: 'test.event',
        sessionId: 'session1',
        data: {},
        timestamp: new Date().toISOString(),
      };

      const success = router.sendToClient('non-existent-id', message);

      expect(success).toBe(false);
      expect(mockWs1.sentMessages.length).toBe(0);
    });

    test('should return false when sending to closed connection', () => {
      const conn1 = createMockConnection(mockWs1);
      const clientId = router.registerConnection(conn1);
      mockWs1.close();

      const message: HubMessage = {
        id: 'msg1',
        type: MessageType.EVENT,
        method: 'test.event',
        sessionId: 'session1',
        data: {},
        timestamp: new Date().toISOString(),
      };

      const success = router.sendToClient(clientId, message);

      expect(success).toBe(false);
    });

    test('should broadcast to all clients', () => {
      const conn1 = createMockConnection(mockWs1);
      const conn2 = createMockConnection(mockWs2);
      router.registerConnection(conn1);
      router.registerConnection(conn2);

      const message: HubMessage = {
        id: 'msg1',
        type: MessageType.EVENT,
        method: 'broadcast.event',
        sessionId: 'global',
        data: { test: true },
        timestamp: new Date().toISOString(),
      };

      const result = router.broadcast(message);

      expect(result.sent).toBe(2);
      expect(result.failed).toBe(0);
      expect(mockWs1.sentMessages.length).toBe(1);
      expect(mockWs2.sentMessages.length).toBe(1);
    });

    test('broadcast should return delivery statistics', () => {
      const conn1 = createMockConnection(mockWs1);
      const conn2 = createMockConnection(mockWs2);
      const mockWs3 = new MockWebSocket();
      mockWs3.close();
      const conn3 = createMockConnection(mockWs3);
      router.registerConnection(conn1);
      router.registerConnection(conn2);
      router.registerConnection(conn3);

      const message: HubMessage = {
        id: 'msg1',
        type: MessageType.EVENT,
        method: 'broadcast.event',
        sessionId: 'global',
        data: {},
        timestamp: new Date().toISOString(),
      };

      const result = router.broadcast(message);

      expect(result.sent).toBe(2);
      expect(result.failed).toBe(1);
    });
  });

  describe('Error Handling', () => {
    test('should handle routing non-EVENT message gracefully', () => {
      const commandMessage = createRequestMessage({
        method: 'user.created',
        data: {},
        sessionId: 'session1',
      });

      const result = router.routeEvent(commandMessage);

      expect(result.sent).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.totalSubscribers).toBe(0);
    });

    test('should handle sending to closed WebSocket gracefully', () => {
      const conn1 = createMockConnection(mockWs1);
      const clientId = router.registerConnection(conn1);
      mockWs1.close();

      const message: HubMessage = {
        id: 'msg1',
        type: MessageType.EVENT,
        method: 'test.event',
        sessionId: 'session1',
        data: {},
        timestamp: new Date().toISOString(),
      };

      expect(() => {
        router.sendToClient(clientId, message);
      }).not.toThrow();
    });

    test('should handle circular references by converting to [Circular]', () => {
      const conn1 = createMockConnection(mockWs1);
      const clientId = router.registerConnection(conn1);

      const circular: { data: unknown } = { data: {} };
      circular.data = circular;

      const message: HubMessage = {
        id: 'msg1',
        type: MessageType.EVENT,
        method: 'test.event',
        sessionId: 'session1',
        data: circular,
        timestamp: new Date().toISOString(),
      };

      const success = router.sendToClient(clientId, message);

      expect(success).toBe(true);
    });

    test('should handle broadcast circular references by converting to [Circular]', () => {
      const conn1 = createMockConnection(mockWs1);
      const conn2 = createMockConnection(mockWs2);
      router.registerConnection(conn1);
      router.registerConnection(conn2);

      const circular: { data: unknown } = { data: {} };
      circular.data = circular;

      const message: HubMessage = {
        id: 'msg1',
        type: MessageType.EVENT,
        method: 'broadcast.event',
        sessionId: 'global',
        data: circular,
        timestamp: new Date().toISOString(),
      };

      const result = router.broadcast(message);

      expect(result.sent).toBe(2);
      expect(result.failed).toBe(0);
    });
  });

  describe('Client Lookup', () => {
    test('should get client by clientId efficiently', () => {
      const conn1 = createMockConnection(mockWs1);
      const clientId = router.registerConnection(conn1);
      const client = router.getClientById(clientId);

      expect(client).toBeDefined();
      expect(client?.clientId).toBe(clientId);
      expect(client?.connection.metadata?.ws).toBe(mockWs1);
    });

    test('should return undefined for non-existent clientId', () => {
      const client = router.getClientById('non-existent');
      expect(client).toBeUndefined();
    });

    test('should get all connected client IDs', () => {
      const conn1 = createMockConnection(mockWs1);
      const conn2 = createMockConnection(mockWs2);
      const clientId1 = router.registerConnection(conn1);
      const clientId2 = router.registerConnection(conn2);

      const clientIds = router.getClientIds();
      expect(clientIds).toContain(clientId1);
      expect(clientIds).toContain(clientId2);
      expect(clientIds.length).toBe(2);
    });

    test('should return empty array when no clients', () => {
      const clientIds = router.getClientIds();
      expect(clientIds.length).toBe(0);
    });
  });

  describe('Custom Logger', () => {
    test('should use custom logger for errors only', () => {
      const mockLogger = {
        log: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      };

      const customRouter = new MessageHubRouter({
        logger: mockLogger,
        debug: true,
      });

      const conn1 = createMockConnection(mockWs1);
      customRouter.registerConnection(conn1);

      expect(mockLogger.log).not.toHaveBeenCalled();
    });

    test('should not log when debug is false', () => {
      const mockLogger = {
        log: mock(() => {}),
        warn: mock(() => {}),
        error: mock(() => {}),
      };

      const customRouter = new MessageHubRouter({
        logger: mockLogger,
        debug: false,
      });

      const conn1 = createMockConnection(mockWs1);
      customRouter.registerConnection(conn1);

      expect(mockLogger.log).toHaveBeenCalledTimes(0);
    });
  });

  describe('RoomManager Integration', () => {
    test('should access room manager', () => {
      const roomManager = router.getChannelManager();
      expect(roomManager).toBeDefined();
    });

    test('should track room members through room manager', () => {
      const conn1 = createMockConnection(mockWs1);
      const conn2 = createMockConnection(mockWs2);
      const clientId1 = router.registerConnection(conn1);
      const clientId2 = router.registerConnection(conn2);

      router.joinChannel(clientId1, 'session1');
      router.joinChannel(clientId2, 'session1');

      const roomManager = router.getChannelManager();
      const members = roomManager.getChannelMembers('session1');

      expect(members.size).toBe(2);
      expect(members).toContain(clientId1);
      expect(members).toContain(clientId2);
    });

    test('should clean up empty rooms', () => {
      const conn1 = createMockConnection(mockWs1);
      const clientId = router.registerConnection(conn1);

      router.joinChannel(clientId, 'temp-room');

      const roomManager = router.getChannelManager();
      expect(roomManager.getChannelMembers('temp-room')).toContain(clientId);

      router.leaveChannel(clientId, 'temp-room');

      expect(roomManager.getChannelMembers('temp-room').size).toBe(0);
    });
  });

  describe('Backpressure Handling', () => {
    test('should skip clients that cannot accept messages', () => {
      const mockWs3 = new MockWebSocket();
      const conn1 = createMockConnection(mockWs1);
      const conn2 = createMockConnection(mockWs2);
      const conn3: ClientConnection = {
        ...createMockConnection(mockWs3),
        canAccept: () => false,
      };

      router.registerConnection(conn1);
      router.registerConnection(conn2);
      router.registerConnection(conn3);

      const message: HubMessage = {
        id: 'msg1',
        type: MessageType.EVENT,
        method: 'broadcast.event',
        sessionId: 'global',
        data: {},
        timestamp: new Date().toISOString(),
      };

      const result = router.broadcast(message);

      expect(result.sent).toBe(2);
      expect(result.skipped).toBe(1);
      expect(result.failed).toBe(0);
    });
  });
});
