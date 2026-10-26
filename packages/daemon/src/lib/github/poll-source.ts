import { fetchGitHubViaCli } from './gh-api-fetch.ts';
import { Logger } from '../logger.ts';

const log = new Logger('github-event-extension');

export type GitHubPollCollector = (
  subject: { credentialId: string; url: string; accept: string; apiVersion: string },
  cycle: string,
  validator: string | null,
  request: (validator: string | null) => Promise<Response>
) => Promise<Response>;

export interface GitHubRateLimitInfo {
  remaining: number;
  status?: number;
  limit?: number;
  resource?: string;
  resetAt: number;
  limited: boolean;
  retryAfter: boolean;
}

export function parseRateLimitHeaders(res: Response): GitHubRateLimitInfo {
  const limit = Number.parseInt(res.headers.get('X-RateLimit-Limit') ?? '', 10);
  const resource = res.headers.get('X-RateLimit-Resource');
  const remainingRaw = res.headers.get('X-RateLimit-Remaining');
  const resetRaw = res.headers.get('X-RateLimit-Reset');
  const retryAfterRaw = res.headers.get('Retry-After');
  const remaining = remainingRaw ? parseInt(remainingRaw, 10) : Number.NaN;
  const resetSeconds = resetRaw ? parseInt(resetRaw, 10) : Number.NaN;
  const retryAfterSeconds = retryAfterRaw ? parseInt(retryAfterRaw, 10) : Number.NaN;
  const expiredSuccess =
    (res.ok || res.status === 304) &&
    remaining === 0 &&
    Number.isFinite(resetSeconds) &&
    resetSeconds * 1000 <= Date.now() &&
    Number.isNaN(retryAfterSeconds);
  const remainingValue = Number.isNaN(remaining) || expiredSuccess ? Infinity : remaining;
  const hasRetryAfter = !Number.isNaN(retryAfterSeconds);
  const limited =
    res.status === 429 || (res.status === 403 && (remainingValue === 0 || hasRetryAfter));
  const resetAt = !Number.isNaN(retryAfterSeconds)
    ? Date.now() + retryAfterSeconds * 1000
    : Number.isNaN(resetSeconds)
      ? 0
      : resetSeconds * 1000;
  return {
    remaining: remainingValue,
    status: res.status,
    ...(Number.isFinite(limit) ? { limit } : {}),
    ...(resource
      ? {
          resource: ['core', 'graphql', 'search', 'code_search', 'integration_manifest'].includes(
            resource
          )
            ? resource
            : 'unknown',
        }
      : {}),
    resetAt,
    limited,
    retryAfter: hasRetryAfter,
  };
}
interface GitHubPollSourceOptions {
  collection?: { collect: GitHubPollCollector; cycle: string; credentialId: string };
  fetchImpl: typeof fetch;
  hasInjectedFetch: boolean;
  hasToken: boolean;
  readFailed: boolean;
  credentialSource: 'credential-store' | 'GH_TOKEN' | 'GITHUB_TOKEN' | 'none';
  repo: string;
  observe: (response: Response) => void;
  onAccessible: () => void;
}

export function createGitHubPollSource(options: GitHubPollSourceOptions): typeof fetch {
  const useCli =
    !options.hasToken &&
    !options.readFailed &&
    !options.hasInjectedFetch &&
    options.fetchImpl === fetch;
  const request = useCli ? fetchGitHubViaCli : options.fetchImpl;
  let bucketRecorded = false;
  return (async (input, init) => {
    if (!options.hasToken && options.readFailed)
      throw new Error('Configured GitHub credentials unavailable; restore access before polling');
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    const response = options.collection
      ? await options.collection.collect(
          {
            credentialId: options.collection.credentialId,
            url: input instanceof Request ? input.url : String(input),
            accept: headers.get('accept') ?? '',
            apiVersion: headers.get('x-github-api-version') ?? '',
          },
          options.collection.cycle,
          headers.get('if-none-match'),
          (validator) => {
            const requestHeaders = new Headers(headers);
            if (validator) requestHeaders.set('If-None-Match', validator);
            else requestHeaders.delete('If-None-Match');
            return request(input, { ...init, headers: requestHeaders });
          }
        )
      : await request(input, init);
    if (!bucketRecorded) {
      const bucket = parseRateLimitHeaders(response);
      log.info('GitHub polling credential bucket', {
        repo: options.repo,
        credentialSource: useCli ? 'gh' : options.credentialSource,
        limit: bucket.limit ?? null,
        resource: bucket.resource ?? 'unknown',
        remaining: Number.isFinite(bucket.remaining) ? bucket.remaining : null,
        status: response.status,
      });
      bucketRecorded = true;
    }
    options.observe(response);
    if (response.ok || response.status === 304) options.onAccessible();
    return response;
  }) as typeof fetch;
}
