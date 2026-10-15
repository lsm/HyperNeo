import { describe, expect, test } from 'bun:test';
import type { NeoBinding } from '@hyperneo/shared/types/neo-context';
import {
  createNeoPublicationChangeOperations,
  requireNeoEditable,
  planNeoCorrectionAnswer,
  requireChangeable,
  requireCorrectable,
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
import { createNeoRoutingLogTable } from '../../../../src/storage/schema/m299-neo-routing-log.ts';
import { Database } from '../../../../src/storage/sqlite-compat.ts';

const conversation = '10000000-0000-4000-8000-000000000001';
const original = '20000000-0000-4000-8000-000000000002';
const correctionFor = (publicationId: string, turn: string) =>
  neoDerivedId(`neo.publication.correct:${conversation}:${publicationId}:${turn}`);
const correction = correctionFor(
  '20000000-0000-4000-8000-000000000002',
  'neo:10000000-0000-4000-8000-000000000001:m-2'
);
const humanCorrection = correctionFor('20000000-0000-4000-8000-000000000002', 'human:m-3');
const consultationReply = '50000000-0000-4000-8000-000000000005';
const sameTurnReply = '60000000-0000-4000-8000-000000000006';
const root: NeoBinding = { sessionId: `neo:${conversation}`, projectId: null, kind: 'neo' };
const holder: NeoBinding = { sessionId: 'neo:holder', projectId: 'p1', kind: 'project' };

const neo = (sessionId = root.sessionId, messageId = 'm-2'): OperationCaller => ({
  source: 'mcp',
  sessionId,
  neoTurn: { messageId, human: false, isLive: () => true },
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
  const published = new Set<string>();
  const replies: string[] = [];
  const registry = createOperationRegistry(
    createNeoPublicationChangeOperations(
      {
        getBinding: (id) => [root, holder].find((binding) => binding.sessionId === id) ?? null,
        getRootBinding: () => root,
        publications,
        isConsultationReturn: (_conversationId, publicationId) =>
          publicationId === consultationReply,
        resolveAskOrigin: (input) => ({
          sessionId: input.sessionId,
          messageId: `ask-of-${input.messageId}`,
        }),
        inputTrigger: (input) => (input.messageId === 'm-3' ? `human:${input.messageId}` : null),
        isTriggerPublished: (_conversationId, triggerId) => published.has(triggerId),
        notify: () => notified++,
        noteReply: (publication) => replies.push(publication.publicationId),
      },
      () => new Date('2026-10-14T11:00:00.000Z')
    )
  );
  const call = async (name: string, input: unknown, caller = neo()) => {
    const outcome = await invokeOperation(registry, name, input, caller);
    return outcome.kind === 'completed' ? outcome.value : outcome;
  };
  return { db, publications, insert, call, notified: () => notified, published, replies };
}

describe('neo.publication.edit', () => {
  test('fixes the wording in place and marks it edited, keeping links and trigger', async () => {
    const { db, publications, insert, call, notified } = setup();
    try {
      insert(original);
      expect(
        await call(
          'neo.publication.edit',
          { publicationId: original, shortText: 'PR #12 is merged.' },
          neo(root.sessionId, 'm-3')
        )
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

  test('refuses an unknown id, an RPC caller and an empty edit', async () => {
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
      expect(await call('neo.publication.correct', corrected, neo(root.sessionId, 'm-4'))).toEqual({
        accepted: false,
        reason: 'already_corrected',
      });
      expect(
        await call(
          'neo.publication.correct',
          { ...corrected, publicationId: correction },
          neo(root.sessionId, 'm-4')
        )
      ).toEqual({ accepted: false, reason: 'already_corrected' });
    } finally {
      db.close();
    }
  });

  test('corrects a reply another Neo session published in this conversation', async () => {
    const { db, insert, call } = setup();
    try {
      insert(original, holder.sessionId);
      expect(await call('neo.publication.correct', corrected)).toMatchObject({
        accepted: true,
        publication: { corrects: original, producerInput: { sessionId: root.sessionId } },
      });
    } finally {
      db.close();
    }
  });
});

describe('requireConversationPublication', () => {
  test('a missing publication is not found before ownership is checked', () => {
    expect(requireConversationPublication({ input: { sessionId: 's' } } as never, null)).toEqual({
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

describe('requireChangeable', () => {
  test('a consultation reply is never edited or corrected', async () => {
    expect(requireChangeable({} as never, true)).toEqual({
      reason: { accepted: false, reason: 'consultation_return' },
    });
    const { db, insert, call } = setup();
    try {
      insert(consultationReply);
      expect(
        await call('neo.publication.edit', { publicationId: consultationReply, shortText: 'x' })
      ).toEqual({ accepted: false, reason: 'consultation_return' });
      expect(
        await call('neo.publication.correct', {
          publicationId: consultationReply,
          shortText: 'x',
          fullText: 'y',
        })
      ).toEqual({ accepted: false, reason: 'consultation_return' });
    } finally {
      db.close();
    }
  });
});

describe('NeoPublicationRepository.findByProducer', () => {
  test('a correction made in the same turn as a reply does not make the turn ambiguous', async () => {
    const { db, publications, insert, call } = setup();
    try {
      insert(original);
      insert(sameTurnReply);
      db.prepare(
        `UPDATE neo_publications SET payload_json = json_set(payload_json, '$.producerInput.messageId', 'm-2')
          WHERE publication_id = ?`
      ).run(sameTurnReply);
      expect(
        await call('neo.publication.correct', {
          publicationId: original,
          shortText: 'Correction.',
          fullText: 'Correction.',
        })
      ).toMatchObject({ accepted: true });
      expect(publications.findByProducer(root.sessionId, 'm-2')?.publicationId).toBe(sameTurnReply);
    } finally {
      db.close();
    }
  });
});

describe('planNeoCorrectionAnswer', () => {
  const owned = {
    publication: { askOrigin: { sessionId: root.sessionId, messageId: 'm-1' } },
  } as never;
  const ask = { sessionId: root.sessionId, messageId: 'm-2' };

  test('a correction answers this turn when its trigger has no reply yet', () => {
    expect(planNeoCorrectionAnswer(owned, 'human:m-2', false, ask)).toEqual({
      askOrigin: ask,
      triggerId: 'human:m-2',
    });
  });

  test('otherwise it threads under the publication it corrects', () => {
    const threaded = { askOrigin: { sessionId: root.sessionId, messageId: 'm-1' } };
    expect(planNeoCorrectionAnswer(owned, 'human:m-2', true, ask)).toEqual(threaded);
    expect(planNeoCorrectionAnswer(owned, null, false, ask)).toEqual(threaded);
  });
});

describe('neo.publication.recent', () => {
  test('lists every Neo reply in the conversation, newest first, marking which are yours', async () => {
    const { db, insert, call } = setup();
    try {
      insert(original);
      insert(sameTurnReply, holder.sessionId);
      await call('neo.publication.correct', {
        publicationId: original,
        shortText: 'Correction.',
        fullText: 'Correction.',
      });
      const listed = (await call('neo.publication.recent', { limit: 5 })) as {
        publications: {
          publicationId: string;
          producer: string;
          yours: boolean;
          corrects?: string;
          correctedBy?: string;
        }[];
      };
      expect(
        listed.publications.map((item) => [item.publicationId, item.producer, item.yours])
      ).toEqual([
        [correction, root.sessionId, true],
        [sameTurnReply, holder.sessionId, false],
        [original, root.sessionId, true],
      ]);
      expect(listed.publications[0].corrects).toBe(original);
      expect(listed.publications[2].correctedBy).toBe(correction);
    } finally {
      db.close();
    }
  });
});

describe('neo.publication.correct as a reply', () => {
  test('in a human turn with no reply yet, the correction carries that trigger and ask', async () => {
    const { db, insert, call } = setup();
    try {
      insert(original);
      const result = (await call(
        'neo.publication.correct',
        {
          publicationId: original,
          shortText: 'Correction: PR #12 did not merge.',
          fullText: 'PR #12 is still open.',
        },
        {
          source: 'mcp',
          sessionId: root.sessionId,
          neoTurn: { messageId: 'm-3', human: true, isLive: () => true },
        }
      )) as { publication: { triggerId?: string; askOrigin: { messageId: string } } };
      expect(result.publication.triggerId).toBe('human:m-3');
      expect(result.publication.askOrigin.messageId).toBe('ask-of-m-3');
    } finally {
      db.close();
    }
  });
});

describe('a correction that answers its turn', () => {
  const asHuman: OperationCaller = {
    source: 'mcp',
    sessionId: root.sessionId,
    neoTurn: { messageId: 'm-3', human: true, isLive: () => true },
  };

  test('is the reply of its turn for the fallback and records the routed outcome of the ask', async () => {
    const { db, publications, insert, call, replies } = setup();
    try {
      createNeoRoutingLogTable(db);
      db.exec(`ALTER TABLE neo_routing_log ADD COLUMN digested_at INTEGER;
        ALTER TABLE neo_routing_log ADD COLUMN ask_summary TEXT;
        ALTER TABLE neo_routing_log ADD COLUMN awaiting TEXT`);
      db.prepare(
        `INSERT INTO neo_routing_log (message_id, conversation_id, asked_at, ask, destination, signal)
          VALUES ('ask-of-m-3', ?, 1, 'Fix that reply', 'main', 'test')`
      ).run(conversation);
      insert(original);
      await call(
        'neo.publication.correct',
        {
          publicationId: original,
          shortText: 'Correction: PR #12 did not merge.',
          fullText: 'PR #12 is still open.',
        },
        asHuman
      );
      expect(publications.findByProducer(root.sessionId, 'm-3')?.publicationId).toBe(
        humanCorrection
      );
      expect(replies).toEqual([humanCorrection]);
      expect(
        db.prepare("SELECT outcome FROM neo_routing_log WHERE message_id = 'ask-of-m-3'").get()
      ).toEqual({ outcome: 'Correction: PR #12 did not merge.' });
    } finally {
      db.close();
    }
  });
});

describe('neo.publication.edit across sessions', () => {
  test('a holder can fix the wording of a reply root published, and is recorded as the editor', async () => {
    const { db, insert, call, publications } = setup();
    try {
      insert(original);
      expect(
        await call(
          'neo.publication.edit',
          { publicationId: original, shortText: 'PR #12 is merged.' },
          neo(holder.sessionId, 'm-3')
        )
      ).toMatchObject({ accepted: true, publication: { editedBy: holder.sessionId } });
      expect(publications.get(conversation, original)?.producerInput.sessionId).toBe(
        root.sessionId
      );
    } finally {
      db.close();
    }
  });
});

describe('requireNeoEditable', () => {
  const publication = {
    conversationId: conversation,
    publicationId: original,
    askOrigin: { sessionId: root.sessionId, messageId: 'm-1' },
    producerInput: { sessionId: root.sessionId, messageId: 'neo-trigger:outcome:a:x' },
    shortText: 'Done.',
    fullText: 'Done.',
    links: [],
    triggerId: 'outcome:a:x',
    sequence: 1,
    createdAt: '2026-10-14T10:00:00.000Z',
  };
  const owned = (messageId: string, extra = {}) =>
    ({
      producer: { input: { sessionId: root.sessionId, messageId } },
      publication: { ...publication, ...extra },
    }) as unknown as Parameters<typeof requireNeoEditable>[0];
  const reason = (result: ReturnType<typeof requireNeoEditable>) =>
    'reason' in result ? result.reason.reason : 'ok';
  test('a human-triggered turn may fix any message’s wording', () => {
    expect(reason(requireNeoEditable(owned('m-9'), { shortText: 'Fixed.' }, 'human:m-9'))).toBe(
      'ok'
    );
  });
  test('a turn may change its own trigger’s message once, and nothing else', () => {
    const turn = 'neo-trigger:outcome:a:x';
    expect(reason(requireNeoEditable(owned(turn), { shortText: 'Fixed.' }, 'outcome:a:x'))).toBe(
      'ok'
    );
    expect(
      reason(
        requireNeoEditable(
          owned(turn, {
            editedAt: '2026-10-14T11:00:00.000Z',
            answerInput: { sessionId: root.sessionId, messageId: turn },
          }),
          { shortText: 'Again.' },
          'outcome:a:x'
        )
      )
    ).toBe('already_edited');
    expect(reason(requireNeoEditable(owned('n'), { shortText: 'X.' }, 'idle:a:y'))).toBe(
      'edit_needs_trigger'
    );
    expect(reason(requireNeoEditable(owned('n'), { shortText: 'X.' }, null))).toBe(
      'edit_needs_trigger'
    );
  });
  test('an unchanged edit is refused', () => {
    expect(reason(requireNeoEditable(owned('m-9'), { shortText: 'Done.' }, 'human:m-9'))).toBe(
      'edit_unchanged'
    );
  });
});

describe('neoDerivedId', () => {
  test('is a stable, valid UUID for one seed and differs for another', () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(neoDerivedId('a')).toMatch(uuid);
    expect(neoDerivedId('a')).toBe(neoDerivedId('a'));
    expect(neoDerivedId('a')).not.toBe(neoDerivedId('b'));
  });
});
