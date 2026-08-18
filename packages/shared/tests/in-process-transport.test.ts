import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { MessageHub } from '../src/message-hub/message-hub.ts';
import {
  InProcessTransport,
  InProcessTransportBus,
} from '../src/message-hub/in-process-transport.ts';
import { MessageType, type HubMessage } from '../src/message-hub/protocol.ts';

describe('InProcessTransport', () => {
  describe('createPair', () => {
    it('should create a connected pair of transports', async () => {
      const [client, server] = InProcessTransport.createPair();

      await client.initialize();
      await server.initialize();

      expect(client.isReady()).toBe(true);
      expect(server.isReady()).toBe(true);
      expect(client.getState()).toBe('connected');
      expect(server.getState()).toBe('connected');
    });

    it('should deliver messages from client to server', async () => {
      const [client, server] = InProcessTransport.createPair();
      await client.initialize();

      const receivedMessages: HubMessage[] = [];
      server.onMessage((msg) => receivedMessages.push(msg));

      const testMessage: HubMessage = {
        id: 'test-1',
        type: MessageType.REQUEST,
        method: 'test.method',
        sessionId: 'global',
        timestamp: new Date().toISOString(),
        data: { foo: 'bar' },
      };

      await client.send(testMessage);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedMessages.length).toBe(1);
      expect(receivedMessages[0].id).toBe('test-1');
      expect(receivedMessages[0].data).toEqual({ foo: 'bar' });
    });

    it('should deliver messages from server to client', async () => {
      const [client, server] = InProcessTransport.createPair();
      await client.initialize();

      const receivedMessages: HubMessage[] = [];
      client.onMessage((msg) => receivedMessages.push(msg));

      const testMessage: HubMessage = {
        id: 'test-2',
        type: MessageType.EVENT,
        method: 'test.event',
        sessionId: 'session-123',
        timestamp: new Date().toISOString(),
        data: { hello: 'world' },
      };

      await server.send(testMessage);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedMessages.length).toBe(1);
      expect(receivedMessages[0].method).toBe('test.event');
    });

    it('should support bidirectional communication', async () => {
      const [client, server] = InProcessTransport.createPair();
      await client.initialize();

      const clientReceived: HubMessage[] = [];
      const serverReceived: HubMessage[] = [];

      client.onMessage((msg) => clientReceived.push(msg));
      server.onMessage((msg) => serverReceived.push(msg));

      await client.send({
        id: 'c2s',
        type: MessageType.REQUEST,
        method: 'client.to.server',
        sessionId: 'global',
        timestamp: new Date().toISOString(),
      });

      await server.send({
        id: 's2c',
        type: MessageType.EVENT,
        method: 'server.to.client',
        sessionId: 'global',
        timestamp: new Date().toISOString(),
      });

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(serverReceived.length).toBe(1);
      expect(serverReceived[0].id).toBe('c2s');
      expect(clientReceived.length).toBe(1);
      expect(clientReceived[0].id).toBe('s2c');
    });

    it('should handle close and notify peer', async () => {
      const [client, server] = InProcessTransport.createPair();
      await client.initialize();

      let disconnectedClientId = '';
      server.onClientDisconnect((clientId) => {
        disconnectedClientId = clientId;
      });

      await client.close();

      expect(client.isReady()).toBe(false);
      expect(client.getState()).toBe('disconnected');
      expect(disconnectedClientId).toBe(client.getClientId());
    });

    it('should notify connection state handlers', async () => {
      const [client, _server] = InProcessTransport.createPair();

      const clientStates: string[] = [];
      client.onConnectionChange((state) => clientStates.push(state));

      await client.initialize();
      await client.close();

      expect(clientStates).toContain('connected');
      expect(clientStates).toContain('disconnected');
    });
  });

  describe('cloneMessages option', () => {
    it('should pass messages by reference when cloneMessages=false', async () => {
      const [client, server] = InProcessTransport.createPair({
        cloneMessages: false,
      });
      await client.initialize();

      let receivedMsg: HubMessage | null = null;
      server.onMessage((msg) => {
        receivedMsg = msg;
      });

      const sentData = { mutable: true };
      const testMessage: HubMessage = {
        id: 'ref-test',
        type: MessageType.REQUEST,
        method: 'test.ref',
        sessionId: 'global',
        timestamp: new Date().toISOString(),
        data: sentData,
      };

      await client.send(testMessage);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedMsg!.data).toBe(sentData);
    });

    it('should clone messages when cloneMessages=true', async () => {
      const [client, server] = InProcessTransport.createPair({
        cloneMessages: true,
      });
      await client.initialize();

      let receivedMsg: HubMessage | null = null;
      server.onMessage((msg) => {
        receivedMsg = msg;
      });

      const sentData = { mutable: true };
      const testMessage: HubMessage = {
        id: 'clone-test',
        type: MessageType.REQUEST,
        method: 'test.clone',
        sessionId: 'global',
        timestamp: new Date().toISOString(),
        data: sentData,
      };

      await client.send(testMessage);
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedMsg!.data).not.toBe(sentData);
      expect(receivedMsg!.data).toEqual(sentData);
    });
  });

  describe('simulatedLatency option', () => {
    it('should delay message delivery when latency is set', async () => {
      const latencyMs = 50;
      const [client, server] = InProcessTransport.createPair({
        simulatedLatency: latencyMs,
      });
      await client.initialize();

      let receivedAt = 0;
      server.onMessage(() => {
        receivedAt = Date.now();
      });

      const sentAt = Date.now();
      await client.send({
        id: 'latency-test',
        type: MessageType.REQUEST,
        method: 'test.latency',
        sessionId: 'global',
        timestamp: new Date().toISOString(),
      });

      await new Promise((resolve) => setTimeout(resolve, latencyMs + 20));

      const actualLatency = receivedAt - sentAt;
      expect(actualLatency).toBeGreaterThanOrEqual(latencyMs - 5);
    });
  });

  describe('error handling', () => {
    it('should throw when sending on uninitialized transport', async () => {
      const transport = new InProcessTransport();

      await expect(
        transport.send({
          id: 'error-test',
          type: MessageType.REQUEST,
          method: 'test.error',
          sessionId: 'global',
          timestamp: new Date().toISOString(),
        })
      ).rejects.toThrow('not connected');
    });

    it('should throw when initializing unpaired transport', async () => {
      const transport = new InProcessTransport();
      await expect(transport.initialize()).rejects.toThrow('not paired');
    });

    it('should handle message handler errors gracefully', async () => {
      const [client, server] = InProcessTransport.createPair();
      await client.initialize();

      let handlerCalled = false;
      server.onMessage(() => {
        handlerCalled = true;
        throw new Error('Handler error');
      });

      const testMessage: HubMessage = {
        id: 'error-handler-test',
        type: MessageType.EVENT,
        method: 'test',
        sessionId: 'global',
        timestamp: new Date().toISOString(),
        data: {},
      };

      await client.send(testMessage);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(handlerCalled).toBe(true);
    });

    it('should handle connection handler errors gracefully', async () => {
      const [client, _server] = InProcessTransport.createPair();

      let errorThrown = false;
      client.onConnectionChange(() => {
        errorThrown = true;
        throw new Error('Connection handler error');
      });

      await client.initialize();
      expect(client.getState()).toBe('connected');
      expect(errorThrown).toBe(true);
    });
  });

  describe('sendToClient', () => {
    it('should send message to specific client by ID', async () => {
      const [client, server] = InProcessTransport.createPair();
      await client.initialize();

      const receivedMessages: HubMessage[] = [];
      client.onMessage((msg) => receivedMessages.push(msg));

      const testMessage: HubMessage = {
        id: 'send-to-client-test',
        type: MessageType.EVENT,
        method: 'test.event',
        sessionId: 'global',
        timestamp: new Date().toISOString(),
        data: { direct: true },
      };

      const clientId = client.getClientId();
      const success = await server.sendToClient(clientId, testMessage);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(success).toBe(true);
      expect(receivedMessages.length).toBe(1);
      expect(receivedMessages[0].data).toEqual({ direct: true });
    });

    it('should return false for non-existent client', async () => {
      const [client, server] = InProcessTransport.createPair();
      await client.initialize();

      const testMessage: HubMessage = {
        id: 'non-existent-test',
        type: MessageType.EVENT,
        method: 'test',
        sessionId: 'global',
        timestamp: new Date().toISOString(),
        data: {},
      };

      const success = await server.sendToClient('non-existent-client-id', testMessage);
      expect(success).toBe(false);
    });

    it('should return false for client that is not ready', async () => {
      const [client, server] = InProcessTransport.createPair();

      const testMessage: HubMessage = {
        id: 'not-ready-test',
        type: MessageType.EVENT,
        method: 'test',
        sessionId: 'global',
        timestamp: new Date().toISOString(),
        data: {},
      };

      const clientId = client.getClientId();
      const success = await server.sendToClient(clientId, testMessage);
      expect(success).toBe(false);
    });
  });

  describe('broadcastToClients', () => {
    it('should broadcast to multiple clients', async () => {
      const server = new InProcessTransport({ name: 'server' });
      const client1 = new InProcessTransport({ name: 'client1' });
      const client2 = new InProcessTransport({ name: 'client2' });
      const client3 = new InProcessTransport({ name: 'client3' });

      client1['peer'] = server;
      client2['peer'] = server;
      client3['peer'] = server;
      server['peer'] = client1;

      await client1.initialize();
      await client2.initialize();
      await client3.initialize();

      server['connectedClients'].set(client1.getClientId(), client1);
      server['connectedClients'].set(client2.getClientId(), client2);
      server['connectedClients'].set(client3.getClientId(), client3);

      const received1: HubMessage[] = [];
      const received2: HubMessage[] = [];
      const received3: HubMessage[] = [];

      client1.onMessage((msg) => received1.push(msg));
      client2.onMessage((msg) => received2.push(msg));
      client3.onMessage((msg) => received3.push(msg));

      const clientIds = [client1.getClientId(), client2.getClientId(), client3.getClientId()];

      const testMessage: HubMessage = {
        id: 'broadcast-test',
        type: MessageType.EVENT,
        method: 'test.broadcast',
        sessionId: 'global',
        timestamp: new Date().toISOString(),
        data: { broadcast: true },
      };

      const result = await server.broadcastToClients(clientIds, testMessage);

      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(result.sent).toBe(3);
      expect(result.failed).toBe(0);
      expect(result.totalTargets).toBe(3);

      expect(received1.length).toBe(1);
      expect(received2.length).toBe(1);
      expect(received3.length).toBe(1);
    });

    it('should handle partial failures in broadcast', async () => {
      const server = new InProcessTransport({ name: 'server' });
      const client1 = new InProcessTransport({ name: 'client1' });
      const client2 = new InProcessTransport({ name: 'client2' });

      client1['peer'] = server;
      client2['peer'] = server;
      server['peer'] = client1;

      await client1.initialize();

      server['connectedClients'].set(client1.getClientId(), client1);
      server['connectedClients'].set(client2.getClientId(), client2);

      const clientIds = [client1.getClientId(), client2.getClientId(), 'non-existent'];

      const testMessage: HubMessage = {
        id: 'partial-fail-test',
        type: MessageType.EVENT,
        method: 'test',
        sessionId: 'global',
        timestamp: new Date().toISOString(),
        data: {},
      };

      const result = await server.broadcastToClients(clientIds, testMessage);

      expect(result.sent).toBe(1);
      expect(result.failed).toBe(2);
      expect(result.totalTargets).toBe(3);
    });

    it('should handle empty client list', async () => {
      const [client, server] = InProcessTransport.createPair();
      await client.initialize();

      const testMessage: HubMessage = {
        id: 'empty-list-test',
        type: MessageType.EVENT,
        method: 'test',
        sessionId: 'global',
        timestamp: new Date().toISOString(),
        data: {},
      };

      const result = await server.broadcastToClients([], testMessage);

      expect(result.sent).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.totalTargets).toBe(0);
    });
  });

  describe('getClientId and getClientCount', () => {
    it('should return unique client IDs', () => {
      const t1 = new InProcessTransport();
      const t2 = new InProcessTransport();

      expect(t1.getClientId()).not.toBe(t2.getClientId());
      expect(t1.getClientId()).toMatch(/^[0-9a-f-]+$/);
    });

    it('should track connected client count', async () => {
      const [client, server] = InProcessTransport.createPair();
      await client.initialize();

      expect(server.getClientCount()).toBe(1);
    });
  });

  describe('onClientDisconnect unsubscribe', () => {
    it('should allow unsubscribing from disconnect events', async () => {
      const [client, server] = InProcessTransport.createPair();
      await client.initialize();

      let callCount = 0;

      const unsubscribe = server.onClientDisconnect(() => {
        callCount++;
      });

      await client.close();
      expect(callCount).toBe(1);

      const [client2] = InProcessTransport.createPair();
      await client2.initialize();

      unsubscribe();

      await client2.close();
      expect(callCount).toBe(1);
    });

    it('should handle multiple disconnect handlers', async () => {
      const [client, server] = InProcessTransport.createPair();
      await client.initialize();

      let handler1Called = false;
      let handler2Called = false;

      server.onClientDisconnect(() => {
        handler1Called = true;
      });

      server.onClientDisconnect(() => {
        handler2Called = true;
      });

      await client.close();

      expect(handler1Called).toBe(true);
      expect(handler2Called).toBe(true);
    });
  });
});

describe('InProcessTransportBus', () => {
  let bus: InProcessTransportBus;

  beforeEach(() => {
    bus = new InProcessTransportBus();
  });

  afterEach(async () => {
    await bus.close();
  });

  it('should create named transports', async () => {
    const t1 = bus.createTransport('component-1');
    const t2 = bus.createTransport('component-2');

    await t1.initialize();
    await t2.initialize();

    expect(t1.name).toBe('component-1');
    expect(t2.name).toBe('component-2');
    expect(bus.getTransportNames()).toContain('component-1');
    expect(bus.getTransportNames()).toContain('component-2');
  });

  it('should throw on duplicate transport names', () => {
    bus.createTransport('unique-name');
    expect(() => bus.createTransport('unique-name')).toThrow('already exists');
  });

  it('should broadcast messages to all other transports', async () => {
    const t1 = bus.createTransport('sender');
    const t2 = bus.createTransport('receiver-1');
    const t3 = bus.createTransport('receiver-2');

    await t1.initialize();
    await t2.initialize();
    await t3.initialize();

    const t2Received: HubMessage[] = [];
    const t3Received: HubMessage[] = [];

    t2.onMessage((msg) => t2Received.push(msg));
    t3.onMessage((msg) => t3Received.push(msg));

    await t1.send({
      id: 'broadcast-test',
      type: MessageType.EVENT,
      method: 'test.broadcast',
      sessionId: 'global',
      timestamp: new Date().toISOString(),
      data: { from: 'sender' },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(t2Received.length).toBe(1);
    expect(t3Received.length).toBe(1);
    expect(t2Received[0].id).toBe('broadcast-test');
    expect(t3Received[0].id).toBe('broadcast-test');
  });

  it('should not receive own messages', async () => {
    const t1 = bus.createTransport('self-test');
    await t1.initialize();

    const received: HubMessage[] = [];
    t1.onMessage((msg) => received.push(msg));

    await t1.send({
      id: 'self-msg',
      type: MessageType.EVENT,
      method: 'test.self',
      sessionId: 'global',
      timestamp: new Date().toISOString(),
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(received.length).toBe(0);
  });

  it('should remove transports correctly', async () => {
    const t1 = bus.createTransport('to-remove');
    await t1.initialize();

    bus.removeTransport('to-remove');

    expect(bus.getTransportNames()).not.toContain('to-remove');
    expect(bus.getTransport('to-remove')).toBeUndefined();
  });
});

describe('MessageHub with InProcessTransport', () => {
  it('should support full RPC via in-process transport', async () => {
    const [clientTransport, serverTransport] = InProcessTransport.createPair();

    const clientHub = new MessageHub({ defaultSessionId: 'global' });
    const serverHub = new MessageHub({ defaultSessionId: 'global' });

    clientHub.registerTransport(clientTransport);
    serverHub.registerTransport(serverTransport);

    await clientTransport.initialize();

    serverHub.onRequest('math.add', async (data: { a: number; b: number }) => {
      return { result: data.a + data.b };
    });

    const response = await clientHub.request<{ result: number }>('math.add', {
      a: 5,
      b: 3,
    });

    expect(response.result).toBe(8);

    await clientTransport.close();
    await serverTransport.close();
  });

  it('should support pub/sub via in-process transport', async () => {
    const [clientTransport, serverTransport] = InProcessTransport.createPair();

    const clientHub = new MessageHub({ defaultSessionId: 'global' });
    const serverHub = new MessageHub({ defaultSessionId: 'global' });

    clientHub.registerTransport(clientTransport);
    serverHub.registerTransport(serverTransport);

    await clientTransport.initialize();

    const receivedEvents: unknown[] = [];

    clientHub.onEvent('session.created', (data) => {
      receivedEvents.push(data);
    });

    await serverTransport.send({
      id: 'event-1',
      type: MessageType.EVENT,
      method: 'session.created',
      sessionId: 'global',
      timestamp: new Date().toISOString(),
      data: { sessionId: 'new-session' },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(receivedEvents.length).toBe(1);
    expect((receivedEvents[0] as { sessionId: string }).sessionId).toBe('new-session');

    await clientTransport.close();
    await serverTransport.close();
  });
});
