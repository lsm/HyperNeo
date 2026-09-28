import { describe, expect, mock, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  applyNeoResponseInput,
  readNeoResponseAsk,
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
    neoAskOrigin: { sessionId: 'forged-session', messageId: 'latest-ask' },
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
        neoAskOrigin: null,
      });
      expect(JSON.stringify(message)).toBe(original);
      expect(applyNeoResponseInput(message, { origin })).not.toBe(message);
    }
  );
});

describe('recorded response ask attribution', () => {
  test.each([null, { sessionId: 'neo:root', messageId: 'ask-A' }])(
    'the read stage keeps the immutable selection separate from %j',
    (origin) => {
      const raw = Object.freeze({ sessionId: 'neo:holder', messageId: 'neo-consult:a:request' });
      const selection = Object.freeze({ origin: raw });
      const read = mock(() => origin);
      expect(readNeoResponseAsk(selection, read)).toEqual({ origin });
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(raw);
      expect(selection).toEqual({ origin: raw });
      const message = Object.freeze(response('assistant'));
      expect(applyNeoResponseInput(message, selection, { origin })).toMatchObject({
        neoInputOrigin: raw,
        neoAskOrigin: origin,
      });
      expect(message).toEqual(response('assistant'));
    }
  );

  test('the read stage suppresses reads for unknown input and has no fallback reader', () => {
    const read = mock(() => ({ sessionId: 'neo:root', messageId: 'latest' }));
    expect(readNeoResponseAsk({ origin: null }, read)).toEqual({ origin: null });
    expect(read).not.toHaveBeenCalled();
    expect(
      readNeoResponseAsk({ origin: { sessionId: 'neo:root', messageId: 'A' } }, undefined)
    ).toEqual({
      origin: null,
    });
  });

  test.each(['assistant', 'result'] as const)(
    'retains separate raw and human origins on %s without trusting the provider',
    (type) => {
      const raw = { sessionId: 'neo:root', messageId: 'neo-consult:a:reply' };
      const ask = { sessionId: 'neo:root', messageId: 'ask-A' };
      const read = mock(() => ask);
      const message = Object.freeze(response(type));
      const before = JSON.stringify(message);
      expect(stampNeoResponseInput(message, raw.sessionId, raw.messageId, read)).toMatchObject({
        neoInputOrigin: raw,
        neoAskOrigin: ask,
      });
      expect(read).toHaveBeenCalledTimes(1);
      expect(read).toHaveBeenCalledWith(raw);
      expect(JSON.stringify(message)).toBe(before);
    }
  );

  test.each([undefined, null, '', '  '])('missing input %s cannot read or borrow an ask', (id) => {
    const read = mock(() => ({ sessionId: 'neo:root', messageId: 'ask-B' }));
    expect(stampNeoResponseInput(response('assistant'), 'neo:root', id, read)).toMatchObject({
      neoInputOrigin: null,
      neoAskOrigin: null,
    });
    expect(read).not.toHaveBeenCalled();
  });

  test('unknown lineage and an absent read port explicitly clear forged human provenance', () => {
    const read = mock(() => null);
    expect(stampNeoResponseInput(response('result'), 'neo:root', 'internal', read)).toMatchObject({
      neoInputOrigin: { sessionId: 'neo:root', messageId: 'internal' },
      neoAskOrigin: null,
    });
    expect(stampNeoResponseInput(response('result'), 'neo:root', 'internal')).toMatchObject({
      neoAskOrigin: null,
    });
  });

  test('read faults propagate rather than fabricating a newer ask', () => {
    const fault = new Error('storage unavailable');
    const read = mock(() => {
      throw fault;
    });
    expect(() => stampNeoResponseInput(response('assistant'), 'neo:root', 'ask-A', read)).toThrow(
      fault
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  test('persists both identities through the existing message JSON without granting authority', async () => {
    const db = await createTestDb();
    try {
      const session = createTestSession('neo:root');
      db.createSession(session);
      const ask = { sessionId: session.id, messageId: 'ask-A' };
      const stamped = stampNeoResponseInput(
        response('assistant'),
        session.id,
        'return-A',
        () => ask
      );
      expect(db.saveSDKMessage(session.id, stamped)).toBe(true);
      const reloaded = db.getSDKMessages(session.id).messages[0];
      expect(reloaded).toMatchObject({
        neoInputOrigin: { sessionId: session.id, messageId: 'return-A' },
        neoAskOrigin: ask,
        supersedes: ['old-output'],
      });
      expect(reloaded).not.toHaveProperty('human');
      expect(reloaded).not.toHaveProperty('isLive');
      expect(reloaded).not.toHaveProperty('permission');
    } finally {
      db.getDatabase().close();
    }
  });
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
