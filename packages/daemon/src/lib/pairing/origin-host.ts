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

const hostname = (host: string) => host.replace(/:\d+$/, '').toLowerCase();

export function judgeOriginHost(req: Request, allowedHosts: readonly string[]): WouldRefuse | null {
  const allowed = new Set([...LOOPBACK_HOSTS, ...allowedHosts.map(hostname)]);
  const host = req.headers.get('host');
  const origin = req.headers.get('origin');
  const kind =
    req.method === 'OPTIONS'
      ? 'preflight'
      : req.headers.get('upgrade')?.toLowerCase() === 'websocket'
        ? 'ws'
        : 'http';
  if (!host || !allowed.has(hostname(host)))
    return { reason: 'host_not_allowed', kind, host, origin };
  if (origin === null) return null;
  const parsed = URL.canParse(origin) ? new URL(origin) : null;
  const sameKind = parsed?.protocol === 'http:' || parsed?.protocol === 'https:';
  return sameKind && allowed.has(hostname(parsed.host))
    ? null
    : { reason: 'origin_not_allowed', kind, host, origin };
}

export function createRequestObserver({
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
  return (req: Request): void => {
    try {
      if (exempt(req)) return;
      const refusal = judgeOriginHost(req, []) && judgeOriginHost(req, allowedHosts());
      if (refusal)
        void db().run(recordWouldRefuse, { seen: refusal, now: now() }).catch(noteFailure);
    } catch (error) {
      noteFailure(error);
    }
  };
}
