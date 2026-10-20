import { open } from 'node:fs/promises';

export async function readTailLines(
  path: string,
  bytes: number
): Promise<{ lines: string[]; truncated: boolean; version: string }> {
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat({ bigint: true });
    const size = Number(stat.size);
    const version = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, bytes].join(':');
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString('utf8').split('\n');
    return { lines: start > 0 ? lines.slice(1) : lines, truncated: start > 0, version };
  } finally {
    await handle.close();
  }
}
