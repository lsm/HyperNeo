import type { HomeFailure } from './conflicts.ts';
import { z } from 'zod';

export const HomeReadInput = z.object({
  path: z.string().min(1),
  includeRemote: z.boolean().optional(),
});
export const HomeReadResult = z.union([
  z.object({ ok: z.literal(false), reason: z.string(), questionId: z.string().optional() }),
  z.object({
    ok: z.literal(true),
    path: z.string(),
    content: z.string(),
    sha256: z.string(),
    remoteUrl: z.string().nullable().optional(),
  }),
]);
export type HomeReadInput = z.infer<typeof HomeReadInput>;
export type HomeReadResult = z.infer<typeof HomeReadResult> | HomeFailure;

export function homeRemoteUrl(remote: string): string | null {
  try {
    const scp = remote.match(/^[^@/]+@([^:]+):(.+)$/);
    let url = new URL(scp ? `https://${scp[1]}/${scp[2]}` : remote);
    if (url.protocol === 'ssh:') url = new URL(`https://${url.hostname}${url.pathname}`);
    if (!['https:', 'http:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    url.pathname = url.pathname.replace(/\.git\/?$/, '');
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}
