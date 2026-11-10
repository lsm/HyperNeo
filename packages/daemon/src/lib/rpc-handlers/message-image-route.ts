import superpipe, { type PipelineAPI } from 'superpipe';
import type { DbGateway } from '../../storage/db-gateway/db-gateway.ts';
import { singleMessageReads } from '../../storage/repositories/sdk-single-message-read.ts';
import type { UpgradeIdentity } from '../pairing/upgrade-auth.ts';

const IMAGE_PATH = /^\/api\/sessions\/([^/]+)\/messages\/([^/]+)\/images\/(\d+)$/;

type Target = { sessionId: string; uuid: string; index: number };
type Image = { mediaType: string; data: string };

const refused = (body: string, status: number) =>
  new Response(body, { status, headers: { 'Cache-Control': 'no-store' } });

function decodeTarget(path: RegExpExecArray): { value: Target } | { reason: Response } {
  try {
    return {
      value: {
        sessionId: decodeURIComponent(path[1]),
        uuid: decodeURIComponent(path[2]),
        index: Number(path[3]),
      },
    };
  } catch {
    return { reason: refused('Not found', 404) };
  }
}

export function createMessageImageHandler(
  authenticate: (req: Request, remoteAddress: string | null) => Promise<UpgradeIdentity | null>,
  gateway: () => DbGateway
): (req: Request, remoteAddress: string | null) => Promise<Response | null> {
  const read = (superpipe({})('message-image-http') as PipelineAPI)
    .input(['req', 'remoteAddress', 'path'])
    .pipe(authenticate, ['req', 'remoteAddress'], 'device')
    .pipe(
      (device: UpgradeIdentity | null) =>
        device ? { value: device } : { reason: refused('Device pairing required', 401) },
      'device',
      'result:response'
    )
    .pipe(decodeTarget, 'path', 'result:response')
    .pipe(
      ({ sessionId, uuid, index }: Target) =>
        gateway().call(singleMessageReads, 'image', sessionId, uuid, index),
      'response',
      'image'
    )
    .pipe(
      (image: Image | null) => (image ? { value: image } : { reason: refused('Not found', 404) }),
      'image',
      'result:response'
    )
    .pipe(
      ({ mediaType, data }: Image) =>
        new Response(Buffer.from(data, 'base64'), {
          headers: {
            'Content-Type': mediaType,
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        }),
      'response',
      'response'
    )
    .endAsync('response') as (
    req: Request,
    remoteAddress: string | null,
    path: RegExpExecArray
  ) => Promise<Response>;
  return async (req, remoteAddress) => {
    const path = IMAGE_PATH.exec(new URL(req.url).pathname);
    return req.method === 'GET' && path ? read(req, remoteAddress, path) : null;
  };
}
