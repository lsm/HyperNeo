import type { SpawnFn, SpawnOptions, SpawnProcess } from './types';

interface BunSubprocess {
  readonly pid: number;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal?: string): void;
}

declare const Bun: {
  spawn(args: string[], options: SpawnOptions): BunSubprocess;
};

export function createBunSpawn(): SpawnFn {
  return (args: string[], options?: SpawnOptions): SpawnProcess => Bun.spawn(args, options ?? {});
}
