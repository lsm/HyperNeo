export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdout?: 'pipe' | 'ignore';
  stderr?: 'pipe' | 'ignore';
  detached?: boolean;
}

export type SpawnSignal = 'SIGKILL' | 'SIGTERM' | 'SIGINT';

export interface SpawnProcess {
  readonly pid?: number;
  readonly stdout: ReadableStream<Uint8Array> | null;
  readonly stderr: ReadableStream<Uint8Array> | null;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  kill(signal?: SpawnSignal): void;
}

export type SpawnFn = (args: string[], options?: SpawnOptions) => SpawnProcess;
