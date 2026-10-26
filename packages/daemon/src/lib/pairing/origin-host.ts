import type { DbGateway } from '../../storage/db-gateway/db-gateway.ts';
import { Logger } from '../logger.ts';
import { recordWouldRefuse } from '../../storage/repositories/device-pairing-repository.ts';

const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const RECORD_FAILURE_LOG_INTERVAL_MS = 60_000;

const log = new Logger('origin-host');

export interface WouldRefuse {
  reason: 'host_not_allowed' | 'origin_not_allowed';
  kind: 'http' | 'ws' | 'preflight';
  host: string | null;
  origin: string | null;
}

const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];

const hostname = (host: string) => host.replace(/:\d+$/, '').toLowerCase();

const isUpgrade = (req: Request) => req.headers.get('upgrade')?.toLowerCase() === 'websocket';

export function judgeOriginHost(req: Request, allowedHosts: readonly string[]): WouldRefuse | null {
  const allowed = new Set([...LOOPBACK_HOSTS, ...allowedHosts.map(hostname)]);
  const host = req.headers.get('host');
  const origin = req.headers.get('origin');
  const kind = req.method === 'OPTIONS' ? 'preflight' : isUpgrade(req) ? 'ws' : 'http';
  if (!host || !allowed.has(hostname(host)))
    return { reason: 'host_not_allowed', kind, host, origin };
  if (origin === null) return null;
  const parsed = URL.canParse(origin) ? new URL(origin) : null;
  const sameKind = parsed?.protocol === 'http:' || parsed?.protocol === 'https:';
  return sameKind && allowed.has(hostname(parsed.host))
    ? null
    : { reason: 'origin_not_allowed', kind, host, origin };
}

function isCrossSite(req: Request, allowedHosts: () => readonly string[]): boolean {
  const origin = req.headers.get('origin');
  if (origin === null || (SAFE_METHODS.includes(req.method) && !isUpgrade(req))) return false;
  const parsed = URL.canParse(origin) ? new URL(origin) : null;
  if (parsed?.protocol !== 'http:' && parsed?.protocol !== 'https:') return true;
  const host = hostname(parsed.host);
  const own = req.headers.get('host');
  return (
    !(own !== null && hostname(own) === host) &&
    !LOOPBACK_HOSTS.includes(host) &&
    !allowedHosts().map(hostname).includes(host)
  );
}

export function createRequestGuard({
  db,
  allowedHosts,
  exempt,
  now,
}: {
  db: () => DbGateway;
  allowedHosts: () => readonly string[];
  exempt: (req: Request) => boolean;
  now: () => number;
}) {
  let loggedFailureAt = -Infinity;
  const noteFailure = (error: unknown) => {
    const at = now();
    if (at - loggedFailureAt < RECORD_FAILURE_LOG_INTERVAL_MS) return;
    loggedFailureAt = at;
    log.warn('could not record a request the Origin/Host checks would refuse:', error);
  };
  return (req: Request): Response | null => {
    if (exempt(req)) return null;
    try {
      const refusal = judgeOriginHost(req, []) && judgeOriginHost(req, allowedHosts());
      if (refusal)
        void db().run(recordWouldRefuse, { seen: refusal, now: now() }).catch(noteFailure);
    } catch (error) {
      noteFailure(error);
    }
    return isCrossSite(req, allowedHosts)
      ? new Response('Cross-site request refused', { status: 403 })
      : null;
  };
}
