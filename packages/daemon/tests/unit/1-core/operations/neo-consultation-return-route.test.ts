import { describe, expect, test } from 'bun:test';
import type { NeoConsultation } from '@hyperneo/shared/types/neo-context';
import type { NeoPublication } from '@hyperneo/shared/types/neo-publication';
import {
  planNeoConsultationReturn,
  requireConsultationAsk,
  requireConsultationPublication,
  requireConsultationReceipt,
  selectConsultationReturn,
} from '../../../../src/lib/neo/consultation-return-route.ts';
import { neoConsultationReplyContent } from '../../../../src/lib/neo/consultation-reply-content.ts';
import {
  NeoConsultationRepository,
  type NeoConsultationPublication,
} from '../../../../src/storage/repositories/neo-consultation-repository.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { createTestDb } from '../../../helpers/database.ts';

const originalAsk = Object.freeze({ sessionId: 'neo:holder:source', messageId: 'original-ask' });
const item: NeoConsultation = Object.freeze({
  id: 'check',
  requestKey: 'request',
  concernId: 'fictional',
  originSessionId: 'neo:root',
  originMessageId: 'root-system-input',
  sessionId: 'neo:holder:fictional',
  question: 'Compare the fictional sources.',
  status: 'reported',
  answer: '**Detail** with evidence limits.',
  createdAt: 1,
});
const publication: NeoPublication = Object.freeze({
  conversationId: '10000000-0000-4000-8000-000000000001',
  publicationId: '20000000-0000-4000-8000-000000000001',
  askOrigin: originalAsk,
  producerInput: Object.freeze({
    sessionId: item.sessionId,
    messageId: 'neo-consult:check:request',
  }),
  shortText: 'The second source differs.',
  fullText: item.answer!,
  links: Object.freeze([{ kind: 'concern' as const, id: 'fictional', label: 'View comparison' }]),
  sequence: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
});
const association: NeoConsultationPublication = Object.freeze({
  consultationId: item.id,
  conversationId: publication.conversationId,
  publicationId: publication.publicationId,
  answer: publication.fullText,
  createdAt: publication.createdAt,
});

describe('selectConsultationReturn', () => {
  test.each(['reported', 'failed'] as const)(
    'retains a %s legacy return without a joint receipt',
    (status) => {
      expect(selectConsultationReturn({ ...item, status }, null, null)).toEqual({
        reason: 'legacy',
      });
    }
  );
  test.each([null, association])(
    'pending takes precedence over receipt presence: %j',
    (receipt) => {
      expect(
        selectConsultationReturn({ ...item, status: 'pending' }, receipt, publication)
      ).toEqual({ reason: 'pending' });
    }
  );
  test('rejects an orphan publication rather than falling back to a second model turn', () => {
    expect(selectConsultationReturn(item, null, publication)).toEqual({ reason: 'inconsistent' });
    expect(selectConsultationReturn(item, association, null)).toEqual({ value: association });
  });
});

describe('requireConsultationReceipt', () => {
  test.each([{ consultationId: 'different-check' }, { answer: 'Different answer' }])(
    'rejects mismatched association identity or answer: %j',
    (patch) => {
      expect(requireConsultationReceipt({ ...association, ...patch }, item)).toEqual({
        reason: 'inconsistent',
      });
    }
  );
  test.each(['pending', 'failed'] as const)(
    'a joint receipt cannot authorize a %s return',
    (status) => {
      expect(requireConsultationReceipt(association, { ...item, status })).toEqual({
        reason: 'inconsistent',
      });
    }
  );
  test('requires the full settled answer and preserves the actual association object', () => {
    expect(requireConsultationReceipt(association, { ...item, answer: null })).toEqual({
      reason: 'inconsistent',
    });
    expect(requireConsultationReceipt(association, item)).toEqual({ value: association });
  });
});

describe('requireConsultationPublication', () => {
  test.each([
    { conversationId: '10000000-0000-4000-8000-000000000002' },
    { publicationId: '20000000-0000-4000-8000-000000000002' },
    { fullText: 'Different detail' },
    { shortText: '' },
    { sequence: 0 },
    { sequence: 1.5 },
    { createdAt: 'not-a-date' },
    { createdAt: '2026-10-01T00:00:01.000Z' },
    { producerInput: { ...publication.producerInput, sessionId: 'other-holder' } },
    { producerInput: { ...publication.producerInput, messageId: 'neo-consult:other:request' } },
    { askOrigin: { ...originalAsk, messageId: '' } },
    { links: [{ kind: 'concern' as const, id: 'fictional', label: '' }] },
  ])('rejects invalid or mismatched publication evidence: %j', (patch) => {
    expect(requireConsultationPublication(association, item, { ...publication, ...patch })).toEqual(
      { reason: 'inconsistent' }
    );
  });
  test('missing publication is inconsistent, not a legacy answer', () => {
    expect(requireConsultationPublication(association, item, null)).toEqual({
      reason: 'inconsistent',
    });
    expect(requireConsultationPublication(association, item, publication)).toEqual({
      value: publication,
    });
  });
});

describe('requireConsultationAsk', () => {
  test.each([
    null,
    { ...originalAsk, sessionId: 'other-session' },
    { ...originalAsk, messageId: 'newer-ask' },
  ])('requires both original ask identity fields: %j', (origin) => {
    expect(requireConsultationAsk(publication, origin)).toEqual({ reason: 'inconsistent' });
  });
  test('retains holder-origin attribution without forcing it to root', () => {
    expect(requireConsultationAsk(publication, originalAsk)).toEqual({ value: publication });
    expect(publication.askOrigin.sessionId).not.toBe(item.originSessionId);
  });
});

describe('planNeoConsultationReturn', () => {
  test('preserves the original narrow legacy caller contract without admitting missing holder evidence', () => {
    const { id, status, answer, concernId, originMessageId } = item;
    const legacy = { id, status, answer, concernId, originMessageId };
    expect(neoConsultationReplyContent(legacy)).toBe(neoConsultationReplyContent(item));
    expect(planNeoConsultationReturn(legacy, association, publication, originalAsk)).toBe(
      'inconsistent'
    );
  });
  test('returns the exact authored object synchronously without modifying any input', () => {
    const before = structuredClone({ item, association, publication, originalAsk });
    const result = planNeoConsultationReturn(item, association, publication, originalAsk);
    expect(result).not.toBeInstanceOf(Promise);
    expect(result).toEqual({ kind: 'published', publication });
    if (typeof result === 'string') throw new Error('Expected published route');
    expect(result.publication).toBe(publication);
    expect({ item, association, publication, originalAsk }).toEqual(before);
    expect(planNeoConsultationReturn(item, association, publication, originalAsk)).toEqual(result);
  });
  test('an internal work-review id and null consultation origin do not replace the proven human ask', () => {
    const review = { ...item, id: 'neo-work:job:review', originMessageId: null };
    const receipt = { ...association, consultationId: review.id };
    const authored = {
      ...publication,
      producerInput: { sessionId: item.sessionId, messageId: `neo-consult:${review.id}:request` },
    };
    expect(planNeoConsultationReturn(review, receipt, authored, originalAsk)).toEqual({
      kind: 'published',
      publication: authored,
    });
  });
  test('early rejections halt before later evidence is accessed and retain their result', () => {
    let reads = 0;
    const poisoned = Object.defineProperty({ ...publication }, 'fullText', {
      get() {
        reads += 1;
        throw new Error('Later stage ran');
      },
    });
    expect(
      planNeoConsultationReturn({ ...item, status: 'pending' }, association, poisoned, null)
    ).toBe('pending');
    expect(
      planNeoConsultationReturn(item, { ...association, consultationId: 'wrong' }, poisoned, null)
    ).toBe('inconsistent');
    expect(reads).toBe(0);
  });
  test.each(['reported', 'failed', 'pending'] as const)(
    'the existing %s reply renderer remains unchanged',
    (status) => {
      const input = { ...item, status };
      const reply = neoConsultationReplyContent(input);
      expect(planNeoConsultationReturn(input, null, null, null)).toBe(
        status === 'pending' ? 'pending' : 'legacy'
      );
      if (status === 'pending') expect(reply).toBeNull();
      else {
        expect(reply?.split('\n')[0]).toContain('A consultation settled.');
        expect(JSON.parse(reply!.split('\n')[1])).toMatchObject({
          consultationId: item.id,
          status,
          answer: item.answer,
          originMessageId: item.originMessageId,
        });
      }
    }
  );
  test('uses real joint SQLite receipts without writing rows, accessing transcripts or starting delivery', async () => {
    const db = await createTestDb();
    try {
      const sql = db.getDatabase();
      sql
        .prepare(
          "INSERT INTO neo_concerns(id,title,summary,context,revision,created_at,updated_at) VALUES ('fictional','Sources','','',1,0,0)"
        )
        .run();
      const consultations = new NeoConsultationRepository(sql, () => {});
      const publications = new NeoPublicationRepository(sql);
      expect(consultations.reserve(item)?.status).toBe('pending');
      expect(
        consultations.settleWithPublication({
          consultationId: item.id,
          answer: publication.fullText,
          publication: {
            conversationId: publication.conversationId,
            publicationId: publication.publicationId,
            askOrigin: originalAsk,
            producerInput: publication.producerInput,
            shortText: publication.shortText,
            fullText: publication.fullText,
            links: publication.links,
          },
        }).accepted
      ).toBe(true);
      const settled = consultations.get(item.id)!;
      const receipt = consultations.getPublication(item.id)!;
      const authored = publications.get(receipt.conversationId, receipt.publicationId)!;
      const rows = () => [
        sql.prepare('SELECT * FROM neo_consultations').all(),
        sql.prepare('SELECT * FROM neo_consultation_publications').all(),
        sql.prepare('SELECT * FROM neo_publications').all(),
      ];
      const before = rows();
      expect(planNeoConsultationReturn(settled, receipt, authored, originalAsk)).toEqual({
        kind: 'published',
        publication: authored,
      });
      expect(
        planNeoConsultationReturn(settled, receipt, authored, {
          ...originalAsk,
          messageId: 'later',
        })
      ).toBe('inconsistent');
      expect(rows()).toEqual(before);
      expect(sql.prepare('SELECT * FROM sdk_messages').all()).toEqual([]);
      expect(db.getJobQueueRepo().listActiveByPayload('mailbox', {})).toEqual([]);
    } finally {
      db.close();
    }
  });
});
