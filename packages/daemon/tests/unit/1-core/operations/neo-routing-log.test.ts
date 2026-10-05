import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '@hyperneo/shared';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import { createNeoIntakeOperation } from '../../../../src/lib/neo/intake.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createOperationRegistry } from '../../../../src/lib/operations/registry.ts';
import { JobQueueRepository } from '../../../../src/storage/repositories/job-queue-repository.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoRoutingLogRepository } from '../../../../src/storage/repositories/neo-routing-log-repository.ts';
import { SDKMessageRepository } from '../../../../src/storage/repositories/sdk-message-repository.ts';
import { SessionRepository } from '../../../../src/storage/repositories/session-repository.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { Database as Sqlite } from '../../../../src/storage/sqlite-compat.ts';
import { createTables } from '../../../../src/storage/schema/index.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root: NeoBinding = { sessionId: `neo:${conversationId}`, kind: 'neo', concernId: null };
const holder: NeoBinding = {
  sessionId: 'neo:holder:research',
  kind: 'concern',
  concernId: 'research',
};
const human = { source: 'rpc', principal: 'local' } as const;
const ask = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('neo.message.send routing log', () => {
  let directory: string;
  let writer: Sqlite;
  let db: Database;
  let repo: NeoRepository;
  let log: NeoRoutingLogRepository;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'neo-routing-log-'));
    writer = new Sqlite(join(directory, 'fictional.db'));
    createTables(writer);
    const sessions = new SessionRepository(writer);
    const sdk = new SDKMessageRepository(writer as never);
    const jobs = new JobQueueRepository(writer);
    repo = new NeoRepository(writer);
    log = new NeoRoutingLogRepository(writer);
    for (const binding of [root, holder]) {
      repo.reserveBinding(binding);
      sessions.createSession({
        id: binding.sessionId,
        title: 'Fictional',
        createdAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        status: 'active',
        config: {},
        metadata: {},
      } as Session);
    }
    db = {
      getDatabase: () => writer,
      getSDKMessageRepo: () => sdk,
      getJobQueueRepo: () => jobs,
      getSession: (id: string) => sessions.getSession(id),
    } as unknown as Database;
  });
  afterEach(() => {
    writer.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const send = (sessionId: string, requestId: string, content: string) =>
    invokeOperation(
      createOperationRegistry([createNeoIntakeOperation(db, repo, () => {})]),
      'neo.message.send',
      { sessionId, requestId, content },
      human
    );

  test('logs where each new ask went, once per ask', async () => {
    await send(root.sessionId, ask(1), 'What is the  Cloudflare\npost about?');
    await send(root.sessionId, ask(1), 'What is the  Cloudflare\npost about?');
    await send(holder.sessionId, ask(2), 'x'.repeat(400));
    const rows = log.listAfter(0, 10);
    expect(
      rows.map((row) => [row.messageId, row.destination, row.targetSessionId, row.concernId])
    ).toEqual([
      [ask(1), 'main', root.sessionId, null],
      [ask(2), 'holder', holder.sessionId, 'research'],
    ]);
    expect(rows[0]).toMatchObject({
      conversationId,
      ask: 'What is the Cloudflare post about?',
      signal: 'opened',
      confidence: 1,
      outcome: null,
    });
    expect(rows[1].ask).toBe(`${'x'.repeat(300)}…`);
    expect(log.listAfter(rows[0].id, 10).map((row) => row.messageId)).toEqual([ask(2)]);
  });

  test('fills the outcome from the first final reply to that ask', async () => {
    await send(root.sessionId, ask(3), 'Summarize it');
    const publications = new NeoPublicationRepository(writer);
    const reply = (n: number, shortText: string, interim?: true) => ({
      conversationId,
      publicationId: ask(100 + n),
      askOrigin: { sessionId: root.sessionId, messageId: ask(3) },
      producerInput: { sessionId: root.sessionId, messageId: ask(3) },
      shortText,
      fullText: shortText,
      links: [],
      ...(interim ? { interim } : {}),
    });
    publications.append(reply(1, 'Working on it', true));
    expect(log.listAfter(0, 10)[0].outcome).toBeNull();
    publications.append(reply(2, 'It announces Artifacts in open beta.'));
    publications.append(reply(3, 'A later follow-up.'));
    expect(log.listAfter(0, 10)[0]).toMatchObject({
      outcome: 'It announces Artifacts in open beta.',
    });
  });
});
