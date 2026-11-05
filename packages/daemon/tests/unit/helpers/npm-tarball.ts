import { createHash } from 'node:crypto';
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const BLOCK = 512;

type TarFile = { path: string; body: string; mode?: number; prefix?: string };

function header({ path, body, mode = 0o644, prefix = '' }: TarFile): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(path, 0);
  block.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
  block.write(`${Buffer.byteLength(body).toString(8).padStart(11, '0')}\0`, 124);
  block.write('0', 156);
  block.write(prefix, 345);
  return block;
}

export function npmTarball(files: readonly TarFile[]): Buffer {
  const parts = files.flatMap((file) => {
    const body = Buffer.from(file.body);
    const padding = Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK);
    return [header(file), body, padding];
  });
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(BLOCK * 2)]));
}

export function integrityOf(tarball: Buffer): string {
  return `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
}

export function installFakeCurl(
  directory: string,
  tarball: Buffer,
  integrity = integrityOf(tarball),
  downloadExit = 0
): { log: string; path: string } {
  const tarballPath = join(directory, 'fixture.tgz');
  const log = join(directory, 'curl.log');
  const script = join(directory, 'curl');
  writeFileSync(tarballPath, tarball);
  writeFileSync(
    script,
    `#!/bin/sh
if [ "$7" != "-fL" ] && [ "$8" != "-fL" ]; then
  printf '{"dist":{"tarball":"https://registry.test/fixture.tgz","integrity":"${integrity}"}}'
  exit 0
fi
echo "$*" >> "${log}"
while [ "$1" != "-o" ]; do shift; done
cp "${tarballPath}" "$2"
exit ${downloadExit}
`
  );
  chmodSync(script, 0o755);
  return { log, path: `${directory}:/usr/bin:/bin` };
}
