import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type {
  AcpJsonRpcError,
  AcpJsonRpcNotification,
  AcpJsonRpcRequest,
  AcpJsonRpcResponse,
} from '@hyperneo/shared';
import { Logger } from '../logger';
import {
  acpProcessGroupAlive,
  type AcpProcessTree,
  type AcpProcessTreeOwner,
  basicAcpProcessTreeOwner,
} from './acp-process-tree';

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const CLOSE_SIGTERM_TIMEOUT_MS = 5_000;

const logger = new Logger('AcpTransport');

export function buildAcpProcessEnv(
  env?: Record<string, string | undefined>,
  replaceEnv = false
): NodeJS.ProcessEnv {
  const processEnv: NodeJS.ProcessEnv = replaceEnv ? {} : { ...process.env };
  for (const [key, value] of Object.entries(env ?? {})) {
    if (value === undefined) {
      delete processEnv[key];
    } else {
      processEnv[key] = value;
    }
  }
  return processEnv;
}

export interface AcpTransportCallbacks {
  onNotification?: (notification: AcpJsonRpcNotification) => void;
  onRequest?: (request: AcpJsonRpcRequest) => void;
  onExit?: (code: number | null, signal: string | null) => void;
  onStderr?: (data: string) => void;
  onProcessSpawn?: (process: ChildProcess) => void;
}

export interface AcpTransportOptions extends AcpTransportCallbacks {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  replaceEnv?: boolean;
  cwd?: string;
  requestTimeoutMs?: number;
  closeSIGKILLTimeoutMs?: number;
  processGroupProbe?: (pid: number) => boolean;
  processTreeOwner?: AcpProcessTreeOwner;
}

interface PendingRequest {
  resolve: (response: AcpJsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AcpTransport {
  private process: ChildProcess | null = null;
  private processTree: AcpProcessTree | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number | string, PendingRequest>();
  private buffer = '';
  private closed = false;
  private processExited = false;
  private processPid: number | undefined;
  private processGroupGone = false;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private closePromise: Promise<void> | null = null;
  private closeResolve: (() => void) | null = null;

  constructor(private readonly options: AcpTransportOptions) {
    this.spawnProcess();
  }

  private spawnProcess(): void {
    if (this.closed) {
      return;
    }

    const { command, args = [], cwd, env } = this.options;

    const proc = spawn(command, args, {
      cwd,
      env: buildAcpProcessEnv(env, this.options.replaceEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    this.process = proc;
    this.processPid = proc.pid ?? undefined;

    proc.on('error', (err) => {
      logger.error('ACP agent process error:', err.message);
      this.recordProcessGroupGone();
      this.process = null;
      this.processExited = true;
      this.rejectAllPending(new Error(`ACP agent process error: ${err.message}`));
      if (this.options.onExit) {
        this.options.onExit(null, null);
      }
      if (this.closeResolve) {
        this.closeResolve();
      }
    });

    this.processTree = (this.options.processTreeOwner ?? basicAcpProcessTreeOwner)(proc);
    this.options.onProcessSpawn?.(proc);

    proc.stdout?.on('data', (chunk: Buffer) => {
      this.handleStdoutChunk(chunk);
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const data = chunk.toString('utf-8');
      if (this.options.onStderr) {
        this.options.onStderr(data);
      } else {
        logger.warn('ACP agent stderr:', data.trimEnd());
      }
    });

    proc.on('exit', (code, signal) => {
      logger.info(`ACP agent exited (code=${code}, signal=${signal})`);
      this.recordProcessGroupGone();
      this.process = null;
      this.processExited = true;
      if (this.options.onExit) {
        this.options.onExit(code, signal);
      }
    });

    proc.on('close', () => {
      this.rejectAllPending(new Error('ACP agent process exited'));
      if (this.closeResolve) {
        this.closeResolve();
      }
    });
  }

  private handleStdoutChunk(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8');

    let lineEnd: number;
    while ((lineEnd = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, lineEnd).trim();
      this.buffer = this.buffer.slice(lineEnd + 1);

      if (line.length === 0) {
        continue;
      }

      try {
        const message = JSON.parse(line) as AcpJsonRpcResponse | AcpJsonRpcNotification;

        if ('method' in message) {
          if ('id' in message) {
            this.handleRequest(message as AcpJsonRpcRequest);
          } else {
            this.handleNotification(message as AcpJsonRpcNotification);
          }
        } else if ('id' in message) {
          this.handleResponse(message as AcpJsonRpcResponse);
        } else {
          logger.warn('Unrecognized JSON-RPC message:', line);
        }
      } catch (err) {
        logger.warn('Failed to parse JSON-RPC line:', (err as Error).message, line);
      }
    }
  }

  private handleResponse(response: AcpJsonRpcResponse): void {
    if (response.id == null) {
      logger.warn('Received response with null id');
      return;
    }
    const pending = this.pendingRequests.get(response.id);
    if (!pending) {
      logger.warn('Received response for unknown request ID:', response.id);
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.id);
    pending.resolve(response);
  }

  private handleNotification(notification: AcpJsonRpcNotification): void {
    if (this.options.onNotification) {
      try {
        this.options.onNotification(notification);
      } catch (err) {
        logger.error('Notification handler error:', (err as Error).message);
      }
    }
  }

  private handleRequest(request: AcpJsonRpcRequest): void {
    if (this.options.onRequest) {
      try {
        const result = this.options.onRequest(request) as unknown;
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          (result as Promise<unknown>).catch((err) => {
            logger.error('Inbound request handler error:', (err as Error).message);
            this.sendErrorResponse(request.id, { code: -32603, message: 'Internal error' });
          });
        }
      } catch (err) {
        logger.error('Inbound request handler error:', (err as Error).message);
        this.sendErrorResponse(request.id, { code: -32603, message: 'Internal error' });
      }
    } else {
      logger.warn('Received inbound request but no onRequest handler:', request.method);
      this.sendErrorResponse(request.id, { code: -32601, message: 'Method not found' });
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  sendRequest(
    method: string,
    params?: unknown,
    options?: { onSubmitted?: () => void }
  ): Promise<AcpJsonRpcResponse> {
    if (this.closed) {
      return Promise.reject(new Error('Transport is closed'));
    }

    if (!this.process || this.process.killed) {
      return Promise.reject(new Error('ACP agent process is not running'));
    }

    const id = this.nextId++;
    const request: AcpJsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeoutMs = this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer });

      try {
        this.process!.stdin!.write(JSON.stringify(request) + '\n', (error) => {
          if (error) {
            clearTimeout(timer);
            if (this.pendingRequests.delete(id)) {
              reject(new Error(`Failed to write request: ${error.message}`));
            }
            return;
          }
          try {
            options?.onSubmitted?.();
          } catch (err) {
            clearTimeout(timer);
            if (this.pendingRequests.delete(id)) {
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          }
        });
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error(`Failed to write request: ${(err as Error).message}`));
      }
    });
  }

  sendNotification(method: string, params?: unknown): void {
    if (this.closed || !this.process || this.process.killed) {
      logger.warn('Cannot send notification: transport is closed or process is dead');
      return;
    }

    const notification: AcpJsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };

    try {
      this.process.stdin!.write(JSON.stringify(notification) + '\n');
    } catch (err) {
      logger.error('Failed to write notification:', (err as Error).message);
    }
  }

  sendResponse(id: number | string | null, result: unknown): void {
    if (this.closed || !this.process || this.processExited) {
      logger.warn('Cannot send response: transport is closed or process has exited');
      return;
    }

    const response: AcpJsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      result,
    };

    try {
      this.process.stdin!.write(JSON.stringify(response) + '\n');
    } catch (err) {
      logger.error('Failed to write response:', (err as Error).message);
    }
  }

  sendErrorResponse(id: number | string | null, error: AcpJsonRpcError): void {
    if (this.closed || !this.process || this.processExited) {
      logger.warn('Cannot send error response: transport is closed or process has exited');
      return;
    }

    const response: AcpJsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      error,
    };

    try {
      this.process.stdin!.write(JSON.stringify(response) + '\n');
    } catch (err) {
      logger.error('Failed to write error response:', (err as Error).message);
    }
  }

  private killProcess(signal: NodeJS.Signals): void {
    this.processTree?.terminate(signal);
  }

  private recordProcessGroupGone(): void {
    if (!this.processGroupGone) {
      const pid = this.processPid;
      if (pid != null && !(this.options.processGroupProbe ?? acpProcessGroupAlive)(pid)) {
        this.processGroupGone = true;
      }
    }
    if (this.processGroupGone && this.killTimer) {
      clearTimeout(this.killTimer);
      this.killTimer = null;
    }
  }

  close(): Promise<void> {
    if (this.closed) {
      return this.closePromise ?? Promise.resolve();
    }

    this.closed = true;
    this.rejectAllPending(new Error('Transport is closing'));

    this.closePromise = new Promise((resolve) => {
      this.closeResolve = resolve;

      if (!this.processTree) {
        resolve();
        return;
      }

      this.recordProcessGroupGone();
      if (this.processGroupGone) {
        resolve();
        return;
      }

      this.killProcess('SIGTERM');

      this.killTimer = setTimeout(() => {
        this.killTimer = null;
        this.recordProcessGroupGone();
        if (this.processGroupGone) return;
        logger.warn('ACP agent cleanup escalation after SIGTERM');
        this.killProcess('SIGKILL');
      }, this.options.closeSIGKILLTimeoutMs ?? CLOSE_SIGTERM_TIMEOUT_MS);
      this.killTimer.unref();

      if (this.processExited) {
        resolve();
      }
    });

    return this.closePromise;
  }
}
