import { DEVICE_COOKIE } from './upgrade-auth.ts';
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

const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

function deviceCookie(credential: string, origin: string): string {
  return [
    `${DEVICE_COOKIE}=${credential}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    ...(origin.startsWith('https://') ? ['Secure'] : []),
  ].join('; ');
}

function answerPaired(
  req: Request,
  paired: { device: { id: string; kind: string }; credential: string }
): Response {
  const origin = req.headers.get('origin');
  const device = { deviceId: paired.device.id, kind: paired.device.kind };
  if (!origin) return answer(200, { ...device, credential: paired.credential });
  const response = answer(200, device);
  response.headers.set('set-cookie', deviceCookie(paired.credential, origin));
  return response;
}

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
    const { paired, awaitingApproval } = await repo.redeemAsync(
      parsed.data.code,
      parsed.data.name,
      at
    );
    if (paired) return answerPaired(req, paired);
    if (awaitingApproval) return answer(403, { error: 'awaiting_approval' });
    limiter.fail(at);
    return answer(401, { error: 'invalid_code' });
  };
}
