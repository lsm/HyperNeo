import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { generateUUID } from '@hyperneo/shared';

export const OAP_AGENT_PROFILE = 'open-agent-protocol.agent-control-core';
const OAP_PROTOCOL = 'open-agent-protocol';
const OAP_VERSION = '0.1';
const DEFAULT_TIMEOUT_MS = 30_000;
const UNREVISED_TYPES = new Set(['protocol.initialize.request', 'capabilities.request']);

export interface OapEnvelope {
  protocol: string;
  version: string;
  profile: string;
  type: string;
  id: string;
  in_reply_to?: string;
  session_id?: string;
  run_id?: string;
  capability_revision?: string;
  payload: Record<string, unknown>;
}

export interface OapStdioClientOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export type OapFrameListener = (frame: OapEnvelope | Error) => void;

interface Pending {
  resolve: (envelope: OapEnvelope) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Scope {
  id?: string;
  session_id?: string;
  run_id?: string;
}

export class OapStdioClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private failure: Error | null = null;
  private revision: string | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly listeners = new Set<OapFrameListener>();
  private readonly openSessions = new Set<string>();

  constructor(private readonly options: OapStdioClientOptions) {}

  async connect(): Promise<void> {
    const child = spawn(this.options.command, this.options.args, {
      cwd: this.options.cwd,
      env: this.options.env,
      stdio: 'pipe',
      windowsHide: true,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.receive(chunk));
    child.stderr.resume();
    child.on('error', (error) => this.fail(error));
    child.on('exit', (code, signal) =>
      this.fail(new Error(`OAP endpoint exited (code=${code}, signal=${signal})`))
    );
    const initialized = await this.request('protocol.initialize.request', {
      protocol_versions: [OAP_VERSION],
      profiles: [OAP_AGENT_PROFILE],
      participant: { id: 'hyperneo' },
    });
    if (initialized.payload.profile !== OAP_AGENT_PROFILE) {
      throw new Error('OAP endpoint did not negotiate the agent-control-core profile');
    }
    const capabilities = await this.request('capabilities.request', {});
    this.revision = capabilities.capability_revision;
  }

  async openSession(sessionId: string): Promise<void> {
    if (this.openSessions.has(sessionId)) return;
    await this.request(
      'session.open.request',
      { session_id: sessionId },
      { session_id: sessionId }
    );
    this.openSessions.add(sessionId);
  }

  async request(
    type: string,
    payload: Record<string, unknown>,
    scope: Scope = {}
  ): Promise<OapEnvelope> {
    const id = generateUUID();
    const response = await new Promise<OapEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for the answer to ${type}`));
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send(type, payload, { ...scope, id });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error as Error);
      }
    });
    if (response.type === 'error.response') {
      const error = response.payload.error as { code?: string; message?: string } | undefined;
      throw new Error(
        `OAP ${type} refused: ${error?.code ?? 'error'} ${error?.message ?? ''}`.trim()
      );
    }
    return response;
  }

  send(type: string, payload: Record<string, unknown>, scope: Scope = {}): void {
    if (this.failure) throw this.failure;
    if (!this.child) throw new Error('OAP client is not connected');
    const envelope: OapEnvelope = {
      protocol: OAP_PROTOCOL,
      version: OAP_VERSION,
      profile: OAP_AGENT_PROFILE,
      type,
      id: scope.id ?? generateUUID(),
      ...(scope.session_id ? { session_id: scope.session_id } : {}),
      ...(scope.run_id ? { run_id: scope.run_id } : {}),
      ...(this.revision && !UNREVISED_TYPES.has(type)
        ? { capability_revision: this.revision }
        : {}),
      payload,
    };
    this.child.stdin.write(`${JSON.stringify(envelope)}\n`);
  }

  subscribe(listener: OapFrameListener): () => void {
    this.listeners.add(listener);
    if (this.failure) listener(this.failure);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.fail(new Error('OAP client closed'));
    child.stdin.end();
    child.kill('SIGTERM');
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.dispatch(line);
      newline = this.buffer.indexOf('\n');
    }
  }

  private dispatch(line: string): void {
    let envelope: OapEnvelope;
    try {
      envelope = JSON.parse(line) as OapEnvelope;
    } catch {
      this.fail(new Error('OAP endpoint wrote a line that is not JSON'));
      return;
    }
    const waiting = envelope.in_reply_to ? this.pending.get(envelope.in_reply_to) : undefined;
    if (waiting && envelope.in_reply_to) {
      clearTimeout(waiting.timer);
      this.pending.delete(envelope.in_reply_to);
      waiting.resolve(envelope);
      return;
    }
    for (const listener of this.listeners) listener(envelope);
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.pending.clear();
    for (const listener of this.listeners) listener(error);
  }
}
