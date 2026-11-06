import type { ChildProcess } from 'node:child_process';

export interface ProcessTree {
  terminate(signal: NodeJS.Signals): void;
}

export type ProcessTreeOwner = (child: ChildProcess) => ProcessTree;

export const basicProcessTreeOwner: ProcessTreeOwner = (child) => ({
  terminate: (signal) => {
    if (child.pid != null) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {}
    }
    child.kill(signal);
  },
});

export function processGroupAlive(
  pid: number,
  platform: NodeJS.Platform = process.platform
): boolean {
  try {
    process.kill(platform === 'win32' ? pid : -pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
