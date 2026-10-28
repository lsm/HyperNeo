import { afterEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { GitHubEvent } from '@hyperneo/shared';
import { GitHubPollingService } from '../../../../src/lib/github/polling-service';
import { Logger } from '../../../../src/lib/logger';

const issue = (id: number) => ({
  id,
  number: id,
  title: 'Synthetic issue',
  body: 'Synthetic short body',
  state: 'open',
  labels: [],
  user: { login: 'synthetic' },
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  html_url: `https://example.invalid/issues/${id}`,
});
const comment = (id: number) => ({
  id,
  body: 'Synthetic short comment',
  user: { login: 'synthetic' },
  issue_url: `https://api.github.com/repos/synthetic/tail/issues/${id}`,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  html_url: `https://example.invalid/comments/${id}`,
});
const identity = (event: GitHubEvent) => (event.rawPayload as { id: number }).id;
const services: GitHubPollingService[] = [];
function fixture(onEvent: (event: GitHubEvent) => Promise<void> | void) {
  const requests: { page: string; validator: string | null; hasSince: boolean }[] = [];
  const service = new GitHubPollingService(
    {
      token: 'synthetic-transport',
      collectPollPage: async (subject, _cycle, validator) => {
        const url = new URL(subject.url);
        const page = url.pathname.endsWith('/comments') ? 'comments' : 'issues';
        const etag = `"synthetic-${page}"`;
        requests.push({ page, validator, hasSince: url.searchParams.has('since') });
        return validator === etag
          ? new Response(null, { status: 304, headers: { ETag: etag } })
          : Response.json(page === 'issues' ? [1, 2, 3].map(issue) : [4, 5, 6].map(comment), {
              headers: { ETag: etag },
            });
      },
    },
    onEvent
  );
  services.push(service);
  service.addRepository('synthetic', 'tail');
  service.start();
  return { service, requests };
}
afterEach(() => {
  for (const service of services.splice(0)) service.stop();
  vi.restoreAllMocks();
});

describe('GitHub polling per-event failure isolation', () => {
  for (const failed of [1, 2, 4, 5])
    for (const asyncFailure of [false, true])
      test(`retains page tail after ${asyncFailure ? 'async' : 'sync'} failure at event ${failed}`, async () => {
        const attempted: number[] = [];
        const delivered: number[] = [];
        const error = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
        const { service, requests } = fixture((event) => {
          const id = identity(event);
          attempted.push(id);
          if (id === failed) {
            if (asyncFailure) return Promise.reject(new Error('synthetic delivery rejection'));
            throw new Error('synthetic delivery rejection');
          }
          delivered.push(id);
        });
        await service.triggerPoll();
        expect(attempted).toEqual([1, 2, 3, 4, 5, 6]);
        expect(delivered).toEqual([1, 2, 3, 4, 5, 6].filter((id) => id !== failed));
        expect(error).toHaveBeenCalledWith(
          'Failed to deliver polled event',
          expect.objectContaining({
            eventId: expect.any(String),
            eventType: failed < 4 ? 'issues' : 'issue_comment',
            error: 'synthetic delivery rejection',
          })
        );
        expect(requests).toEqual([
          { page: 'issues', validator: null, hasSince: false },
          { page: 'comments', validator: null, hasSince: false },
        ]);
        await service.triggerPoll();
        expect(attempted).toEqual([1, 2, 3, 4, 5, 6]);
        expect(delivered).toHaveLength(5);
        expect(requests.slice(2)).toEqual([
          { page: 'issues', validator: '"synthetic-issues"', hasSince: true },
          { page: 'comments', validator: '"synthetic-comments"', hasSince: true },
        ]);
      });
  test('awaits the callback once before delivering the next event', async () => {
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((done) => {
      entered = done;
    });
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    const attempted: number[] = [];
    const { service } = fixture(async (event) => {
      const id = identity(event);
      attempted.push(id);
      if (id === 1) {
        entered();
        await blocked;
        throw new Error('synthetic delivery rejection');
      }
    });
    const pending = service.triggerPoll();
    await reached;
    expect(attempted).toEqual([1]);
    release();
    await pending;
    expect(attempted).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

test('polling and merged event/writer dependencies retain their audited source contracts', () => {
  const root = new URL('../../../../../../', import.meta.url);
  const manifest = JSON.parse(
    readFileSync(
      new URL('.claude/skills/verify/evidence/lane-c-poll-tail/audited-dependencies.json', root),
      'utf8'
    )
  ) as {
    pollingFile: string;
    pollingWithoutConstructorSha256: string;
    sourceRoots: { file: string; sha256: string }[];
    eventSubtree: { file: string; name: string; sha256: string; wholeFile: boolean }[];
    writerSubtree: { file: string; name: string; sha256: string; wholeFile: boolean }[];
  };
  const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
  const source = readFileSync(new URL(manifest.pollingFile, root), 'utf8');
  const parsed = ts.createSourceFile(manifest.pollingFile, source, ts.ScriptTarget.Latest, true);
  const klass = parsed.statements.find(
    (n) => ts.isClassDeclaration(n) && n.name?.text === 'GitHubPollingService'
  );
  if (!klass || !ts.isClassDeclaration(klass)) throw new Error('Polling class missing');
  const ctor = klass.members.find(ts.isConstructorDeclaration);
  if (!ctor) throw new Error('Polling constructor missing');
  expect(
    hash(source.slice(0, ctor.getStart(parsed)) + '<constructor boundary>' + source.slice(ctor.end))
  ).toBe(manifest.pollingWithoutConstructorSha256);
  for (const unit of manifest.sourceRoots)
    expect(hash(readFileSync(new URL(unit.file, root)))).toBe(unit.sha256);
  for (const unit of [...manifest.eventSubtree, ...manifest.writerSubtree]) {
    let content = readFileSync(new URL(unit.file, root), 'utf8');
    if (!unit.wholeFile) {
      const sf = ts.createSourceFile(unit.file, content, ts.ScriptTarget.Latest, true);
      const owner = unit.name.includes('.') ? unit.name.split('.')[0] : null;
      const method = unit.name.split('.').at(-1);
      const cl = sf.statements.find(
        (n) => ts.isClassDeclaration(n) && (!owner || n.name?.text === owner)
      );
      if (!cl || !ts.isClassDeclaration(cl)) throw new Error('Audited class missing');
      const member = cl.members.find(
        (n) => (ts.isConstructorDeclaration(n) ? 'constructor' : n.name?.getText(sf)) === method
      );
      if (!member) throw new Error('Audited method missing');
      content = member.getText(sf);
    }
    expect(hash(content)).toBe(unit.sha256);
  }
});

test('preserves the polling service receiver supplied to an ordinary callback', async () => {
  const receivers: unknown[] = [];
  const { service } = fixture(function (this: unknown, _event) {
    receivers.push(this);
  });
  await service.triggerPoll();
  expect(receivers).toHaveLength(6);
  expect(receivers.every((receiver) => receiver === service)).toBe(true);
});
