import { type ChildProcess, spawn } from 'node:child_process';
import type {
  AcpTerminalCreateParams,
  AcpTerminalCreateResult,
  AcpTerminalKillParams,
  AcpTerminalKillResult,
  AcpTerminalOutputParams,
  AcpTerminalOutputResult,
  AcpTerminalReleaseParams,
  AcpTerminalReleaseResult,
  AcpTerminalWaitForExitParams,
  AcpTerminalWaitForExitResult,
} from '@hyperneo/shared';
import { Logger } from '../logger';
import { parseAcpCommand } from './acp-command';

const logger = new Logger('AcpTerminalManager');
const DEFAULT_OUTPUT_BYTE_LIMIT = 1024 * 1024;
const MAX_OUTPUT_BYTE_LIMIT = 4 * 1024 * 1024;

interface TerminalSession {
  process: ChildProcess;
  outputChunks: Buffer[];
  outputByteLength: number;
  outputByteLimit: number;
  outputTruncated: boolean;
  exitCode: number | null;
  exitSignal: string | null;
  exited: boolean;
  exitWaiters: Array<(value: { exitCode: number | null; signal: string | null }) => void>;
  released: boolean;
  killed: boolean;
  killTimer: ReturnType<typeof setTimeout> | null;
}

export class AcpTerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private disposed = false;

  constructor(
    private readonly baseEnv: Record<string, string> = {},
    private readonly defaultCwd?: string,
    private readonly processKill: (pid: number, signal: NodeJS.Signals) => void = process.kill
  ) {}

  async create(params: AcpTerminalCreateParams): Promise<AcpTerminalCreateResult> {
    if (this.disposed) throw new Error('ACP terminal manager has been disposed');
    if (params.cwd != null || (params.env?.length ?? 0) > 0) {
      throw new Error('ACP terminal cwd and environment overrides are not supported');
    }
    const terminalId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const { outputByteLimit } = params;
    const parsed =
      params.args === undefined
        ? parseAcpCommand(params.command)
        : { command: params.command, args: params.args };

    const child = spawn(parsed.command, parsed.args, {
      cwd: this.defaultCwd,
      env: this.baseEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    const requestedOutputByteLimit =
      typeof outputByteLimit === 'number' && Number.isFinite(outputByteLimit)
        ? outputByteLimit
        : DEFAULT_OUTPUT_BYTE_LIMIT;
    const session: TerminalSession = {
      process: child,
      outputChunks: [],
      outputByteLength: 0,
      outputByteLimit: Math.min(
        MAX_OUTPUT_BYTE_LIMIT,
        Math.max(1, Math.trunc(requestedOutputByteLimit))
      ),
      outputTruncated: false,
      exitCode: null,
      exitSignal: null,
      exited: false,
      exitWaiters: [],
      released: false,
      killed: false,
      killTimer: null,
    };

    child.stdout?.on('data', (chunk: Buffer) => this.appendOutput(terminalId, chunk));
    child.stderr?.on('data', (chunk: Buffer) => this.appendOutput(terminalId, chunk));

    child.on('close', (code, signal) => {
      if (session.exited) return;
      session.exitCode = code ?? null;
      session.exitSignal = signal ?? null;
      session.exited = true;
      if (session.killTimer && process.platform === 'win32') {
        clearTimeout(session.killTimer);
        session.killTimer = null;
      }
      for (const waiter of session.exitWaiters) {
        waiter({ exitCode: session.exitCode, signal: session.exitSignal });
      }
      session.exitWaiters = [];
    });

    child.on('error', (err) => {
      logger.error(`Terminal ${terminalId} process error:`, err.message);
      session.exitCode = 1;
      session.exitSignal = null;
      session.exited = true;
      if (session.killTimer && process.platform === 'win32') {
        clearTimeout(session.killTimer);
        session.killTimer = null;
      }
      const message = `Process error: ${err.message}\n`;
      this.appendOutput(terminalId, Buffer.from(message));
      for (const waiter of session.exitWaiters) {
        waiter({ exitCode: 1, signal: null });
      }
      session.exitWaiters = [];
    });

    this.sessions.set(terminalId, session);
    return { terminalId };
  }

  async output(params: AcpTerminalOutputParams): Promise<AcpTerminalOutputResult> {
    const session = this.getSession(params.terminalId);
    const output = Buffer.concat(session.outputChunks, session.outputByteLength).toString('utf-8');

    return {
      output,
      truncated: session.outputTruncated,
      exitStatus: session.exited
        ? { exitCode: session.exitCode, signal: session.exitSignal }
        : null,
    };
  }

  async waitForExit(params: AcpTerminalWaitForExitParams): Promise<AcpTerminalWaitForExitResult> {
    const session = this.getSession(params.terminalId);
    if (session.exited) {
      return { exitCode: session.exitCode, signal: session.exitSignal };
    }

    return new Promise((resolve) => {
      session.exitWaiters.push(resolve);
    });
  }

  async kill(params: AcpTerminalKillParams): Promise<AcpTerminalKillResult> {
    const session = this.getSession(params.terminalId);
    if (!session.killed && (process.platform !== 'win32' || !session.exited)) {
      session.killed = true;
      this.signalProcess(session.process, 'SIGTERM');
      session.killTimer = setTimeout(() => {
        session.killTimer = null;
        if (process.platform !== 'win32' || !session.exited) {
          this.signalProcess(session.process, 'SIGKILL');
        }
      }, 5000);
      session.killTimer.unref();
    }
    return {};
  }

  async release(params: AcpTerminalReleaseParams): Promise<AcpTerminalReleaseResult> {
    const session = this.getSession(params.terminalId);
    if (!session.released) {
      session.released = true;
      await this.kill(params);
    }
    this.sessions.delete(params.terminalId);
    return {};
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const [terminalId, session] of this.sessions) {
      if (!session.killed && (process.platform !== 'win32' || !session.exited)) {
        session.killed = true;
        this.signalProcess(session.process, 'SIGTERM');
        session.killTimer = setTimeout(() => {
          session.killTimer = null;
          if (process.platform !== 'win32' || !session.exited) {
            this.signalProcess(session.process, 'SIGKILL');
          }
        }, 5000);
        session.killTimer.unref();
      }
      session.released = true;
      this.sessions.delete(terminalId);
    }
  }

  private getSession(terminalId: string): TerminalSession {
    const session = this.sessions.get(terminalId);
    if (!session) throw new Error(`Unknown or released ACP terminal: ${terminalId}`);
    return session;
  }

  private signalProcess(child: ChildProcess, signal: NodeJS.Signals): void {
    if (process.platform !== 'win32' && child.pid != null) {
      try {
        this.processKill(-child.pid, signal);
        return;
      } catch {}
    }
    child.kill(signal);
  }

  private appendOutput(terminalId: string, chunk: Buffer): void {
    const session = this.sessions.get(terminalId);
    if (!session) return;
    if (chunk.length > session.outputByteLimit) {
      session.outputChunks = [chunk.subarray(chunk.length - session.outputByteLimit)];
      session.outputByteLength = session.outputByteLimit;
      session.outputTruncated = true;
      return;
    }

    session.outputChunks.push(chunk);
    session.outputByteLength += chunk.length;
    while (session.outputByteLength > session.outputByteLimit) {
      const overflow = session.outputByteLength - session.outputByteLimit;
      const first = session.outputChunks[0];
      session.outputTruncated = true;
      if (first.length <= overflow) {
        session.outputChunks.shift();
        session.outputByteLength -= first.length;
      } else {
        session.outputChunks[0] = first.subarray(overflow);
        session.outputByteLength -= overflow;
      }
    }
  }
}
