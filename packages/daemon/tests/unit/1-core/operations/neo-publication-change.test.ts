import { describe, expect, test } from 'bun:test';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import {
  createNeoPublicationChangeOperations,
  requireCorrectable,
  requireOwnPublication,
} from '../../../../src/lib/neo/publication-change-operation.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import {
  createOperationRegistry,
  type OperationCaller,
} from '../../../../src/lib/operations/registry.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { createNeoPublicationTable } from '../../../../src/storage/schema/m288-neo-publications.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const conversation = '10000000-0000-4000-8000-000000000001';
const original = '20000000-0000-4000-8000-000000000002';
const correction = '30000000-0000-4000-8000-000000000003';
const root: NeoBinding = { sessionId: `neo:${conversation}`, projectId: null, kind: 'neo' };
const holder: NeoBinding = { sessionId: 'neo:holder', projectId: 'p1', kind: 'project' };

const neo = (sessionId = root.sessionId): OperationCaller => ({
  source: 'mcp',
  sessionId,
  neoTurn: { messageId: 'm-2', human: false, isLive: () => true },
});

function setup() {
  const db = new Database(':memory:');
  createNeoPublicationTable(db);
  const publications = new NeoPublicationRepository(db);
  const insert = (publicationId: string, producer = root.sessionId, extra = {}) =>
    db
      .prepare(`INSERT INTO neo_publications(conversation_id, publication_id, payload_json, created_at)
        VALUES (?, ?, ?, ?)`)
      .run(
        conversation,
        publicationId,
        JSON.stringify({
          conversationId: conversation,
          publicationId,
          askOrigin: { sessionId: root.sessionId, messageId: 'm-1' },
          producerInput: { sessionId: producer, messageId: 'm-1' },
          shortText: 'PR #12 merged.',
          fullText: 'PR #12 merged into dev.',
          links: [],
          triggerId: 'human:m-1',
          ...extra,
        }),
        '2026-10-14T10:00:00.000Z'
      );
  let notified = 0;
  const registry = createOperationRegistry(
    createNeoPublicationChangeOperations(
      {
        getBinding: (id) => [root, holder].find((binding) => binding.sessionId === id) ?? null,
        getRootBinding: () => root,
        publications,
        notify: () => notified++,
      },
      () => new Date('2026-10-14T11:00:00.000Z')
    )
  );
  const call = async (name: string, input: unknown, caller = neo()) => {
    const outcome = await invokeOperation(registry, name, input, caller);
    return outcome.kind === 'completed' ? outcome.value : outcome;
  };
  return { db, publications, insert, call, notified: () => notified };
}

describe('neo.publication.edit', () => {
  test('fixes the wording in place and marks it edited, keeping links and trigger', async () => {
    const { db, publications, insert, call, notified } = setup();
    try {
      insert(original);
      expect(
        await call('neo.publication.edit', {
          publicationId: original,
          shortText: 'PR #12 is merged.',
        })
      ).toMatchObject({
        accepted: true,
        created: false,
        publication: {
          shortText: 'PR #12 is merged.',
          fullText: 'PR #12 merged into dev.',
          editedAt: '2026-10-14T11:00:00.000Z',
          triggerId: 'human:m-1',
          links: [],
        },
      });
      expect(publications.get(conversation, original)?.editedAt).toBe('2026-10-14T11:00:00.000Z');
      expect(notified()).toBe(1);
    } finally {
      db.close();
    }
  });

  test('refuses an unknown id, another session, an RPC caller and an empty edit', async () => {
    const { db, insert, call, publications } = setup();
    try {
      insert(original);
      expect(
        await call('neo.publication.edit', { publicationId: correction, shortText: 'x' })
      ).toEqual({ accepted: false, reason: 'not_found' });
      expect(
        await call(
          'neo.publication.edit',
          { publicationId: original, shortText: 'x' },
          neo(holder.sessionId)
        )
      ).toEqual({ accepted: false, reason: 'not_your_publication' });
      expect(
        await call(
          'neo.publication.edit',
          { publicationId: original, shortText: 'x' },
          { source: 'rpc', principal: 'local' }
        )
      ).toEqual({ accepted: false, reason: 'live_avatar_required' });
      expect(await call('neo.publication.edit', { publicationId: original })).toMatchObject({
        kind: 'failed',
        code: 'invalid_input',
      });
      expect(publications.get(conversation, original)?.shortText).toBe('PR #12 merged.');
    } finally {
      db.close();
    }
  });
});

describe('neo.publication.correct', () => {
  const corrected = {
    publicationId: original,
    correctionId: correction,
    shortText: 'Correction: PR #12 did not merge.',
    fullText: 'PR #12 is still open; checks failed.',
  };

  test('publishes one labelled correction that cites the original, and retries reuse it', async () => {
    const { db, publications, insert, call } = setup();
    try {
      insert(original);
      expect(await call('neo.publication.correct', corrected)).toMatchObject({
        accepted: true,
        created: true,
        publication: {
          publicationId: correction,
          corrects: original,
          askOrigin: { sessionId: root.sessionId, messageId: 'm-1' },
          producerInput: { sessionId: root.sessionId, messageId: 'm-2' },
        },
      });
      expect(publications.get(conversation, original)).toMatchObject({
        correctedBy: correction,
        shortText: 'PR #12 merged.',
      });
      expect(publications.get(conversation, correction)?.triggerId).toBeUndefined();
      expect(await call('neo.publication.correct', corrected)).toMatchObject({
        accepted: true,
        created: false,
      });
      expect(
        await call('neo.publication.correct', {
          ...corrected,
          correctionId: '40000000-0000-4000-8000-000000000004',
        })
      ).toEqual({ accepted: false, reason: 'already_corrected' });
      expect(
        await call('neo.publication.correct', {
          ...corrected,
          publicationId: correction,
          correctionId: '40000000-0000-4000-8000-000000000004',
        })
      ).toEqual({ accepted: false, reason: 'already_corrected' });
    } finally {
      db.close();
    }
  });

  test('never corrects another session’s publication', async () => {
    const { db, insert, call } = setup();
    try {
      insert(original, holder.sessionId);
      expect(await call('neo.publication.correct', corrected)).toEqual({
        accepted: false,
        reason: 'not_your_publication',
      });
    } finally {
      db.close();
    }
  });
});

describe('requireOwnPublication', () => {
  test('a missing publication is not found before ownership is checked', () => {
    expect(requireOwnPublication({ input: { sessionId: 's' } } as never, null)).toEqual({
      reason: { accepted: false, reason: 'not_found' },
    });
  });
});

describe('requireCorrectable', () => {
  test('a correction cannot itself be corrected', () => {
    expect(requireCorrectable({ publication: { corrects: original } } as never)).toEqual({
      reason: { accepted: false, reason: 'already_corrected' },
    });
  });
});
