import type {
  AcpInitializeResult,
  AcpInitializeParams,
  AcpAuthenticateParams,
  AcpSessionNewParams,
  AcpSessionNewResult,
  AcpSessionCloseParams,
  AcpSessionPromptParams,
  AcpSessionPromptResult,
  AcpSessionCancelParams,
  AcpSessionUpdateNotification,
  AcpSessionLoadParams,
  AcpSessionLoadResult,
  AcpSessionResumeParams,
  AcpSessionResumeResult,
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
} from '@hyperneo/shared';
import type { AcpProcessTreeOwner } from './acp-process-tree';
import { AcpTransport } from './acp-transport';
import type { AcpTransportCallbacks } from './acp-transport';

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

export interface AcpClientOptions
  extends AcpClientCallbacks,
    Pick<AcpTransportCallbacks, 'onProcessSpawn' | 'onStderr' | 'onExit'> {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  replaceEnv?: boolean;
  cwd?: string;
  requestTimeoutMs?: number;
  processTreeOwner?: AcpProcessTreeOwner;
}

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
      clientInfo: { name: 'HyperNeo', version: '0.1.0' },
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

  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: AcpMcpServerConfig[] = []
  ): Promise<{
    sessionId: string;
    configOptions: AcpConfigOption[];
    modes?: AcpSessionModeState | null;
  }> {
    const params: AcpSessionLoadParams = { sessionId, cwd, mcpServers };
    const response = await this.transport.sendRequest('session/load', params);

    if ('error' in response) {
      throw new Error(`session/load failed: ${response.error.message}`);
    }

    const result = response.result as AcpSessionLoadResult;
    this.sessionId = result.sessionId ?? sessionId;
    this.cachedConfigOptions = result.configOptions ?? [];
    this.cachedModes = result.modes ?? undefined;

    return {
      sessionId: this.sessionId,
      configOptions: this.cachedConfigOptions,
      modes: result.modes,
    };
  }

  async resumeSession(
    sessionId: string,
    cwd: string,
    mcpServers: AcpMcpServerConfig[] = []
  ): Promise<{
    sessionId: string;
    configOptions: AcpConfigOption[];
    modes?: AcpSessionModeState | null;
  }> {
    const params: AcpSessionResumeParams = { sessionId, cwd, mcpServers };
    const response = await this.transport.sendRequest('session/resume', params);

    if ('error' in response) {
      throw new Error(`session/resume failed: ${response.error.message}`);
    }

    const result = response.result as AcpSessionResumeResult;
    this.sessionId = result.sessionId ?? sessionId;
    this.cachedConfigOptions = result.configOptions ?? [];
    this.cachedModes = result.modes ?? undefined;

    return {
      sessionId: this.sessionId,
      configOptions: this.cachedConfigOptions,
      modes: result.modes,
    };
  }

  canLoadSession(): boolean {
    if (this.agentCapabilities?.loadSession) return true;
    const sessionCapabilities = this.agentCapabilities?.sessionCapabilities;
    return !!sessionCapabilities && 'resume' in sessionCapabilities;
  }

  canCloseSession(): boolean {
    return !!this.agentCapabilities?.sessionCapabilities?.close;
  }

  async closeSession(): Promise<void> {
    if (!this.sessionId) return;
    const response = await this.transport.sendRequest('session/close', {
      sessionId: this.sessionId,
    } as AcpSessionCloseParams);
    if ('error' in response) {
      throw new Error(`session/close failed: ${response.error.message}`);
    }
  }

  async *sendPrompt(
    prompt: AcpContentBlock[],
    callbacks?: { onSubmitted?: () => void; onAccepted?: () => void }
  ): AsyncGenerator<AcpSessionUpdateNotification> {
    if (!this.sessionId) {
      throw new Error('No active session. Call createSession() first.');
    }

    this.lastPromptStopReason = undefined;
    const queue: AcpSessionUpdateNotification[] = [];
    let resolveNext: (() => void) | null = null;
    let done = false;
    let error: Error | null = null;
    let accepted = false;
    const accept = () => {
      if (accepted) return;
      callbacks?.onAccepted?.();
      accepted = true;
    };

    const subscriber = (notification: AcpJsonRpcNotification) => {
      if (notification.method !== 'session/update') return;
      const params = notification.params as AcpSessionUpdateNotification;
      if (params.sessionId !== this.sessionId) return;
      try {
        accept();
      } catch {
        // Acceptance callback failed — retryable on the next session/update or
        // the prompt-response fallback; the update itself is still delivered.
      }
      queue.push(params);
      if (resolveNext) {
        resolveNext();
        resolveNext = null;
      }
    };

    this.notificationSubscribers.add(subscriber);

    const requestPromise = this.transport
      .sendRequest(
        'session/prompt',
        {
          sessionId: this.sessionId,
          prompt,
        } as AcpSessionPromptParams,
        { onSubmitted: callbacks?.onSubmitted }
      )
      .then(
        (response) => {
          if ('error' in response) {
            error = new Error(response.error.message);
          } else {
            const result = response.result as AcpSessionPromptResult;
            this.lastPromptStopReason = result.stopReason;
            try {
              accept();
            } catch {
              // Acceptance callback failed — the row stays retryable and the
              // runner's end-of-run settle terminalizes it; never leave
              // `done` unset or sendPrompt waits forever on a settled request.
            }
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

  cancel(): void {
    if (!this.sessionId || this.closed) return;
    this.transport.sendNotification('session/cancel', {
      sessionId: this.sessionId,
    } as AcpSessionCancelParams);
  }

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

  updateConfigOptions(configOptions: AcpConfigOption[]): void {
    this.cachedConfigOptions = configOptions;
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

  async setConfigOption(configId: string, value: string): Promise<AcpConfigOption[]> {
    if (!this.sessionId) {
      throw new Error('No active session. Call createSession() first.');
    }

    const response = await this.transport.sendRequest('session/set_config_option', {
      sessionId: this.sessionId,
      configId,
      value,
    });

    if ('error' in response) {
      throw new Error(`session/set_config_option failed: ${response.error.message}`);
    }

    const result = response.result as { configOptions?: AcpConfigOption[] | null };
    this.cachedConfigOptions = result.configOptions ?? [];
    return this.cachedConfigOptions;
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
      case 'terminal/wait_for_exit':
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
