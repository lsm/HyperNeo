import { spawn, type ChildProcess } from 'node:child_process';
import type {
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
} from '@hyperneo/shared';
import { Logger } from '../logger';

const logger = new Logger('AcpTerminalManager');
const TERMINAL_WAIT_TIMEOUT_MS = 120_000;

interface TerminalSession {
  process: ChildProcess;
  output: Buffer;
  outputByteLimit: number;
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

  constructor(
    private readonly baseEnv: Record<string, string> = {},
    private readonly processKill: (pid: number, signal: NodeJS.Signals) => void = process.kill
  ) {}

  async create(params: AcpTerminalCreateParams): Promise<AcpTerminalCreateResult> {
    const terminalId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const { command, args = [], cwd, env, outputByteLimit } = params;

    const processEnv: NodeJS.ProcessEnv = { ...this.baseEnv };
    for (const entry of env ?? []) {
      processEnv[entry.name] = entry.value;
    }

    const child = spawn(command, args, {
      cwd: cwd ?? undefined,
      env: processEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    const session: TerminalSession = {
      process: child,
      output: Buffer.alloc(0),
      outputByteLimit: outputByteLimit ?? 1024 * 1024,
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
      session.exitCode = code ?? null;
      session.exitSignal = signal ?? null;
      session.exited = true;
      if (session.killTimer) {
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
      if (session.killTimer) {
        clearTimeout(session.killTimer);
        session.killTimer = null;
      }
      const message = `Process error: ${err.message}\n`;
      session.output = Buffer.concat([session.output, Buffer.from(message)]);
      for (const waiter of session.exitWaiters) {
        waiter({ exitCode: 1, signal: null });
      }
      session.exitWaiters = [];
    });

    this.sessions.set(terminalId, session);
    return { terminalId };
  }

  async output(params: AcpTerminalOutputParams): Promise<AcpTerminalOutputResult> {
    const session = this.sessions.get(params.terminalId);
    if (!session) {
      return { output: '', truncated: false, exitStatus: { exitCode: null, signal: null } };
    }

    const buffer = session.output;
    const truncated = buffer.length > session.outputByteLimit;
    const output = truncated
      ? buffer.subarray(buffer.length - session.outputByteLimit).toString('utf-8')
      : buffer.toString('utf-8');

    return {
      output,
      truncated,
      exitStatus: session.exited
        ? { exitCode: session.exitCode, signal: session.exitSignal }
        : null,
    };
  }

  async waitForExit(params: AcpTerminalWaitForExitParams): Promise<AcpTerminalWaitForExitResult> {
    const session = this.sessions.get(params.terminalId);
    if (!session) {
      return { exitCode: null, signal: null };
    }

    if (session.exited) {
      return { exitCode: session.exitCode, signal: session.exitSignal };
    }

    return new Promise((resolve, reject) => {
      const wrapped = (value: { exitCode: number | null; signal: string | null }) => {
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => {
        session.exitWaiters = session.exitWaiters.filter((w) => w !== wrapped);
        this.kill(params);
        reject(
          new Error(
            `Terminal ${params.terminalId} did not exit within ${TERMINAL_WAIT_TIMEOUT_MS}ms`
          )
        );
      }, TERMINAL_WAIT_TIMEOUT_MS);

      session.exitWaiters.push(wrapped);
    });
  }

  async kill(params: AcpTerminalKillParams): Promise<AcpTerminalKillResult> {
    const session = this.sessions.get(params.terminalId);
    if (session && !session.killed && !session.exited) {
      session.killed = true;
      this.signalProcess(session.process, 'SIGTERM');
      session.killTimer = setTimeout(() => {
        session.killTimer = null;
        if (!session.exited) {
          this.signalProcess(session.process, 'SIGKILL');
        }
      }, 5000);
    }
    return {};
  }

  async release(params: AcpTerminalReleaseParams): Promise<AcpTerminalReleaseResult> {
    const session = this.sessions.get(params.terminalId);
    if (session && !session.released) {
      session.released = true;
      await this.kill(params);
    }
    this.sessions.delete(params.terminalId);
    return {};
  }

  dispose(): void {
    for (const [terminalId, session] of this.sessions) {
      if (!session.exited) {
        session.killed = true;
        this.signalProcess(session.process, 'SIGTERM');
        session.killTimer = setTimeout(() => {
          session.killTimer = null;
          if (!session.exited) {
            this.signalProcess(session.process, 'SIGKILL');
          }
        }, 5000);
      }
      session.released = true;
      this.sessions.delete(terminalId);
    }
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
    session.output = Buffer.concat([session.output, chunk]);
    if (session.output.length > session.outputByteLimit * 2) {
      session.output = session.output.slice(-session.outputByteLimit * 2);
    }
  }
}
