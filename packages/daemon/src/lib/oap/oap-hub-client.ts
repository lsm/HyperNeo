import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import superpipe, { type PipelineAPI } from 'superpipe';
import { Logger } from '../logger.ts';
import { decodeOapHubLine, encodeOapHubRequest, type OapHubFrame } from './oap-hub-codec.ts';

type HubEvent = Extract<OapHubFrame, { kind: 'event' }>;
type Listener = (event: HubEvent | Error) => void;
type Pending = {
  line: string;
  retried: boolean;
  timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: Error): void;
};
type Dispatch =
  | { kind: 'ignore' }
  | { kind: 'retry' }
  | { kind: 'event'; frame: HubEvent }
  | { kind: 'resolve'; value: unknown }
  | { kind: 'reject'; code: string; message: string };

export interface OapHubClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export class OapHubRequestError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'OapHubRequestError';
  }
}

function decideFrame(frame: OapHubFrame, waiting: boolean, retried: boolean): Dispatch {
  if (frame.kind === 'event') return { kind: 'event', frame };
  if (!waiting) return { kind: 'ignore' };
  if (frame.kind === 'response') return { kind: 'resolve', value: frame.result };
  return frame.retryable && !retried
    ? { kind: 'retry' }
    : { kind: 'reject', code: frame.code, message: frame.message };
}

const planFrame = (superpipe({})('oap.hub.dispatch') as PipelineAPI)
  .input(['frame', 'waiting', 'retried'])
  .pipe(decideFrame, ['frame', 'waiting', 'retried'], 'dispatch')
  .end('dispatch') as typeof decideFrame;

const log = new Logger('OapHubClient');

function notify(listener: Listener | undefined, frame: HubEvent | Error) {
  try {
    listener?.(frame);
  } catch (error) {
    log.warn(
      'Hub subscription listener failed',
      error instanceof Error ? error.message : String(error)
    );
  }
}

export class OapHubClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private exited: Promise<void> = Promise.resolve();
  private failure: Error | null = null;
  private buffer = '';
  private nextId = 0;
  private readonly timeoutMs: number;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<number, Listener>();

  constructor(private readonly options: OapHubClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async connect(): Promise<void> {
    if (this.child || this.failure) throw new Error('OAP hub client connects once');
    try {
      const child = spawn(this.options.command, this.options.args, {
        cwd: this.options.cwd,
        env: this.options.env,
        stdio: 'pipe',
        windowsHide: true,
      });
      this.child = child;
      this.exited = new Promise((resolve) => child.once('close', () => resolve()));
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => this.receive(chunk));
      child.stderr.resume();
      child.stdin.on('error', (error) => this.fail(error));
      child.on('error', (error) => this.fail(error));
      child.on('close', (code, signal) =>
        this.fail(new Error(`OAP hub exited (code=${code}, signal=${signal})`))
      );
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      if (this.failure) throw this.failure;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
      throw this.failure;
    }
  }

  async request(op: string, parameters: Record<string, unknown> = {}): Promise<unknown> {
    return this.startRequest(op, parameters).answer;
  }

  async subscribe(
    sessionId: string,
    listener: Listener,
    cursor: { after?: number; run_id?: string } = {}
  ): Promise<{ id: number; unsubscribe(): Promise<void> }> {
    const { id, answer } = this.startRequest(
      'events',
      { ...cursor, session_id: sessionId },
      listener
    );
    try {
      await answer;
    } catch (error) {
      this.listeners.delete(id);
      throw error;
    }
    let closing: Promise<void> | undefined;
    return {
      id,
      unsubscribe: () => {
        if (!this.listeners.has(id)) return Promise.resolve();
        closing ??= this.request('unsubscribe', { subscription: id })
          .then(() => {
            this.listeners.delete(id);
          })
          .catch((error: unknown) => {
            closing = undefined;
            throw error;
          });
        return closing;
      },
    };
  }

  async close(): Promise<void> {
    this.fail(new Error('OAP hub client closed'));
    await this.exited;
  }

  private startRequest(op: string, parameters: Record<string, unknown>, listener?: Listener) {
    if (this.failure) throw this.failure;
    if (!this.child) throw new Error('OAP hub client is not connected');
    const id = ++this.nextId;
    const line = encodeOapHubRequest(id, op, parameters);
    const answer = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.listeners.delete(id);
        reject(new OapHubRequestError('timeout', `OAP hub ${op} timed out`));
        if (listener && !this.failure)
          void this.request('unsubscribe', { subscription: id }).catch((error: Error) =>
            this.fail(error)
          );
      }, this.timeoutMs);
      this.pending.set(id, { line, retried: false, timer, resolve, reject });
      if (listener) this.listeners.set(id, listener);
      this.write(line);
    });
    return { id, answer };
  }

  private write(line: string): void {
    try {
      this.child!.stdin.write(line, (error) => {
        if (error) this.fail(error);
      });
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private receive(chunk: string): void {
    if (this.failure) return;
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (!this.failure && newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      try {
        this.dispatch(decodeOapHubLine(line));
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private dispatch(frame: OapHubFrame): void {
    const waiting = this.pending.get(frame.id);
    const decision = planFrame(frame, !!waiting, waiting?.retried ?? false);
    if (decision.kind === 'event') {
      notify(this.listeners.get(frame.id), decision.frame);
      return;
    }
    if (!waiting || decision.kind === 'ignore') return;
    if (decision.kind === 'retry') {
      waiting.retried = true;
      this.write(waiting.line);
      return;
    }
    this.pending.delete(frame.id);
    clearTimeout(waiting.timer);
    if (decision.kind === 'resolve') waiting.resolve(decision.value);
    else waiting.reject(new OapHubRequestError(decision.code, decision.message));
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    const child = this.child;
    this.child = null;
    if (child?.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      child.kill('SIGTERM');
      const escalation = setTimeout(() => child.kill('SIGKILL'), Math.min(this.timeoutMs, 1000));
      void this.exited.then(() => clearTimeout(escalation));
    }
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    for (const [id, listener] of this.listeners) if (!this.pending.has(id)) notify(listener, error);
    this.pending.clear();
    this.listeners.clear();
    this.buffer = '';
  }
}
