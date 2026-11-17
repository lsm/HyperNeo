import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { getDataDir } from '../data-dir.ts';
import type { DbGateway } from '../../storage/db-gateway/db-gateway.ts';
import {
  pairingRequestReads,
  pairingRequestWrites,
} from '../../storage/repositories/pairing-request-repository.ts';
import { checkWindowsCredential } from './local-credential-permissions.ts';
import { answerPaired, readBoundedText } from './pair-route.ts';
import type { PairingLimiter } from './pairing-limiter.ts';

export const setupTokenPath = (dataDir = getDataDir()) => join(dataDir, 'setup-token');

export interface SetupLink {
  readonly token: string;
  readonly window: string;
  readonly path: string;
}

export async function mintSetupToken(
  db: DbGateway,
  path = setupTokenPath()
): Promise<SetupLink | null> {
  const window = await db.call(pairingRequestReads, 'setupWindow');
  if (!window) {
    await rm(path, { force: true });
    return null;
  }
  const token = randomBytes(32).toString('base64url');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      if (process.platform === 'win32') checkWindowsCredential(temporary, true);
      await file.writeFile(token);
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return { token, window, path };
}

const SetupRequest = z.object({
  token: z.string().max(80),
  name: z.string().trim().min(1).max(80).optional(),
});

const digest = (value: string) => createHash('sha256').update(value).digest();

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export interface SetupRouteDeps {
  readonly db: DbGateway;
  readonly limiter: PairingLimiter;
  readonly now: () => number;
  readonly link: () => SetupLink | null;
}

export function createSetupRoute({ db, limiter, now, link }: SetupRouteDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return answer(405, { error: 'method_not_allowed' });
    const admitted = limiter.admit(now());
    if (!admitted.ok)
      return answer(429, { error: admitted.error, retryAfterMs: admitted.retryAfterMs });
    const text = await readBoundedText(req);
    let body: unknown = null;
    try {
      body = text === null ? null : JSON.parse(text);
    } catch {}
    const parsed = SetupRequest.safeParse(body);
    const expected = link();
    if (
      !parsed.success ||
      !expected ||
      !timingSafeEqual(digest(parsed.data.token), digest(expected.token))
    ) {
      limiter.fail(now());
      return answer(401, { error: 'invalid_token' });
    }
    const granted = await db.call(
      pairingRequestWrites,
      'grantSetupDevice',
      parsed.data.name ?? 'First device',
      expected.window,
      now()
    );
    if (!granted)
      return (await db.call(pairingRequestReads, 'setupWindow'))
        ? answer(401, { error: 'invalid_token' })
        : answer(409, { error: 'has_owner' });
    await rm(expected.path, { force: true });
    return answerPaired(req, {
      device: { id: granted.deviceId, kind: 'human' },
      credential: granted.credential,
    });
  };
}
