import { createHash, randomBytes } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { DbGateway } from '../storage/db-gateway/db-gateway.ts';
import {
  peerReads,
  peerWrites,
  type NeoPeer,
} from '../storage/repositories/neo-peer-repository.ts';
import { createPairingLimiter } from '../lib/pairing/pairing-limiter.ts';
import { readPeerPairingJson } from '../lib/neo/peer-operations.ts';

const Input = z.object({ code: z.string().min(1).max(64) }).strict();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const answer = (status: number, body: unknown) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store' },
  });
function admitInvite(peer: NeoPeer | null, at: number) {
  return peer?.inviteHash && peer.expiresAt !== null && peer.expiresAt > at
    ? { value: peer }
    : { reason: answer(401, { error: 'invalid_invite' }) };
}

export function createPeerPairRoute(db: DbGateway, now = Date.now) {
  const limiter = createPairingLimiter();
  const run = (superpipe({})('neo.peer.pair') as PipelineAPI)
    .input(['req'])
    .pipe(
      (req: Request) =>
        req.method === 'POST'
          ? { value: req }
          : { reason: answer(405, { error: 'method_not_allowed' }) },
      'req',
      'result:pair'
    )
    .pipe(
      (req: Request) => {
        const admitted = limiter.admit(now());
        return admitted.ok ? { value: req } : { reason: answer(429, { error: admitted.error }) };
      },
      'pair',
      'result:pair'
    )
    .pipe((req: Request) => readPeerPairingJson(req.body), 'pair', 'input')
    .pipe(
      (input: unknown) => {
        const parsed = Input.safeParse(input);
        return parsed.success
          ? { value: hash(parsed.data.code) }
          : { reason: answer(400, { error: 'invalid_request' }) };
      },
      'input',
      'result:pair'
    )
    .pipe((digest: string) => db.call(peerReads, 'invitation', digest), 'pair', 'peer')
    .pipe(() => now(), 'peer', 'at')
    .pipe(admitInvite, ['peer', 'at'], 'result:pair')
    .pipe(
      async (peer: NeoPeer, at: number) => {
        const credential = randomBytes(32).toString('hex');
        return (await db.call(peerWrites, 'claim', peer.id, peer.inviteHash!, at, hash(credential)))
          ? answer(200, { credential })
          : answer(401, { error: 'invalid_invite' });
      },
      ['pair', 'at'],
      'pair'
    )
    .endAsync('pair') as (req: Request) => Promise<Response>;
  return async (req: Request) => {
    const response = await run(req);
    if (response.status === 400 || response.status === 401) limiter.fail(now());
    return response;
  };
}
