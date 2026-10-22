import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import {
  createNeoPublicationChangeOperations,
  requireConversationPublication,
} from '../../../../src/lib/neo/publication-change-operation.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { neoDerivedId } from '../../../../src/lib/neo/derived-id.ts';
import { createNeoPublicationTable } from '../../../../src/storage/schema/m288-neo-publications.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const conversation = '10000000-0000-4000-8000-000000000001';
const original = '20000000-0000-4000-8000-000000000002';
const root: NeoBinding = { sessionId: `neo:${conversation}`, projectId: null, kind: 'neo' };
const holder: NeoBinding = { sessionId: 'neo:holder', projectId: 'p1', kind: 'worker' };
const input = {
  conversationId: conversation,
  publicationId: original,
  askOrigin: { sessionId: root.sessionId, messageId: 'm-1' },
  producerInput: { sessionId: root.sessionId, messageId: 'm-1' },
  shortText: 'The result is ready.',
  fullText: 'The original details.',
  links: [{ label: 'Project', kind: 'project' as const, id: 'p1' }],
  triggerId: 'human:m-1',
  awaiting: 'Use it?',
};
const caller = (sessionId = root.sessionId): OperationCaller => ({
  source: 'mcp',
  sessionId,
});
let db: Database;
let publications: NeoPublicationRepository;
let notified: number;
let registry: ReturnType<typeof createOperationRegistry>;
const call = async (name: 'edit' | 'recent', change: unknown, who = caller()) => {
  const result = await invokeOperation(registry, `neo.publication.${name}`, change, who);
  return result.kind === 'completed' ? result.value : result;
};
beforeEach(() => {
  db = new Database(':memory:');
  createNeoPublicationTable(db);
  publications = new NeoPublicationRepository(db);
  publications.append(input);
  notified = 0;
  registry = createOperationRegistry(
    createNeoPublicationChangeOperations(
      {
        getBinding: (id) => [root, holder].find((item) => item.sessionId === id) ?? null,
        getRootBinding: () => root,
        publications,
        notify: () => notified++,
      },
      () => new Date('2026-10-16T10:00:00.000Z')
    )
  );
});
afterEach(() => db.close());

describe('neo.publication.edit', () => {
  test('revises the same message and preserves the original text and attribution', async () => {
    const before = publications.get(conversation, original)!;
    expect(
      await call('edit', { publicationId: original, requestId: 'r1', shortText: 'Revised.' })
    ).toMatchObject({
      accepted: true,
      created: false,
      publication: {
        publicationId: original,
        sequence: before.sequence,
        createdAt: before.createdAt,
        shortText: 'Revised.',
        fullText: input.fullText,
        links: input.links,
        askOrigin: input.askOrigin,
        producerInput: input.producerInput,
        triggerId: input.triggerId,
        editedBy: root.sessionId,
        revisions: [
          {
            revisionId: original,
            shortText: input.shortText,
            fullText: input.fullText,
            createdAt: before.createdAt,
            producerInput: input.producerInput,
            awaiting: 'Use it?',
          },
        ],
      },
    });
    expect(publications.list(conversation)).toHaveLength(1);
    expect(publications.get(conversation, original)?.awaiting).toBeUndefined();
    expect(notified).toBe(1);
  });

  test('edits without inferring an answered message', async () => {
    expect(registry.get('neo.publication.correct')).toBeUndefined();
    const result = await call('edit', {
      publicationId: original,
      requestId: 'r1',
      shortText: 'Updated.',
    });
    expect(result).toMatchObject({
      accepted: true,
    });
  });

  test('permits multiple edits in one turn, including unchanged wording', async () => {
    for (const requestId of ['r1', 'r2', 'r3']) {
      expect(
        await call('edit', { publicationId: original, requestId, shortText: 'Revised.' })
      ).toHaveProperty('accepted', true);
    }
    expect(publications.get(conversation, original)?.revisions).toHaveLength(3);
  });

  test('retries do not add revisions, even after another revision changed the current text', async () => {
    const first = { publicationId: original, requestId: 'r1', shortText: 'First revision.' };
    await call('edit', first);
    await call('edit', { publicationId: original, requestId: 'r2', shortText: 'Second revision.' });
    expect(await call('edit', first)).toMatchObject({
      accepted: true,
      publication: { shortText: 'Second revision.' },
    });
    expect(publications.get(conversation, original)?.revisions).toHaveLength(2);
    expect(await call('edit', { ...first, shortText: 'Conflicting retry.' })).toMatchObject({
      accepted: false,
      reason: 'publication_conflict',
    });
    expect(publications.get(conversation, original)?.shortText).toBe('Second revision.');
  });

  test('a send retried after revisions returns its receipt without reverting the message', async () => {
    await call('edit', { publicationId: original, requestId: 'r1', shortText: 'Changed.' });
    expect(publications.append(input)).toMatchObject({
      accepted: true,
      created: false,
      publication: { shortText: 'Changed.' },
    });
    expect(publications.append({ ...input, shortText: 'Different original.' })).toEqual({
      accepted: false,
      reason: 'publication_conflict',
    });
    expect(publications.list(conversation)).toHaveLength(1);
  });

  test('a revision identity cannot be reused to change another message', async () => {
    const second = '40000000-0000-4000-8000-000000000004';
    publications.append({ ...input, publicationId: second });
    await call('edit', { publicationId: original, requestId: 'r1', shortText: 'First.' });
    expect(
      await call('edit', { publicationId: second, requestId: 'r1', shortText: 'Second.' })
    ).toMatchObject({ accepted: false, reason: 'publication_conflict' });
    expect(publications.get(conversation, second)?.shortText).toBe(input.shortText);
  });

  test.each([
    { publicationId: original, requestId: 'r1' },
    { publicationId: original, shortText: 'No identity.' },
    { publicationId: original, requestId: 'r1', shortText: 'Spoof.', revisions: [] },
  ])('rejects invalid revision input: %j', async (change) => {
    expect(await call('edit', change)).toMatchObject({ kind: 'failed', code: 'invalid_input' });
    expect(publications.get(conversation, original)?.shortText).toBe(input.shortText);
  });

  test.each([
    { source: 'rpc', principal: 'local' },
    { ...caller(), sessionId: 'worker' },
  ] satisfies OperationCaller[])('refuses an unauthorized publisher: %j', async (who) => {
    expect(
      await call('edit', { publicationId: original, requestId: 'r1', shortText: 'Wrong.' }, who)
    ).toMatchObject({ accepted: false, reason: 'avatar_required' });
    expect(notified).toBe(0);
  });

  test('cannot revise another conversation or a missing message', async () => {
    const foreign = '30000000-0000-4000-8000-000000000003';
    publications.append({ ...input, publicationId: foreign, conversationId: foreign });
    expect(
      await call('edit', { publicationId: foreign, requestId: 'r1', shortText: 'Wrong.' })
    ).toMatchObject({ accepted: false, reason: 'not_found' });
  });
});

describe('neo.publication.edit full revisions', () => {
  test('corrects the same entry repeatedly with a preserved revision history', async () => {
    for (const requestId of ['c1', 'c2']) {
      expect(
        await call('edit', {
          publicationId: original,
          requestId,
          shortText: requestId,
          fullText: `Details ${requestId}`,
        })
      ).toMatchObject({ accepted: true, created: false, publication: { publicationId: original } });
    }
    const current = publications.get(conversation, original)!;
    expect(current.shortText).toBe('c2');
    expect(current.revisions?.map((version) => version.shortText)).toEqual([input.shortText, 'c1']);
    expect(current).not.toHaveProperty('corrects');
    expect(current).not.toHaveProperty('correctedBy');
    expect(publications.list(conversation)).toHaveLength(1);
  });
});

describe('requireConversationPublication', () => {
  test('missing messages return a not-found receipt', () => {
    expect(requireConversationPublication({} as never, null)).toHaveProperty(
      'reason.reason',
      'not_found'
    );
  });
});

describe('neoDerivedId', () => {
  test('operation identity is stable and does not collapse distinct requests', () => {
    expect(neoDerivedId('r1')).toBe(neoDerivedId('r1'));
    expect(neoDerivedId('r1')).not.toBe(neoDerivedId('r2'));
  });
});
