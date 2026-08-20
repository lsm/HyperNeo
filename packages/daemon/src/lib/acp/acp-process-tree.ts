import type { ChildProcess } from 'node:child_process';

export interface AcpProcessTree {
  terminate(signal: NodeJS.Signals): void;
}

export type AcpProcessTreeOwner = (child: ChildProcess) => AcpProcessTree;

export const basicAcpProcessTreeOwner: AcpProcessTreeOwner = (child) => ({
  terminate: (signal) => {
    if (process.platform !== 'win32' && child.pid != null) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {}
    }
    child.kill(signal);
  },
});

let ownerPromise: Promise<AcpProcessTreeOwner> | undefined;

export function getAcpProcessTreeOwner(): Promise<AcpProcessTreeOwner> {
  if (process.platform !== 'win32') return Promise.resolve(basicAcpProcessTreeOwner);
  ownerPromise ??= import('./acp-process-tree-windows').then(
    ({ windowsAcpProcessTreeOwner }) => windowsAcpProcessTreeOwner
  );
  return ownerPromise;
}
