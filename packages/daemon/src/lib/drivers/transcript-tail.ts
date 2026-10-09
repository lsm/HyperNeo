import { open } from 'node:fs/promises';

export async function readTailLines(
  path: string,
  bytes: number
): Promise<{ lines: string[]; truncated: boolean }> {
  const handle = await open(path, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    return { lines: start > 0 ? lines.slice(1) : lines, truncated: start > 0 };
  } finally {
    await handle.close();
  }
}
