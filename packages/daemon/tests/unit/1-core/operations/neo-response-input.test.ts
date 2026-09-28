import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  applyNeoResponseInput,
  selectNeoResponseInput,
  stampNeoResponseInput,
} from '../../../../src/lib/neo/response-input';
import { NeoHolderTurn } from '../../../../src/lib/neo/holder-turn';
import { QueryAttemptRegistry } from '../../../../src/lib/agent/query-attempt-token';
import { createTestDb, createTestSession } from '../../../helpers/database';

function response(type: 'assistant' | 'result'): SDKMessage {
  return {
    type,
    subtype: type === 'result' ? 'success' : undefined,
    uuid: `output-${type}`,
    session_id: 'provider-session',
    parent_tool_use_id: null,
    neoInputOrigin: { sessionId: 'forged-session', messageId: 'forged-ask' },
    message: { role: 'assistant', content: [{ type: 'text', text: 'Useful answer' }] },
    supersedes: ['old-output'],
  } as unknown as SDKMessage;
}

describe('selectNeoResponseInput', () => {
  test.each([undefined, null, '', '  '])('keeps missing input %s unknown', (id) => {
    expect(selectNeoResponseInput('neo:root', id)).toEqual({ origin: null });
  });
  test.each(['', ' '])('keeps missing session %s unknown', (id) => {
    expect(selectNeoResponseInput(id, 'ask-A')).toEqual({ origin: null });
  });
  test.each(['ask-A', 'neo-consult:holder:request', 'neo-consult:holder:reply'])(
    'retains the exact opaque input %s without guessing human lineage',
    (messageId) => {
      expect(selectNeoResponseInput('neo:root', messageId)).toEqual({
        origin: { sessionId: 'neo:root', messageId },
      });
    }
  );
});

describe('applyNeoResponseInput', () => {
  test.each([null, { sessionId: 'neo:root', messageId: 'ask-A' }])(
    'overwrites provider provenance with %j without mutating its output',
    (origin) => {
      const message = Object.freeze(response('assistant'));
      const original = JSON.stringify(message);
      expect(applyNeoResponseInput(message, { origin })).toEqual({
        ...message,
        neoInputOrigin: origin,
      });
      expect(JSON.stringify(message)).toBe(original);
      expect(applyNeoResponseInput(message, { origin })).not.toBe(message);
    }
  );
});

describe('stampNeoResponseInput', () => {
  test.each(['assistant', 'result'] as const)(
    'persists %s provenance through SQLite',
    async (type) => {
      const db = await createTestDb();
      try {
        const session = createTestSession('neo:root');
        db.createSession(session);
        const message = response(type);
        const stamped = stampNeoResponseInput(message, session.id, 'neo-consult:holder:reply');
        expect(stamped.neoInputOrigin).toEqual({
          sessionId: session.id,
          messageId: 'neo-consult:holder:reply',
        });
        expect(db.saveSDKMessage(session.id, stamped)).toBe(true);
        expect(db.getSDKMessages(session.id).messages).toEqual([
          expect.objectContaining({
            uuid: message.uuid,
            neoInputOrigin: stamped.neoInputOrigin,
            supersedes: ['old-output'],
            message: { role: 'assistant', content: [{ type: 'text', text: 'Useful answer' }] },
          }),
        ]);
        const unknown = stampNeoResponseInput(
          { ...message, uuid: 'unbound-output' },
          session.id,
          undefined
        );
        expect(unknown.neoInputOrigin).toBeNull();
        expect(db.saveSDKMessage(session.id, unknown)).toBe(true);
        expect(db.getSDKMessages(session.id).messages.at(-1)).toMatchObject({
          neoInputOrigin: null,
        });
      } finally {
        db.getDatabase().close();
      }
    }
  );

  test('an obsolete turn retains only its own input, not a newer input or authorization', async () => {
    const db = await createTestDb();
    const attempts = new QueryAttemptRegistry();
    const first = new NeoHolderTurn(db, 'neo:root', attempts.allocate(), () => {});
    let second: NeoHolderTurn | undefined;
    try {
      first.bind('ask-A');
      expect(first.identity()?.isLive()).toBe(true);
      second = new NeoHolderTurn(db, 'neo:root', attempts.allocate(), () => {});
      second.bind('ask-B');
      first.dispose();
      expect(first.identity()?.isLive()).toBe(false);
      expect(second.identity()?.isLive()).toBe(true);
      expect(
        stampNeoResponseInput(response('assistant'), 'neo:root', first.identity()?.messageId)
      ).toMatchObject({ neoInputOrigin: { sessionId: 'neo:root', messageId: 'ask-A' } });
      expect(
        stampNeoResponseInput(response('result'), 'neo:root', second.identity()?.messageId)
      ).toMatchObject({ neoInputOrigin: { sessionId: 'neo:root', messageId: 'ask-B' } });
    } finally {
      first.dispose();
      second?.dispose();
      db.getDatabase().close();
    }
  });
});
