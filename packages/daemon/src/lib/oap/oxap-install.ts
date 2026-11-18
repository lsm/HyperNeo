import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { GlobalSettings } from '@hyperneo/shared';

export const OXAP_VERSION = '0.1.0-alpha.34';
const RELEASE = `https://github.com/lsm/oxap/releases/download/v${OXAP_VERSION}`;

export type OxapHubBinary = NonNullable<GlobalSettings['oxapHub']>;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export function releaseName(platform = process.platform, arch = process.arch): string {
  const os = { darwin: 'macos', linux: 'linux' }[platform as string];
  const cpu = { arm64: 'arm64', x64: 'x64' }[arch as string];
  if (!os || !cpu) throw new Error(`OXAP has no release for ${platform}-${arch}`);
  return `oxap-${OXAP_VERSION}-${os}-${cpu}`;
}

export function publishedSum(sums: string, asset: string): string {
  const line = sums.split('\n').find((entry) => entry.trim().split(/\s+\*?/)[1] === asset);
  const sum = line?.trim().split(/\s+/)[0]?.toLowerCase();
  if (!sum || !/^[a-f0-9]{64}$/.test(sum))
    throw new Error(`SHA256SUMS.txt has no entry for ${asset}`);
  return sum;
}

async function download(fetcher: typeof fetch, url: string): Promise<Uint8Array> {
  const response = await fetcher(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`OXAP download failed: ${response.status} ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function installOxapHub(
  directory: string,
  installed: OxapHubBinary | undefined,
  fetcher: typeof fetch = fetch,
  name = releaseName()
): Promise<OxapHubBinary> {
  if (installed?.version === name) {
    const current = await readFile(installed.path).catch(() => undefined);
    if (current && sha256(current) === installed.sha256) return installed;
  }
  const asset = `${name}.tar.gz`;
  const expected = publishedSum(
    new TextDecoder().decode(await download(fetcher, `${RELEASE}/SHA256SUMS.txt`)),
    asset
  );
  const archive = await download(fetcher, `${RELEASE}/${asset}`);
  if (sha256(archive) !== expected)
    throw new Error(`${asset} does not match the release's SHA256SUMS.txt`);
  const target = join(directory, name);
  await mkdir(target, { recursive: true, mode: 0o700 });
  await writeFile(join(target, asset), archive, { mode: 0o600 });
  await promisify(execFile)('tar', ['-xzf', join(target, asset), '-C', target, 'oxap']);
  const path = join(target, 'oxap');
  return { path, version: name, sha256: sha256(await readFile(path)) };
}
