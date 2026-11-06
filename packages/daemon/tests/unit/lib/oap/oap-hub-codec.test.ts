import { describe, expect, test } from 'bun:test';

const codec = () => import('../../../../src/lib/oap/oap-hub-codec');

describe('OAP hub wire codec', () => {
  test('decodes a real hub refusal that also carries a null result', async () => {
    const { decodeOapHubLine } = await codec();
    expect(
      decodeOapHubLine(
        '{"id":2,"ok":false,"result":null,"error":{"code":"unknown_session","message":"Synthetic missing session"}}'
      )
    ).toEqual({
      kind: 'refusal',
      id: 2,
      code: 'unknown_session',
      message: 'Synthetic missing session',
      retryable: false,
    });
  });

  test('ok:false preserves its refusal code and only busy permits resending', async () => {
    const { decodeOapHubLine } = await codec();
    for (const code of ['busy', 'unknown_session', 'internal', 'invalid_request']) {
      expect(
        decodeOapHubLine(
          JSON.stringify({ id: 7, ok: false, error: { code, message: 'Synthetic refusal' } })
        )
      ).toEqual({
        kind: 'refusal',
        id: 7,
        code,
        message: 'Synthetic refusal',
        retryable: code === 'busy',
      });
    }
  });

  test('event lines route by subscription id and retain envelope and cursor fields', async () => {
    const { decodeOapHubLine } = await codec();
    for (const id of [12, 19]) {
      const data = {
        id,
        event: 'envelope',
        session_id: 'synthetic',
        sequence: 5,
        envelope: { type: 'content.delta', payload: { text: 'Hello' } },
      };
      expect(decodeOapHubLine(JSON.stringify(data))).toEqual({
        kind: 'event',
        id,
        event: 'envelope',
        data,
      });
    }
    const data = { id: 12, event: 'oap-replay-gap', oldest_available: 3, latest_available: 8 };
    expect(decodeOapHubLine(JSON.stringify(data))).toEqual({
      kind: 'event',
      id: 12,
      event: 'oap-replay-gap',
      data,
    });
  });

  test('responses preserve arbitrary results including subscription acknowledgments', async () => {
    const { decodeOapHubLine } = await codec();
    for (const result of [null, false, [], { session_id: 'synthetic' }])
      expect(decodeOapHubLine(JSON.stringify({ id: -2, ok: true, result }))).toEqual({
        kind: 'response',
        id: -2,
        result,
      });
  });

  test.each([
    'broken',
    'null',
    '[]',
    '{}',
    '{"id":1,"ok":true}',
    '{"id":"1","ok":true,"result":null}',
    '{"id":1.5,"ok":true,"result":null}',
    '{"id":9007199254740992,"ok":true,"result":null}',
    '{"id":1,"ok":false,"error":{"message":"missing code"}}',
    '{"id":1,"event":"envelope","ok":true,"result":null}',
    '{"type":"run.completed","payload":{}}',
  ])('rejects a malformed hub line %s', async (line) => {
    expect((await codec()).decodeOapHubLine.bind(null, line)).toThrow();
  });

  test('encodes one newline-delimited hub request without altering its envelope', async () => {
    const { encodeOapHubRequest } = await codec();
    const parameters = {
      adapter: 'memory',
      request: { type: 'session.open.request', payload: { session_id: 'synthetic' } },
    };
    const line = encodeOapHubRequest(2, 'open', parameters);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.split('\n')).toHaveLength(2);
    expect(JSON.parse(line)).toEqual({ id: 2, op: 'open', ...parameters });
    expect(encodeOapHubRequest(0, 'adapters')).toBe('{"id":0,"op":"adapters"}\n');
    expect(parameters.request.payload.session_id).toBe('synthetic');
  });

  test('rejects unsafe ids and parameters that replace correlation fields', async () => {
    const { encodeOapHubRequest } = await codec();
    expect(() => encodeOapHubRequest(Number.MAX_SAFE_INTEGER + 1, 'adapters')).toThrow();
    expect(() => encodeOapHubRequest(1, '')).toThrow();
    expect(() => encodeOapHubRequest(1, 'adapters', { id: 99 })).toThrow();
    expect(() => encodeOapHubRequest(1, 'adapters', { op: 'shutdown' })).toThrow();
  });
});
