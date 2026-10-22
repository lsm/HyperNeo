import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let bodyAdmissionGate: Promise<void> | undefined;

export const sdkBodyAdmissionGate = () => bodyAdmissionGate;

export function holdSdkBodyAdmission(): () => void {
  let release!: () => void;
  bodyAdmissionGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    bodyAdmissionGate = undefined;
    release();
  };
}

export class SDKBunWorkerBridge {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private child: ChildProcess;
  private stopped = false;
  private ready = false;
  private queued: unknown[] = [];

  constructor(url: string, startGate?: Promise<void>) {
    const home = mkdtempSync(join(tmpdir(), 'sdk-worker-host-'));
    this.child = spawn(
      'bun',
      [fileURLToPath(new URL('./sdk-bun-worker-host.ts', import.meta.url)), url],
      {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: {
          PATH: process.env.PATH,
          HOME: home,
          HYPERNEO_DATA_DIR: join(home, 'data'),
          NODE_ENV: 'test',
        },
      }
    );
    this.child.on('message', (message: unknown) => {
      const reply = message as { ready?: boolean; data?: unknown; error?: string };
      if (reply.ready) {
        void (startGate ?? Promise.resolve()).then(() => {
          if (this.stopped) return;
          this.ready = true;
          for (const pending of this.queued) this.child.send(pending);
          this.queued = [];
        });
      } else if (reply.error) this.fail(reply.error);
      else this.onmessage?.({ data: reply.data } as MessageEvent);
    });
    this.child.on('error', (error) => this.fail(error.message));
    this.child.on('exit', (code) => {
      rmSync(home, { recursive: true, force: true });
      this.fail(`Bun worker host exited: ${code}`);
    });
  }

  postMessage(data: unknown) {
    if (this.ready) this.child.send(data);
    else this.queued.push(data);
  }

  terminate() {
    this.stopped = true;
    this.child.kill('SIGTERM');
  }

  private fail(message: string) {
    if (!this.stopped) this.onerror?.({ message, preventDefault() {} } as ErrorEvent);
  }
}
