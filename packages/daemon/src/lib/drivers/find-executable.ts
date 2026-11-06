import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export function findExecutable(bin: string, path = process.env.PATH ?? ''): string | null {
  for (const dir of path.split(delimiter)) {
    if (dir && existsSync(join(dir, bin))) return join(dir, bin);
  }
  return null;
}
