import { afterEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoConsultation } from '@hyperneo/shared/types/neo-context';
import { neoConsultationRequestContent } from '../../../../src/lib/neo/consultation-request-content.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import { InternalEventBus } from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const item: NeoConsultation = Object.freeze({
  id: 'fictional-check',
  requestKey: 'fictional-request',
  concernId: 'fictional',
  originSessionId: 'root',
  originMessageId: 'original-ask',
  sessionId: 'holder',
  question: 'Which fictional draft is current?',
  status: 'pending',
  answer: null,
  createdAt: 1,
});

afterEach(() => vi.restoreAllMocks());

describe('NeoService extracted consultation request delivery', () => {
  test('uses the renderer in real durable mailbox delivery and preserves recovery idempotence', async () => {
    const db = await createTestDb();
    const createSession = vi.fn();
    const getSessionAsync = vi.fn();
    const service = new NeoService(
      db,
      { createSession, getSessionAsync } as unknown as SessionManager,
      { event: vi.fn() } as unknown as MessageHub,
      new InternalEventBus()
    );
    try {
      for (const id of ['root', 'holder']) db.createSession(createTestSession(id));
      service.repo.saveConcern({ id: 'fictional', title: 'Drafts', summary: '', context: '' }, 0);
      service.repo.reserveBinding({ sessionId: 'root', concernId: null, kind: 'neo' });
      service.repo.reserveBinding({ sessionId: 'holder', concernId: 'fictional', kind: 'concern' });
      const saved = service.consultations.reserve({ ...item })!;
      const sdkBefore = db.getDatabase().prepare('SELECT * FROM sdk_messages').all();
      await service.syncConsultation(saved.id);
      const jobs = () =>
        db.getJobQueueRepo().listActiveByPayload('mailbox', {
          'to.sessionId': 'holder',
          messageUuid: `neo-consult:${saved.id}:request`,
        });
      expect(jobs()).toHaveLength(1);
      const delivered = jobs()[0];
      expect(delivered.payload).toMatchObject({
        to: { sessionId: 'holder' },
        origin: 'session:root',
        messageUuid: `neo-consult:${saved.id}:request`,
        message: {
          type: 'user',
          inputKind: 'system',
          parent_tool_use_id: null,
          message: { role: 'user', content: neoConsultationRequestContent(saved) },
        },
      });
      await service.recoverConsultations();
      await service.syncConsultation(saved.id);
      expect(jobs()).toEqual([delivered]);
      expect(service.consultations.get(saved.id)).toEqual(saved);
      expect(db.getDatabase().prepare('SELECT * FROM sdk_messages').all()).toEqual(sdkBefore);
      expect(db.getDatabase().prepare('SELECT * FROM neo_publications').all()).toEqual([]);
      expect(createSession).not.toHaveBeenCalled();
      expect(getSessionAsync).not.toHaveBeenCalled();
    } finally {
      service.dispose();
      db.close();
    }
  });
});
