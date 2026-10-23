import superpipe, { type PipelineAPI } from 'superpipe';
import type { CodingPollFactsRepository } from './poll-facts.ts';
import { pollHttpMetadata } from './poll-http-metadata.ts';
import { parseRateLimitHeaders } from '../../../github/poll-source.ts';
import { GITHUB_RESPONSE_MAX_BYTES } from '../../../github/gh-api-fetch.ts';
import { collectWithMaxBuffer } from '../../../utils/script-utils.ts';

type Subject = Parameters<CodingPollFactsRepository['read']>[0];
type Snapshot = ReturnType<CodingPollFactsRepository['read']>;
type Observation = Parameters<CodingPollFactsRepository['record']>[1];
function readSnapshot(facts: CodingPollFactsRepository, subject: Subject, now: () => number) {
  return facts.read(subject, now(), Infinity);
}
function cachedResponse(saved: Snapshot, cycle: string): Response | null {
  const page = saved.page;
  if (page.status !== 'known' || page.http?.cycle !== cycle) return null;
  const headers = new Headers(page.http.headers);
  headers.set('Content-Type', 'application/json');
  if (page.next) headers.set('Link', `<${page.next}>; rel="next"`);
  return new Response([204, 205].includes(page.http.status) ? null : JSON.stringify(page.value), {
    status: page.http.status,
    headers,
  });
}
async function requestPage(
  facts: CodingPollFactsRepository,
  subject: Subject,
  validator: string | null,
  request: () => Promise<Response>,
  saved: Snapshot,
  cached: Response | null,
  now: () => number
) {
  if (cached) return cached;
  try {
    return await facts.acquire(subject, validator, request);
  } catch (error) {
    facts.record(subject, { reason: 'failed' }, now(), saved.observationRevision);
    throw error;
  }
}
async function observePage(
  facts: CodingPollFactsRepository,
  subject: Subject,
  cycle: string,
  validator: string | null,
  saved: Snapshot,
  cached: Response | null,
  response: Response,
  now: () => number
) {
  if (cached) return response;
  const http = pollHttpMetadata(cycle, response.status, response.headers);
  let observation: Observation;
  if (response.status === 304) observation = { notModified: validator ?? '', http };
  else if (!response.ok)
    observation = {
      reason: parseRateLimitHeaders(response).limited
        ? 'rate_limited'
        : [401, 403].includes(response.status)
          ? 'not_authorized'
          : 'failed',
    };
  else {
    try {
      const raw = await collectWithMaxBuffer(response.clone().body, GITHUB_RESPONSE_MAX_BYTES);
      if (raw.truncated) throw new Error('GitHub polling response exceeded the size limit');
      const value = [204, 205].includes(response.status) ? null : JSON.parse(raw.text);
      const next = response.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1] ?? null;
      observation = { value, etag: response.headers.get('etag'), next, http };
    } catch {
      facts.record(subject, { reason: 'partial' }, now(), saved.observationRevision);
      throw new Error('GitHub polling page is incomplete or invalid JSON');
    }
  }
  if (!facts.record(subject, observation, now(), saved.observationRevision)) {
    const current = cachedResponse(readSnapshot(facts, subject, now), cycle);
    if (current) return current;
    throw new Error('GitHub polling observation superseded');
  }
  return response;
}

export const collectPollHttp = (superpipe({})('coding-ledger-collect-http-page') as PipelineAPI)
  .input(['facts', 'subject', 'cycle', 'validator', 'request', 'now'])
  .pipe(readSnapshot, ['facts', 'subject', 'now'], 'saved')
  .pipe(cachedResponse, ['saved', 'cycle'], 'cached')
  .pipe(
    requestPage,
    ['facts', 'subject', 'validator', 'request', 'saved', 'cached', 'now'],
    'response'
  )
  .pipe(
    observePage,
    ['facts', 'subject', 'cycle', 'validator', 'saved', 'cached', 'response', 'now'],
    'response'
  )
  .endAsync('response') as (
  facts: CodingPollFactsRepository,
  subject: Subject,
  cycle: string,
  validator: string | null,
  request: () => Promise<Response>,
  now: () => number
) => Promise<Response>;
