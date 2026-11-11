import { z } from 'zod';
import type { DbGateway } from '../../storage/db-gateway/db-gateway.ts';
import { readBoundedText } from './pair-route.ts';
import {
  pairingRequestReads,
  pairingRequestWrites,
} from '../../storage/repositories/pairing-request-repository.ts';
import type { PairingLimiter } from './pairing-limiter.ts';

export interface Pair2Identity {
  deviceId: string;
  kind: 'human' | 'relay' | 'daemon' | 'agent';
}

export interface Pair2RouteDeps {
  readonly db: DbGateway;
  readonly limiter: PairingLimiter;
  readonly now: () => number;
  readonly authenticate: (
    req: Request,
    remoteAddress: string | null
  ) => Promise<Pair2Identity | null>;
}

const BindBody = z.object({
  ticket: z.string().trim().min(16).max(80),
  phoneKey: z.string().trim().min(16).max(80),
  name: z.string().trim().min(1).max(80).optional(),
});
const RequestBody = z.object({
  requestId: z.string().trim().min(8).max(80),
});
const CompleteBody = RequestBody.extend({
  phoneKey: z.string().trim().min(16).max(80),
  signature: z.string().trim().min(16).max(200),
});

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

async function readJson(req: Request): Promise<unknown | null> {
  const text = await readBoundedText(req);
  if (text === null) return null;
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

export function createPair2Route({ db, limiter, now, authenticate }: Pair2RouteDeps) {
  const mayApprove = async (req: Request, remoteAddress: string | null) => {
    const identity = await authenticate(req, remoteAddress);
    return identity && identity.kind === 'human' ? identity : null;
  };

  return async (req: Request, remoteAddress: string | null = null): Promise<Response> => {
    const url = new URL(req.url);
    const admitted = limiter.admit(now());
    if (!admitted.ok) {
      return answer(429, { error: admitted.error, retryAfterMs: admitted.retryAfterMs });
    }

    if (url.pathname === '/pair2/status' && req.method === 'GET') {
      const status = await db.call(
        pairingRequestReads,
        'requestStatus',
        url.searchParams.get('requestId') ?? '',
        now()
      );
      return status ? answer(200, status) : answer(404, { error: 'not_found' });
    }
    if (req.method !== 'POST') return answer(405, { error: 'method_not_allowed' });

    if (url.pathname === '/pair2/bind') {
      const parsed = BindBody.safeParse(await readJson(req));
      if (!parsed.success) {
        limiter.fail(now());
        return answer(400, { error: 'invalid_request' });
      }
      const bound = await db.call(
        pairingRequestWrites,
        'bindTicket',
        parsed.data.ticket,
        parsed.data.phoneKey,
        parsed.data.name ?? null,
        now()
      );
      if (!bound.ok) {
        limiter.fail(now());
        return answer(403, { error: 'ticket_unusable' });
      }
      return answer(200, bound);
    }

    if (url.pathname === '/pair2/request') {
      const identity = await authenticate(req, remoteAddress);
      if (!identity || identity.kind !== 'human') return answer(403, { error: 'not_allowed' });
      return answer(200, await db.call(pairingRequestWrites, 'createRequest', now()));
    }

    const parsed = (url.pathname === '/pair2/complete' ? CompleteBody : RequestBody).safeParse(
      await readJson(req)
    );
    if (!parsed.success) {
      limiter.fail(now());
      return answer(400, { error: 'invalid_request' });
    }

    if (url.pathname === '/pair2/approve') {
      const identity = await mayApprove(req, remoteAddress);
      if (!identity) return answer(403, { error: 'not_allowed' });
      const outcome = await db.call(
        pairingRequestWrites,
        'approveRequest',
        parsed.data.requestId,
        identity.deviceId,
        now()
      );
      return outcome === 'approved' ? answer(200, { ok: true }) : answer(403, { error: outcome });
    }

    if (url.pathname === '/pair2/deny') {
      const identity = await authenticate(req, remoteAddress);
      if (!identity || identity.kind !== 'human') return answer(403, { error: 'not_allowed' });
      return (await db.call(pairingRequestWrites, 'denyRequest', parsed.data.requestId, now()))
        ? answer(200, { ok: true })
        : answer(403, { error: 'not_pending' });
    }

    if (url.pathname === '/pair2/cancel') {
      const identity = await authenticate(req, remoteAddress);
      if (!identity || identity.kind !== 'human') return answer(403, { error: 'not_allowed' });
      return (await db.call(pairingRequestWrites, 'cancelRequest', parsed.data.requestId, now()))
        ? answer(200, { ok: true })
        : answer(403, { error: 'not_pending' });
    }

    if (url.pathname === '/pair2/complete') {
      const body = parsed.data as z.infer<typeof CompleteBody>;
      const outcome = await db.call(
        pairingRequestWrites,
        'completeRequest',
        body.requestId,
        body.phoneKey,
        body.signature,
        now()
      );
      if (outcome.ok) return answer(200, outcome);
      if (outcome.reason === 'used') return answer(409, { error: outcome.reason });
      if (outcome.reason !== 'not_approved') limiter.fail(now());
      return answer(403, { error: outcome.reason });
    }

    return answer(404, { error: 'not_found' });
  };
}
