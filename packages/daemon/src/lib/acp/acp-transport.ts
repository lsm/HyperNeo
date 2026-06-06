import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { AcpJsonRpcNotification, AcpJsonRpcRequest, AcpJsonRpcResponse } from '@neokai/shared';
import { Logger } from '../logger';

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const CLOSE_SIGTERM_TIMEOUT_MS = 5_000;

const logger = new Logger('AcpTransport');

export interface AcpTransportCallbacks {
  onNotification?: (notification: AcpJsonRpcNotification) => void;
  onExit?: (code: number | null, signal: string | null) => void;
  onStderr?: (data: string) => void;
}

export interface AcpTransportOptions extends AcpTransportCallbacks {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (response: AcpJsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * JSON-RPC 2.0 stdio transport for ACP agents.
 *
 * Spawns a child process, sends requests/notifications via stdin,
 * and parses line-delimited JSON-RPC messages from stdout.
 */
export class AcpTransport {
  private process: ChildProcess | null = null;
  private nextId = 1;
  private pendingRequests = new Map<number | string, PendingRequest>();
  private buffer = '';
  private closed = false;
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
      env: { ...process.env, ...env } as NodeJS.ProcessEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    this.process = proc;

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
      this.process = null;
      this.rejectAllPending(new Error('ACP agent process exited'));
      if (this.options.onExit) {
        this.options.onExit(code, signal);
      }
      if (this.closeResolve) {
        this.closeResolve();
      }
    });

    proc.on('error', (err) => {
      logger.error('ACP agent process error:', err.message);
      this.process = null;
      this.rejectAllPending(new Error(`ACP agent process error: ${err.message}`));
      if (this.options.onExit) {
        this.options.onExit(null, null);
      }
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

        if ('id' in message && message.id != null) {
          this.handleResponse(message as AcpJsonRpcResponse);
        } else if ('method' in message) {
          this.handleNotification(message as AcpJsonRpcNotification);
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
      this.options.onNotification(notification);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   */
  sendRequest(method: string, params?: unknown): Promise<AcpJsonRpcResponse> {
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
        this.process!.stdin!.write(JSON.stringify(request) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(id);
        reject(new Error(`Failed to write request: ${(err as Error).message}`));
      }
    });
  }

  /**
   * Send a JSON-RPC notification (fire-and-forget).
   */
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

  /**
   * Close the transport.
   * Sends SIGTERM, waits 5s, then SIGKILL if still running.
   */
  close(): Promise<void> {
    if (this.closed) {
      return this.closePromise ?? Promise.resolve();
    }

    this.closed = true;
    this.rejectAllPending(new Error('Transport is closing'));

    this.closePromise = new Promise((resolve) => {
      this.closeResolve = resolve;

      if (!this.process || this.process.killed) {
        resolve();
        return;
      }

      // SIGTERM → wait → SIGKILL
      this.process.kill('SIGTERM');

      const killTimer = setTimeout(() => {
        if (this.process && !this.process.killed) {
          logger.warn('ACP agent did not exit after SIGTERM, sending SIGKILL');
          this.process.kill('SIGKILL');
        }
      }, CLOSE_SIGTERM_TIMEOUT_MS);

      this.process.on('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });

      this.process.on('error', () => {
        clearTimeout(killTimer);
        resolve();
      });
    });

    return this.closePromise;
  }
}
