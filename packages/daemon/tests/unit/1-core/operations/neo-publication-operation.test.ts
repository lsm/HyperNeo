import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import { createNeoPublisher } from '../../../../src/lib/neo/publication-operation.ts';
import { NeoRepository } from '../../../../src/storage/repositories/neo-repository.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { createNeoTables } from '../../../../src/storage/schema/neo.ts';
import { runMigration283 } from '../../../../src/storage/schema/m283-neo-work-origins.ts';
import { runMigration288 } from '../../../../src/storage/schema/m288-neo-publications.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
const root = { sessionId: `neo:${conversationId}`, kind: 'neo' as const, projectId: null };
const draft = { requestId: 'send-one', shortText: 'Ready', fullText: 'The comparison is ready.' };
const report = {
  daemonId: '30000000-0000-4000-8000-000000000001',
  artifactId: 'comparison',
  title: 'Comparison',
  kind: 'html' as const,
  byteLength: 100,
};
const caller = { source: 'mcp' as const, sessionId: root.sessionId, role: 'neo' as const };

describe('Neo publication without runtime input attribution', () => {
  let mailbox: MailboxTestDb;
  let ledger: NeoPublicationRepository;
  let publish: ReturnType<typeof createNeoPublisher>;
  const notify = vi.fn();
  beforeEach(() => {
    mailbox = createMailboxTestDb();
    createNeoTables(mailbox.db);
    runMigration283(mailbox.db);
    runMigration288(mailbox.db);
    const repo = new NeoRepository(mailbox.db);
    mailbox.db.prepare('INSERT INTO sessions(id) VALUES (?)').run(root.sessionId);
    repo.reserveBinding(root);
    repo.saveProject({ id: 'garden', title: 'Garden', summary: '', context: '' }, 0);
    ledger = new NeoPublicationRepository(mailbox.db);
    notify.mockClear();
    publish = createNeoPublisher({
      receivedHumanInput: () => false,
      getBinding: (id) => repo.getBindingBySession(id),
      getRootBinding: () => repo.defaultBinding(),
      hasProject: (id) => !!repo.getProject(id),
      append: (input) => ledger.append(input),
      notify,
      artifact: (id, who) =>
        id === report.artifactId && who.sessionId === root.sessionId ? report : null,
    });
  });
  afterEach(() => mailbox.close());

  test('publishes without a holder and leaves answered input unspecified', () => {
    const receipt = publish(draft, caller);
    expect(receipt).toMatchObject({ accepted: true, created: true });
    expect(receipt).not.toHaveProperty('answered');
    expect(ledger.list(conversationId)).toEqual([expect.objectContaining({ shortText: 'Ready' })]);
    const stored = ledger.list(conversationId)![0];
    expect(stored.askOrigin).toBeUndefined();
    expect(stored.producerInput).toBeUndefined();
    expect(notify).toHaveBeenCalledOnce();
  });

  test('retries the same request without duplicating or rewriting the publication', () => {
    expect(publish(draft, caller)).toMatchObject({ accepted: true, created: true });
    expect(publish(draft, caller)).toMatchObject({ accepted: true, created: false });
    expect(publish({ ...draft, shortText: 'Changed' }, caller)).toMatchObject({
      accepted: false,
      reason: 'publication_conflict',
    });
    expect(ledger.list(conversationId)).toHaveLength(1);
    expect(publish({ ...draft, requestId: 'send-two' }, caller)).toMatchObject({
      accepted: true,
      created: true,
    });
  });

  test.each(['worker', 'ordinary', 'neo:foreign'])(
    'refuses a foreign publisher %s',
    (sessionId) => {
      expect(publish(draft, { ...caller, sessionId })).toMatchObject({
        accepted: false,
        reason: 'avatar_required',
      });
      expect(ledger.list(conversationId)).toHaveLength(0);
    }
  );

  test('refuses a human transport even with the Neo session id', () => {
    expect(publish(draft, { ...caller, source: 'rpc' })).toMatchObject({ accepted: false });
  });

  test('preserves registered artifact references and refuses invented references', () => {
    expect(publish({ ...draft, artifacts: [report] }, caller)).toMatchObject({
      accepted: true,
      publication: { artifacts: [report] },
    });
    expect(
      publish(
        { ...draft, requestId: 'bad', artifacts: [{ ...report, artifactId: 'missing' }] },
        caller
      )
    ).toMatchObject({ accepted: false, reason: 'invalid_artifact_reference' });
  });

  test('validates project references and keeps unrelated topics separate', () => {
    expect(
      publish({ ...draft, links: [{ kind: 'project', id: 'missing', label: 'Missing' }] }, caller)
    ).toMatchObject({ accepted: false, reason: 'invalid_scene_reference' });
    expect(
      publish({ ...draft, links: [{ kind: 'project', id: 'garden', label: 'Garden' }] }, caller)
    ).toMatchObject({ accepted: true });
    expect(
      publish(
        { ...draft, requestId: 'topics', fullText: '# Garden\nDone.\n# Travel\nWaiting.' },
        caller
      )
    ).toMatchObject({ accepted: false, reason: 'multiple_topics' });
  });

  test.each(['askOrigin', 'producerInput', 'conversationId', 'publicationId'])(
    'does not accept model authored runtime field %s',
    (field) => {
      expect(publish({ ...draft, [field]: 'forged' }, caller)).toMatchObject({
        accepted: false,
        reason: 'invalid_publication',
      });
    }
  );
});
