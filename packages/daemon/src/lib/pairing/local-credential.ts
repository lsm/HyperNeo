import { constants, openSync, fstatSync, readFileSync, closeSync, lstatSync } from 'node:fs';
import NodeWebSocket from 'ws';
import { mkdir, open } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { getDataDir } from '../data-dir.ts';
import type { DbGateway } from '../../storage/db-gateway/db-gateway.ts';
import { enrollLocalDevice } from '../../storage/repositories/device-pairing-repository.ts';
import { checkWindowsCredential } from './local-credential-permissions.ts';

export const localCredentialPath = () => join(getDataDir(), 'local-rpc.credential');

export function readLocalCredential(path = localCredentialPath()): string {
  if (lstatSync(path).isSymbolicLink()) throw new Error('Local credential cannot be a symlink.');
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(file);
    if (
      !stat.isFile() ||
      stat.size > 64 ||
      (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) ||
      (process.platform !== 'win32' && process.getuid && stat.uid !== process.getuid())
    )
      throw new Error('Local RPC credential must be an owner-only regular file.');
    if (process.platform === 'win32')
      checkWindowsCredential(
        path,
        false,
        `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`
      );
    const credential = readFileSync(file, 'utf8').trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error('Invalid local RPC credential.');
    return credential;
  } finally {
    closeSync(file);
  }
}

export function createLocalSocket(url: string, path = localCredentialPath()): WebSocket {
  return new NodeWebSocket(url, {
    headers: { authorization: `Bearer ${readLocalCredential(path)}` },
  }) as unknown as WebSocket;
}

export async function ensureLocalCredential(db: DbGateway): Promise<void> {
  await mkdir(getDataDir(), { recursive: true, mode: 0o700 });
  try {
    const file = await open(localCredentialPath(), 'wx', 0o600);
    try {
      if (process.platform === 'win32') checkWindowsCredential(localCredentialPath(), true);
      await file.writeFile(randomBytes(32).toString('base64url'));
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await db.run(enrollLocalDevice, { credential: await readLocalCredential(), now: Date.now() });
}
