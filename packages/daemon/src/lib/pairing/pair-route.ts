import { z } from 'zod';
import type { DevicePairingRepository } from '../../storage/repositories/device-pairing-repository.ts';
import type { PairingLimiter } from './pairing-limiter.ts';

const PairRequest = z.object({
  code: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(80),
});

export interface PairRouteDeps {
  readonly repo: DevicePairingRepository;
  readonly limiter: PairingLimiter;
  readonly now: () => number;
}

const MAX_BODY_BYTES = 4 * 1024;

async function readBoundedText(req: Request): Promise<string | null> {
  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return null;
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export function createPairRoute({ repo, limiter, now }: PairRouteDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method !== 'POST') return answer(405, { error: 'method_not_allowed' });
    const admitted = limiter.admit(now());
    if (!admitted.ok)
      return answer(429, { error: admitted.error, retryAfterMs: admitted.retryAfterMs });
    const text = await readBoundedText(req);
    if (text === null) {
      limiter.fail(now());
      return answer(413, { error: 'request_too_large' });
    }
    const parsed = PairRequest.safeParse(parseJson(text));
    if (!parsed.success) {
      limiter.fail(now());
      return answer(400, { error: 'invalid_request' });
    }
    const at = now();
    const paired = repo.redeem(parsed.data.code, parsed.data.name, at);
    if (paired)
      return answer(200, {
        deviceId: paired.device.id,
        kind: paired.device.kind,
        credential: paired.credential,
      });
    if (repo.isAwaitingApproval(parsed.data.code, at))
      return answer(403, { error: 'awaiting_approval' });
    limiter.fail(at);
    return answer(401, { error: 'invalid_code' });
  };
}
