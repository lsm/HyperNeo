import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import { Database } from '../../../storage/sqlite-compat.ts';
import { DirectTaskExecutionRepository } from '../../../storage/repositories/direct-task-execution-repository.ts';
import {
  DirectProcessOwnershipRepository,
  type DirectProcessIdentity,
} from '../../../storage/repositories/direct-process-ownership-repository.ts';
import {
  decideDirectGuardianTransition,
  type DirectGuardianEvent,
  type DirectGuardianState,
} from './direct-guardian-protocol.ts';

export interface DirectGuardianInput {
  dbPath: string;
  launch: DirectProcessIdentity;
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export async function runDirectGuardian(
  input: DirectGuardianInput,
  control: Readable,
  replies: Writable,
  stdin: Readable,
  stdout: Writable
): Promise<void> {
  const db = new Database(input.dbPath);
  const ledger = new DirectProcessOwnershipRepository(db);
  const attempts = new DirectTaskExecutionRepository(db);
  const instance = randomUUID();
  if (!ledger.claimGuardian(input.launch, instance)) {
    db.close();
    control.destroy();
    replies.end();
    throw new Error('Direct launch already has a guardian or is unavailable');
  }
  await new Promise<void>((resolve) => {
    let state: DirectGuardianState = 'waiting';
    let sdk: ChildProcess | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let buffer = '';
    let terminal: 'exited' | 'never_started' | undefined;
    const send = (message: Record<string, unknown>) => {
      if (!replies.destroyed && replies.writable) {
        try {
          replies.write(`${JSON.stringify(message)}\n`);
        } catch {
          handle({ kind: 'parent_closed' });
        }
      }
    };
    const writeReceipt = () => {
      try {
        if (terminal && ledger.recordGuardianTerminal(input.launch, instance, terminal)) {
          send({ kind: 'root_receipt', state: terminal });
          control.destroy();
          replies.end();
          db.close();
          resolve();
          return;
        }
      } catch {}
      setTimeout(writeReceipt, 100);
    };
    const stopRoot = () => {
      if (!sdk || sdk.exitCode !== null || sdk.signalCode !== null) return;
      try {
        sdk.kill('SIGTERM');
      } catch {}
      killTimer ??= setTimeout(() => {
        if (sdk && sdk.exitCode === null && sdk.signalCode === null)
          try {
            sdk.kill('SIGKILL');
          } catch {}
      }, 1000);
    };
    const startRoot = () => {
      try {
        sdk = spawn(input.command, input.args, {
          cwd: input.cwd,
          env: input.env,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'ignore'],
        });
        sdk.once('spawn', () => {
          handle({ kind: 'sdk_started' });
          send({ kind: 'root_started', pid: sdk?.pid });
        });
        sdk.once('error', () => handle({ kind: 'spawn_failed' }));
        sdk.once('exit', () => handle({ kind: 'sdk_exited' }));
        sdk.stdin?.on('error', () => {});
        sdk.stdout?.on('error', () => handle({ kind: 'parent_closed' }));
        if (sdk.stdin) stdin.pipe(sdk.stdin);
        sdk.stdout?.pipe(stdout, { end: false });
      } catch {
        handle({ kind: 'spawn_failed' });
      }
    };
    const handle = (event: DirectGuardianEvent) => {
      const next = decideDirectGuardianTransition(input.launch, state, event);
      state = next.state;
      if (next.action === 'spawn') startRoot();
      if (next.action === 'stop') stopRoot();
      if (next.action === 'record_exited' || next.action === 'record_never_started') {
        if (killTimer) clearTimeout(killTimer);
        terminal = next.action === 'record_exited' ? 'exited' : 'never_started';
        writeReceipt();
      }
    };
    replies.on('error', () => handle({ kind: 'parent_closed' }));
    control.on('error', () => handle({ kind: 'parent_closed' }));
    control.on('end', () => handle({ kind: 'parent_closed' }));
    control.on('close', () => handle({ kind: 'parent_closed' }));
    stdin.on('error', () => handle({ kind: 'parent_closed' }));
    stdout.on('error', () => handle({ kind: 'parent_closed' }));
    control.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > 8192) {
        handle({ kind: 'parent_closed' });
        return;
      }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const frame = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        try {
          const message = JSON.parse(frame);
          if (message.kind !== 'go' || state !== 'waiting') continue;
          const authorization = ledger.get(input.launch);
          const current = attempts.get(input.launch.attemptId);
          if (
            !authorization ||
            authorization.guardianInstance !== instance ||
            !current ||
            current.phase !== 'running' ||
            current.sessionId !== input.launch.sessionId ||
            current.generation !== input.launch.generation ||
            attempts.isStopRequested(current.id, current.sessionId)
          ) {
            handle({ kind: 'parent_closed' });
            continue;
          }
          handle({ kind: 'go', authorization });
        } catch {
          handle({ kind: 'parent_closed' });
        }
      }
    });
    send({ kind: 'ready', instance });
  });
}
