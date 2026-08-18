import type {
  IMessageTransport,
  ConnectionState,
  ConnectionStateHandler,
  BroadcastResult,
} from './types.ts';
import type { HubMessage } from './protocol.ts';
import { generateUUID } from '../utils.ts';

type UnsubscribeFn = () => void;

export interface InProcessTransportOptions {
  name?: string;

  simulatedLatency?: number;

  cloneMessages?: boolean;
}

export class InProcessTransport implements IMessageTransport {
  readonly name: string;

  private peer: InProcessTransport | null = null;
  private state: ConnectionState = 'disconnected';
  private messageHandlers = new Set<(message: HubMessage) => void>();
  private connectionHandlers = new Set<ConnectionStateHandler>();
  private clientDisconnectHandlers = new Set<(clientId: string) => void>();

  private readonly simulatedLatency: number;
  private readonly cloneMessages: boolean;

  private connectedClients = new Map<string, InProcessTransport>();
  private clientId: string;

  constructor(options: InProcessTransportOptions = {}) {
    this.name = options.name || 'in-process';
    this.simulatedLatency = options.simulatedLatency || 0;
    this.cloneMessages = options.cloneMessages || false;
    this.clientId = generateUUID();
  }

  static createPair(
    options: InProcessTransportOptions = {}
  ): [InProcessTransport, InProcessTransport] {
    const client = new InProcessTransport({
      ...options,
      name: options.name ? `${options.name}-client` : 'in-process-client',
    });
    const server = new InProcessTransport({
      ...options,
      name: options.name ? `${options.name}-server` : 'in-process-server',
    });

    client.peer = server;
    server.peer = client;

    server.connectedClients.set(client.clientId, client);

    return [client, server];
  }

  async initialize(): Promise<void> {
    if (!this.peer) {
      throw new Error('InProcessTransport not paired. Use createPair() or InProcessTransportBus.');
    }

    this.setState('connected');

    if (this.peer.state !== 'connected') {
      this.peer.setState('connected');
    }
  }

  async send(message: HubMessage): Promise<void> {
    if (!this.isReady()) {
      throw new Error('InProcessTransport not connected');
    }

    const msgToSend = this.cloneMessages ? structuredClone(message) : message;

    await this.deliverAsync(() => {
      this.peer!.receiveMessage(msgToSend);
    });
  }

  async sendToClient(clientId: string, message: HubMessage): Promise<boolean> {
    const client = this.connectedClients.get(clientId);
    if (!client || !client.isReady()) {
      return false;
    }

    const msgToSend = this.cloneMessages ? structuredClone(message) : message;

    await this.deliverAsync(() => {
      client.receiveMessage(msgToSend);
    });

    return true;
  }

  async broadcastToClients(clientIds: string[], message: HubMessage): Promise<BroadcastResult> {
    let sent = 0;
    let failed = 0;

    const msgToSend = this.cloneMessages ? structuredClone(message) : message;

    for (const clientId of clientIds) {
      const success = await this.sendToClient(clientId, msgToSend);
      if (success) {
        sent++;
      } else {
        failed++;
      }
    }

    return {
      sent,
      failed,
      totalTargets: clientIds.length,
    };
  }

  async close(): Promise<void> {
    if (this.peer) {
      const peerId = this.clientId;
      this.peer.connectedClients.delete(peerId);

      for (const handler of this.peer.clientDisconnectHandlers) {
        try {
          handler(peerId);
        } catch {
          // Ignore handler errors during cleanup
        }
      }
    }

    this.setState('disconnected');
    this.peer = null;
    this.connectedClients.clear();
  }

  isReady(): boolean {
    return this.state === 'connected' && this.peer !== null;
  }

  getState(): ConnectionState {
    return this.state;
  }

  onMessage(handler: (message: HubMessage) => void): UnsubscribeFn {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  onConnectionChange(handler: ConnectionStateHandler): UnsubscribeFn {
    this.connectionHandlers.add(handler);
    return () => {
      this.connectionHandlers.delete(handler);
    };
  }

  onClientDisconnect(handler: (clientId: string) => void): UnsubscribeFn {
    this.clientDisconnectHandlers.add(handler);
    return () => {
      this.clientDisconnectHandlers.delete(handler);
    };
  }

  getClientId(): string {
    return this.clientId;
  }

  getClientCount(): number {
    return this.connectedClients.size;
  }

  private receiveMessage(message: HubMessage): void {
    for (const handler of this.messageHandlers) {
      try {
        handler(message);
      } catch {
        // Message handler error - silently continue
      }
    }
  }

  private setState(state: ConnectionState, error?: Error): void {
    if (this.state === state) {
      return;
    }

    this.state = state;

    for (const handler of this.connectionHandlers) {
      try {
        handler(state, error);
      } catch {
        // Connection handler error - silently continue
      }
    }
  }

  private async deliverAsync(fn: () => void): Promise<void> {
    if (this.simulatedLatency > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.simulatedLatency));
      fn();
    } else {
      await new Promise<void>((resolve) => {
        queueMicrotask(() => {
          fn();
          resolve();
        });
      });
    }
  }
}

export class InProcessTransportBus {
  private transports = new Map<string, InProcessTransport>();
  private options: InProcessTransportOptions;

  constructor(options: InProcessTransportOptions = {}) {
    this.options = options;
  }

  createTransport(name: string): InProcessTransport {
    if (this.transports.has(name)) {
      throw new Error(`Transport '${name}' already exists`);
    }

    const transport = new BusConnectedTransport(this, {
      ...this.options,
      name,
    });

    this.transports.set(name, transport);

    return transport;
  }

  getTransport(name: string): InProcessTransport | undefined {
    return this.transports.get(name);
  }

  removeTransport(name: string): void {
    const transport = this.transports.get(name);
    if (transport) {
      transport.close();
      this.transports.delete(name);
    }
  }

  broadcast(message: HubMessage, excludeName?: string): void {
    for (const [name, transport] of this.transports) {
      if (name !== excludeName && transport.isReady()) {
        transport['receiveMessage'](message);
      }
    }
  }

  getTransportNames(): string[] {
    return Array.from(this.transports.keys());
  }

  async close(): Promise<void> {
    for (const transport of this.transports.values()) {
      await transport.close();
    }
    this.transports.clear();
  }
}

class BusConnectedTransport extends InProcessTransport {
  private bus: InProcessTransportBus;

  constructor(bus: InProcessTransportBus, options: InProcessTransportOptions) {
    super(options);
    this.bus = bus;
  }

  async initialize(): Promise<void> {
    this['setState']('connected');
  }

  async send(message: HubMessage): Promise<void> {
    if (!this.isReady()) {
      throw new Error('Transport not connected');
    }

    this.bus.broadcast(message, this.name);
  }

  isReady(): boolean {
    return this['state'] === 'connected';
  }
}
