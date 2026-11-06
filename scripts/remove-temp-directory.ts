import { rmSync } from 'node:fs';

export async function removeTempDirectory(path: string): Promise<void> {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
