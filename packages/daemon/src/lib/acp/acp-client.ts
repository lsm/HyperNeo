/**
 * ACP Protocol Client
 *
 * Wraps AcpTransport with the ACP protocol state machine.
 * Handles initialization, authentication, session lifecycle,
 * prompt streaming, and server-to-client request delegation.
 */

import type {
  AcpInitializeResult,
  AcpInitializeParams,
  AcpAuthenticateParams,
  AcpSessionNewParams,
  AcpSessionNewResult,
  AcpSessionPromptParams,
  AcpSessionPromptResult,
  AcpSessionCancelParams,
  AcpSessionUpdateNotification,
  AcpConfigOption,
  AcpSessionModeState,
  AcpFsReadParams,
  AcpFsReadResult,
  AcpFsWriteParams,
  AcpFsWriteResult,
  AcpTerminalCreateParams,
  AcpTerminalCreateResult,
  AcpTerminalOutputParams,
  AcpTerminalOutputResult,
  AcpTerminalWaitForExitParams,
  AcpTerminalWaitForExitResult,
  AcpTerminalKillParams,
  AcpTerminalKillResult,
  AcpTerminalReleaseParams,
  AcpTerminalReleaseResult,
  AcpPermissionRequest,
  AcpPermissionResponseResult,
  AcpJsonRpcNotification,
  AcpJsonRpcRequest,
  AcpMcpServerConfig,
  AcpContentBlock,
  AcpStopReason,
} from '@neokai/shared';
import { AcpTransport } from './acp-transport';

export interface AcpClientCallbacks {
  onFsRead?(params: AcpFsReadParams): Promise<AcpFsReadResult>;
  onFsWrite?(params: AcpFsWriteParams): Promise<AcpFsWriteResult>;
  onTerminalCreate?(params: AcpTerminalCreateParams): Promise<AcpTerminalCreateResult>;
  onTerminalOutput?(params: AcpTerminalOutputParams): Promise<AcpTerminalOutputResult>;
  onTerminalWaitForExit?(
    params: AcpTerminalWaitForExitParams
  ): Promise<AcpTerminalWaitForExitResult>;
  onTerminalKill?(params: AcpTerminalKillParams): Promise<AcpTerminalKillResult>;
  onTerminalRelease?(params: AcpTerminalReleaseParams): Promise<AcpTerminalReleaseResult>;
  onPermissionRequest?(params: AcpPermissionRequest): Promise<AcpPermissionResponseResult>;
}

export interface AcpClientOptions extends AcpClientCallbacks {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  requestTimeoutMs?: number;
}

/**
 * ACP protocol client wrapping AcpTransport.
 */
export class AcpClient {
  private transport: AcpTransport;
  private callbacks: AcpClientCallbacks;
  private agentCapabilities: AcpInitializeResult['agentCapabilities'] | undefined;
  private authMethods: AcpInitializeResult['authMethods'] | undefined;
  private cachedConfigOptions: AcpConfigOption[] = [];
  private cachedModes: AcpSessionModeState | undefined;
  private sessionId: string | undefined;
  private notificationSubscribers = new Set<(notification: AcpJsonRpcNotification) => void>();
  private closed = false;
  private lastPromptStopReason: AcpStopReason | undefined;

  constructor(options: AcpClientOptions) {
    const {
      onFsRead,
      onFsWrite,
      onTerminalCreate,
      onTerminalOutput,
      onTerminalWaitForExit,
      onTerminalKill,
      onTerminalRelease,
      onPermissionRequest,
      ...transportOptions
    } = options;

    this.callbacks = {
      onFsRead,
      onFsWrite,
      onTerminalCreate,
      onTerminalOutput,
      onTerminalWaitForExit,
      onTerminalKill,
      onTerminalRelease,
      onPermissionRequest,
    };

    this.transport = new AcpTransport({
      ...transportOptions,
      onRequest: (request) => this.handleRequest(request),
      onNotification: (notification) => this.handleNotification(notification),
    });
  }

  /**
   * Send initialize request and store negotiated capabilities.
   */
  async initialize(): Promise<AcpInitializeResult> {
    const requestedVersion = 1;
    const hasFs = !!(this.callbacks.onFsRead || this.callbacks.onFsWrite);
    const hasTerminal = !!(
      this.callbacks.onTerminalCreate ||
      this.callbacks.onTerminalOutput ||
      this.callbacks.onTerminalWaitForExit ||
      this.callbacks.onTerminalKill ||
      this.callbacks.onTerminalRelease
    );

    const params: AcpInitializeParams = {
      protocolVersion: requestedVersion,
      clientCapabilities: {
        ...(hasFs ? { fs: { readTextFile: true, writeTextFile: true } } : {}),
        ...(hasTerminal ? { terminal: true } : {}),
      },
      clientInfo: { name: 'NeoKai', version: '0.1.0' },
    };

    const response = await this.transport.sendRequest('initialize', params);

    if ('error' in response) {
      throw new Error(`Initialize failed: ${response.error.message}`);
    }

    const result = response.result as AcpInitializeResult;
    if (result.protocolVersion !== requestedVersion) {
      throw new Error(
        `Unsupported ACP protocol version: agent returned ${result.protocolVersion}, client requested ${requestedVersion}`
      );
    }

    this.agentCapabilities = result.agentCapabilities;
    this.authMethods = result.authMethods;
    return result;
  }

  /**
   * Authenticate with the agent if auth is required.
   */
  async authenticate(credentials?: { methodId: string }): Promise<void> {
    if (!this.authMethods || this.authMethods.length === 0) {
      return;
    }

    const methodId = credentials?.methodId ?? this.authMethods[0].id;
    const params: AcpAuthenticateParams = { methodId };

    const response = await this.transport.sendRequest('authenticate', params);

    if ('error' in response) {
      throw new Error(`Authentication failed: ${response.error.message}`);
    }
  }

  /**
   * Create a new ACP session.
   */
  async createSession(
    cwd: string,
    mcpServers: AcpMcpServerConfig[] = []
  ): Promise<{
    sessionId: string;
    configOptions: AcpConfigOption[];
    modes?: AcpSessionModeState | null;
  }> {
    const params: AcpSessionNewParams = { cwd, mcpServers };
    const response = await this.transport.sendRequest('session/new', params);

    if ('error' in response) {
      throw new Error(`session/new failed: ${response.error.message}`);
    }

    const result = response.result as AcpSessionNewResult;
    this.sessionId = result.sessionId;
    this.cachedConfigOptions = result.configOptions ?? [];
    this.cachedModes = result.modes ?? undefined;

    return {
      sessionId: result.sessionId,
      configOptions: this.cachedConfigOptions,
      modes: result.modes,
    };
  }

  /**
   * Send a prompt and yield streaming update notifications.
   */
  async *sendPrompt(prompt: AcpContentBlock[]): AsyncGenerator<AcpSessionUpdateNotification> {
    if (!this.sessionId) {
      throw new Error('No active session. Call createSession() first.');
    }

    this.lastPromptStopReason = undefined;
    const queue: AcpSessionUpdateNotification[] = [];
    let resolveNext: (() => void) | null = null;
    let done = false;
    let error: Error | null = null;

    const subscriber = (notification: AcpJsonRpcNotification) => {
      if (notification.method !== 'session/update') return;
      const params = notification.params as AcpSessionUpdateNotification;
      if (params.sessionId !== this.sessionId) return;
      queue.push(params);
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    this.notificationSubscribers.add(subscriber);

    const requestPromise = this.transport
      .sendRequest('session/prompt', {
        sessionId: this.sessionId,
        prompt,
      } as AcpSessionPromptParams)
      .then(
        (response) => {
          if ('error' in response) {
            error = new Error(response.error.message);
          } else {
            const result = response.result as AcpSessionPromptResult;
            this.lastPromptStopReason = result.stopReason;
          }
          done = true;
        },
        (err) => {
          done = true;
          error = err instanceof Error ? err : new Error(String(err));
        }
      )
      .finally(() => {
        if (resolveNext) {
          resolveNext();
          resolveNext = null;
        }
      });

    try {
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveNext = resolve;
          });
          if (error) throw error;
          continue;
        }
        yield queue.shift()!;
      }
      if (error) throw error;
    } finally {
      this.notificationSubscribers.delete(subscriber);
      requestPromise.catch(() => {});
    }
  }

  /**
   * Cancel the current prompt turn.
   */
  cancel(): void {
    if (!this.sessionId || this.closed) return;
    this.transport.sendNotification('session/cancel', {
      sessionId: this.sessionId,
    } as AcpSessionCancelParams);
  }

  /**
   * Close the transport and clean up.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.transport.close().catch(() => {});
  }

  getSessionId(): string | undefined {
    return this.sessionId;
  }

  getConfigOptions(): AcpConfigOption[] {
    return this.cachedConfigOptions;
  }

  getModes(): AcpSessionModeState | undefined {
    return this.cachedModes;
  }

  getAgentCapabilities(): AcpInitializeResult['agentCapabilities'] | undefined {
    return this.agentCapabilities;
  }

  getLastPromptStopReason(): AcpStopReason | undefined {
    return this.lastPromptStopReason;
  }

  private async handleRequest(request: AcpJsonRpcRequest): Promise<void> {
    const handler = this.getRequestHandler(request.method);
    if (!handler) {
      this.transport.sendErrorResponse(request.id, {
        code: -32601,
        message: `Method not found: ${request.method}`,
      });
      return;
    }

    try {
      const result = await handler(request.params);
      this.transport.sendResponse(request.id, result);
    } catch (err) {
      this.transport.sendErrorResponse(request.id, {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private getRequestHandler(method: string): ((params: unknown) => Promise<unknown>) | undefined {
    switch (method) {
      case 'fs/read':
      case 'fs/read_text_file':
        return this.callbacks.onFsRead
          ? async (params) => this.callbacks.onFsRead!(params as AcpFsReadParams)
          : undefined;
      case 'fs/write':
      case 'fs/write_text_file':
        return this.callbacks.onFsWrite
          ? async (params) => this.callbacks.onFsWrite!(params as AcpFsWriteParams)
          : undefined;
      case 'terminal/create':
        return this.callbacks.onTerminalCreate
          ? async (params) => this.callbacks.onTerminalCreate!(params as AcpTerminalCreateParams)
          : undefined;
      case 'terminal/output':
        return this.callbacks.onTerminalOutput
          ? async (params) => this.callbacks.onTerminalOutput!(params as AcpTerminalOutputParams)
          : undefined;
      case 'terminal/waitForExit':
        return this.callbacks.onTerminalWaitForExit
          ? async (params) =>
              this.callbacks.onTerminalWaitForExit!(params as AcpTerminalWaitForExitParams)
          : undefined;
      case 'terminal/kill':
        return this.callbacks.onTerminalKill
          ? async (params) => this.callbacks.onTerminalKill!(params as AcpTerminalKillParams)
          : undefined;
      case 'terminal/release':
        return this.callbacks.onTerminalRelease
          ? async (params) => this.callbacks.onTerminalRelease!(params as AcpTerminalReleaseParams)
          : undefined;
      case 'session/request_permission':
        return this.callbacks.onPermissionRequest
          ? async (params) => this.callbacks.onPermissionRequest!(params as AcpPermissionRequest)
          : undefined;
      default:
        return undefined;
    }
  }

  private handleNotification(notification: AcpJsonRpcNotification): void {
    for (const subscriber of this.notificationSubscribers) {
      try {
        subscriber(notification);
      } catch {
        // Isolated subscriber errors
      }
    }
  }
}
