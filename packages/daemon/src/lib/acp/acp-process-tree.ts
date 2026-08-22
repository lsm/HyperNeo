import type { ChildProcess } from 'node:child_process';

export interface AcpProcessTree {
  terminate(signal: NodeJS.Signals): void;
}

export type AcpProcessTreeOwner = (child: ChildProcess) => AcpProcessTree;

export const basicAcpProcessTreeOwner: AcpProcessTreeOwner = (child) => ({
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

export function getAcpProcessTreeOwner(): Promise<AcpProcessTreeOwner> {
  return Promise.resolve(basicAcpProcessTreeOwner);
}
