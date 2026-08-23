import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  inflatePersistedMessage,
  parseSdkMessageRow,
  projectBackgroundTaskMessageRow,
  projectSubagentMessageRow,
  projectTopLevelMessageRow,
} from '../../../../src/storage/repositories/sdk-message-projections';

const RAW_MALFORMED = '{not-json';
const TIMESTAMP = '2026-08-11T12:00:00.000Z';
const TIMESTAMP_MS = new Date(TIMESTAMP).getTime();

const rawAssistant = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'hello' }] },
});

describe('parseSdkMessageRow — malformed policy table', () => {
  test('parses valid JSON identically under every policy', () => {
    const expected = JSON.parse(rawAssistant) as SDKMessage;
    for (const policy of ['synthesize', 'skip', 'throw', 'null'] as const) {
      expect(parseSdkMessageRow(rawAssistant, policy)).toEqual(expected);
    }
  });

  test("policy 'synthesize' keeps the row as type=unknown carrying the raw payload", () => {
    expect(parseSdkMessageRow(RAW_MALFORMED, 'synthesize')).toEqual({
      type: 'unknown',
      rawContent: RAW_MALFORMED,
    });
  });

  test("policies 'skip' and 'null' yield null for malformed rows", () => {
    expect(parseSdkMessageRow(RAW_MALFORMED, 'skip')).toBeNull();
    expect(parseSdkMessageRow(RAW_MALFORMED, 'null')).toBeNull();
  });

  test("policy 'throw' propagates the parse failure", () => {
    expect(() => parseSdkMessageRow(RAW_MALFORMED, 'throw')).toThrow();
  });
});

describe('projectTopLevelMessageRow', () => {
  function topRow(overrides: Partial<Parameters<typeof projectTopLevelMessageRow>[0]> = {}) {
    return {
      id: 'row-1',
      sdk_message: rawAssistant,
      timestamp: TIMESTAMP,
      rowid: 7,
      origin: 'system',
      send_status: null,
      ...overrides,
    };
  }

  test('attaches row metadata around the parsed message', () => {
    const projected = projectTopLevelMessageRow(topRow());
    expect(projected.type).toBe('assistant');
    expect((projected as { id?: string }).id).toBe('row-1');
    expect(projected.timestamp).toBe(TIMESTAMP_MS);
    expect((projected as { rowid?: number }).rowid).toBe(7);
    expect((projected as { origin?: string }).origin).toBe('system');
  });

  test('normalizes null origin to an explicit undefined key', () => {
    const projected = projectTopLevelMessageRow(topRow({ origin: null }));
    expect('origin' in projected).toBe(true);
    expect((projected as { origin?: string }).origin).toBeUndefined();
  });

  test('coerces non-number rowid values', () => {
    expect((projectTopLevelMessageRow(topRow({ rowid: '42' })) as { rowid?: number }).rowid).toBe(
      42
    );
    expect((projectTopLevelMessageRow(topRow({ rowid: null })) as { rowid?: number }).rowid).toBe(
      0
    );
  });

  test('row metadata overrides same-named payload fields', () => {
    const projected = projectTopLevelMessageRow(
      topRow({
        sdk_message: JSON.stringify({
          type: 'assistant',
          id: 'payload-id',
          timestamp: 1,
          rowid: 99,
        }),
      })
    );
    expect((projected as { id?: string }).id).toBe('row-1');
    expect(projected.timestamp).toBe(TIMESTAMP_MS);
    expect((projected as { rowid?: number }).rowid).toBe(7);
  });

  test('maps send_status to deliveryStatus on user rows only', () => {
    const rawUser = JSON.stringify({ type: 'user', message: { content: 'hi' } });
    const projectUser = (send_status: unknown) =>
      projectTopLevelMessageRow(topRow({ sdk_message: rawUser, send_status }));

    expect((projectUser('enqueued') as { deliveryStatus?: string }).deliveryStatus).toBe('queued');
    expect((projectUser('failed') as { deliveryStatus?: string }).deliveryStatus).toBe('failed');
    expect((projectUser(null) as { deliveryStatus?: string }).deliveryStatus).toBe('delivered');
    expect('deliveryStatus' in projectUser('not-a-status')).toBe(false);
    expect('deliveryStatus' in projectTopLevelMessageRow(topRow({ send_status: 'enqueued' }))).toBe(
      false
    );
  });

  test('synthesizes type=unknown for malformed rows while keeping metadata', () => {
    const projected = projectTopLevelMessageRow(
      topRow({
        id: 'bad',
        sdk_message: RAW_MALFORMED,
        send_status: 'enqueued',
      })
    );
    expect(projected.type).toBe('unknown');
    expect((projected as { rawContent?: string }).rawContent).toBe(RAW_MALFORMED);
    expect((projected as { id?: string }).id).toBe('bad');
    expect((projected as { rowid?: number }).rowid).toBe(7);
    expect('deliveryStatus' in projected).toBe(false);
  });
});

describe('projectSubagentMessageRow', () => {
  test('attaches id, timestamp, and an explicit undefined origin', () => {
    const projected = projectSubagentMessageRow({
      id: 'sub-1',
      sdk_message: rawAssistant,
      timestamp: TIMESTAMP,
    });
    expect(projected.type).toBe('assistant');
    expect((projected as { id?: string }).id).toBe('sub-1');
    expect(projected.timestamp).toBe(TIMESTAMP_MS);
    expect('origin' in projected).toBe(true);
    expect((projected as { origin?: string }).origin).toBeUndefined();
    expect('rowid' in projected).toBe(false);
  });

  test('synthesizes type=unknown for malformed rows', () => {
    const projected = projectSubagentMessageRow({
      id: 'sub-bad',
      sdk_message: RAW_MALFORMED,
      timestamp: TIMESTAMP,
    });
    expect(projected.type).toBe('unknown');
    expect((projected as { rawContent?: string }).rawContent).toBe(RAW_MALFORMED);
  });
});

describe('projectBackgroundTaskMessageRow', () => {
  test('attaches id, timestamp, and null-normalized origin', () => {
    const projected = projectBackgroundTaskMessageRow({
      id: 'bg-1',
      sdk_message: JSON.stringify({ type: 'system', subtype: 'task_started' }),
      timestamp: TIMESTAMP,
      origin: null,
    });
    expect(projected.type).toBe('system');
    expect((projected as { id?: string }).id).toBe('bg-1');
    expect(projected.timestamp).toBe(TIMESTAMP_MS);
    expect((projected as { origin?: string }).origin).toBeUndefined();
  });

  test('synthesizes type=unknown for malformed rows', () => {
    const projected = projectBackgroundTaskMessageRow({
      id: 'bg-bad',
      sdk_message: RAW_MALFORMED,
      timestamp: TIMESTAMP,
      origin: 'system',
    });
    expect(projected.type).toBe('unknown');
    expect((projected as { rawContent?: string }).rawContent).toBe(RAW_MALFORMED);
    expect((projected as { origin?: string }).origin).toBe('system');
  });
});

describe('inflatePersistedMessage', () => {
  test('attaches dbId and timestamp', () => {
    const inflated = inflatePersistedMessage({
      id: 'db-1',
      sdk_message: rawAssistant,
      timestamp: TIMESTAMP,
    });
    expect(inflated.type).toBe('assistant');
    expect(inflated.dbId).toBe('db-1');
    expect(inflated.timestamp).toBe(TIMESTAMP_MS);
    expect((inflated as { id?: string }).id).toBeUndefined();
  });

  test('synthesizes type=unknown for malformed rows while keeping dbId', () => {
    const inflated = inflatePersistedMessage({
      id: 'db-bad',
      sdk_message: RAW_MALFORMED,
      timestamp: TIMESTAMP,
    });
    expect(inflated.type).toBe('unknown');
    expect((inflated as { rawContent?: string }).rawContent).toBe(RAW_MALFORMED);
    expect(inflated.dbId).toBe('db-bad');
  });
});
