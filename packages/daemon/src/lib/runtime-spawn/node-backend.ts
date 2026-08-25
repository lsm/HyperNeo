import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { buildCommandEnv } from '../spawn-env.ts';
import type { SpawnFn, SpawnOptions, SpawnProcess, SpawnSignal } from './types.ts';

function toWebStream(stream: Readable | null): ReadableStream<Uint8Array> | null {
  if (!stream) return null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {}
      };
      stream.on('data', (chunk: Buffer) => {
        if (closed) return;
        try {
          controller.enqueue(new Uint8Array(chunk));
        } catch {
          close();
        }
      });
      stream.on('end', close);
      stream.on('close', close);
      stream.on('error', close);
    },
    cancel() {
      stream.destroy();
    },
  });
}

export function createNodeSpawn(): SpawnFn {
  return (args: string[], options?: SpawnOptions): SpawnProcess => {
    const child = spawn(args[0], args.slice(1), {
      cwd: options?.cwd,
      env: options?.env ?? buildCommandEnv(),
      stdio: ['ignore', options?.stdout ?? 'pipe', options?.stderr ?? 'pipe'],
      detached: options?.detached ?? false,
    });

    let exitCode: number | null = null;
    let settled = false;
    const exited = new Promise<number>((resolve) => {
      const settle = (code: number | null) => {
        if (settled) return;
        settled = true;
        exitCode = code;
        resolve(code ?? -1);
      };
      child.on('exit', (code) => settle(code));
      child.on('error', () => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        settle(null);
      });
    });

    return {
      pid: child.pid,
      stdout: toWebStream(child.stdout),
      stderr: toWebStream(child.stderr),
      exited,
      get exitCode() {
        return exitCode;
      },
      kill(signal?: SpawnSignal) {
        child.kill(signal);
      },
    };
  };
}
