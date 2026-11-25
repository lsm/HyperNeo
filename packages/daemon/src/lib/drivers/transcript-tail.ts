import { open } from 'node:fs/promises';

export async function readTailLines(
  path: string,
  bytes: number,
  since = 0
): Promise<{ lines: string[]; truncated: boolean }> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.min(size, Math.max(since, size - bytes));
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    return { lines: start > since ? lines.slice(1) : lines, truncated: start > since };
  } finally {
    await handle.close();
  }
}
