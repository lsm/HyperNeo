import { constants, openSync, fstatSync, readFileSync, closeSync, lstatSync } from 'node:fs';
import NodeWebSocket from 'ws';
import { mkdir, open, link, rm, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { getDataDir } from '../data-dir.ts';
import { hasOtherRuntimeOwner } from '../runtime-descriptor.ts';
import type { DbGateway } from '../../storage/db-gateway/db-gateway.ts';
import { enrollLocalDevice } from '../../storage/repositories/device-pairing-repository.ts';
import { checkWindowsCredential } from './local-credential-permissions.ts';

export const localCredentialPath = () => join(getDataDir(), 'local-rpc.credential');
export const agentReadCredentialPath = (dataDir = getDataDir()) =>
  join(dataDir, 'agent-read.credential');

export function readLocalCredential(path = localCredentialPath(), origin?: string | null): string {
  if (lstatSync(path).isSymbolicLink()) throw new Error('Local credential cannot be a symlink.');
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(file);
    if (
      !stat.isFile() ||
      stat.size > (origin === undefined ? 64 : 4096) ||
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
    let credential = readFileSync(file, 'utf8').trim();
    if (origin !== undefined) {
      const bound = JSON.parse(credential) as { credential?: string; origin?: string } | null;
      if (origin !== null && bound?.origin !== origin)
        throw new Error('Card link origin does not match this agent credential.');
      credential = bound?.credential ?? '';
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error('Invalid local RPC credential.');
    return credential;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Invalid bound agent credential.');
    throw error;
  } finally {
    closeSync(file);
  }
}

export function createLocalSocket(url: string, path = localCredentialPath()): WebSocket {
  return new NodeWebSocket(url, {
    headers: { authorization: `Bearer ${readLocalCredential(path)}` },
  }) as unknown as WebSocket;
}

export async function ensureLocalCredential(
  db: DbGateway,
  kind: 'human' | 'agent' = 'human',
  origin?: string
): Promise<void> {
  if (kind === 'agent' && hasOtherRuntimeOwner()) return;
  await mkdir(getDataDir(), { recursive: true, mode: 0o700 });
  const path = kind === 'agent' ? agentReadCredentialPath() : localCredentialPath();
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      if (process.platform === 'win32') checkWindowsCredential(temporary, true);
      const credential = randomBytes(32).toString('base64url');
      await file.writeFile(kind === 'agent' ? JSON.stringify({ credential, origin }) : credential);
    } finally {
      await file.close();
    }
    try {
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (kind === 'agent') {
        const credential = readLocalCredential(path, null);
        await writeFile(temporary, JSON.stringify({ credential, origin }));
        await rename(temporary, path);
      }
    }
  } finally {
    await rm(temporary, { force: true });
  }
  const credential = readLocalCredential(path, kind === 'agent' ? origin : undefined);
  await db.run(enrollLocalDevice, { credential, now: Date.now(), kind });
}
