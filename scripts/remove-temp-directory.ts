import { rmSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

function retryWindowsLock(platform: string, code: string | undefined, attempt: number): boolean {
  return (
    platform === 'win32' && attempt < 5 && ['EBUSY', 'EPERM', 'ENOTEMPTY'].includes(code ?? '')
  );
}

export async function removeTempDirectory(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(path, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!retryWindowsLock(process.platform, (error as NodeJS.ErrnoException).code, attempt)) {
        throw error;
      }
      await setTimeout((attempt + 1) * 100);
    }
  }
}
