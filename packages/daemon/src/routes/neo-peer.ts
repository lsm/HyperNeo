import { randomBytes } from 'node:crypto';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';
import type { DbGateway } from '../storage/db-gateway/db-gateway.ts';
import { peerWrites } from '../storage/repositories/neo-peer-repository.ts';
import { createPairingLimiter } from '../lib/pairing/pairing-limiter.ts';

const Input = z.object({ code: z.string().min(1).max(64) }).strict();
const answer = (status: number, body: unknown) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
export function readBody(req: Pick<Request, 'body'>, limit = 1024): Promise<unknown> {
  let size = 0;
  const body = req.body?.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > limit) throw new Error('Pair request too large');
        controller.enqueue(chunk);
      },
    })
  );
  return new Response(body).json().catch(() => null);
}
const admitRequest = (allowed: boolean) =>
  allowed ? { value: true } : { reason: answer(429, { error: 'rate_limited' }) };
function parse(body: unknown) {
  const parsed = Input.safeParse(body);
  if (parsed.success) return { value: parsed.data };
  return { reason: answer(400, { error: 'invalid_request' }) };
}
type Claim = { credential: string; claimed: boolean };
const receipt = ({ credential, claimed }: Claim) =>
  claimed ? answer(200, { credential }) : answer(401, { error: 'invalid_invite' });
export function createPeerPairRoute(db: DbGateway) {
  const limiter = createPairingLimiter();
  const run = (superpipe({})('neo.peer.pair') as PipelineAPI)
    .input(['req'])
    .pipe(() => limiter.admit(Date.now()).ok, 'req', 'allowed')
    .pipe(admitRequest, 'allowed', 'result:pair')
    .pipe((req: Request) => readBody(req), ['req', 'pair'], 'body')
    .pipe(parse, 'body', 'result:pair')
    .pipe(
      async ({ code }: z.infer<typeof Input>) => {
        const credential = randomBytes(32).toString('hex');
        const claimed = await db.call(peerWrites, 'claim', code, credential);
        return { credential, claimed };
      },
      'pair',
      'claimed'
    )
    .pipe(receipt, 'claimed', 'pair')
    .endAsync('pair') as (req: Request) => Promise<Response>;
  return async (req: Request) => {
    const response = await run(req);
    if (response.status === 400 || response.status === 401) limiter.fail(Date.now());
    return response;
  };
}
