import { describe, expect, test } from 'bun:test';
import type { SDKMessage } from '@hyperneo/shared/sdk';
import {
  buildRowIdHydrationBatches,
  collectToolUseIds,
  composeMessagePage,
  extractFirstTextBlockContent,
  extractTextBlockContents,
  extractToolCallNames,
  extractVisibleText,
  inflatePersistedMessage,
  orderHydratedMessages,
  parseSdkMessageRow,
  projectBackgroundTaskMessageRow,
  projectRenderableTextRow,
  projectSubagentMessageRow,
  projectTopLevelMessageRow,
  resolveRenderableTextScanBudget,
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

describe('collectToolUseIds', () => {
  function pageMessage(raw: object): SDKMessage & { timestamp: number } {
    return { ...raw, timestamp: TIMESTAMP_MS } as SDKMessage & { timestamp: number };
  }

  test('collects tool_use ids from assistant messages in page order, deduped', () => {
    const messages = [
      pageMessage({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu-1', name: 'Task' },
            { type: 'tool_use', id: 'tu-2', name: 'Read' },
          ],
        },
      }),
      pageMessage({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'no tools here' }] },
      }),
      pageMessage({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tu-1', name: 'Task' }],
        },
      }),
    ];

    expect(collectToolUseIds(messages)).toEqual(['tu-1', 'tu-2']);
  });

  test('ignores non-assistant messages, string content, and id-less tool blocks', () => {
    const messages = [
      pageMessage({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_use', id: 'tu-user', name: 'Task' }] },
      }),
      pageMessage({ type: 'user', message: { role: 'user', content: 'plain string' } }),
      pageMessage({ type: 'assistant', message: { role: 'assistant', content: 'plain string' } }),
      pageMessage({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'tool_use', name: 'NoId' }],
        },
      }),
    ];

    expect(collectToolUseIds(messages)).toEqual([]);
  });
});

describe('composeMessagePage', () => {
  const rawAssistantText = (text: string) =>
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    });

  const rawAssistantToolUse = (toolUseId: string) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'Task' }],
      },
    });

  function topLevelRow(
    id: string,
    sdkMessage: string,
    timestamp: string,
    rowid: number
  ): Parameters<typeof composeMessagePage>[0][number] {
    return { id, sdk_message: sdkMessage, timestamp, rowid, origin: null, send_status: null };
  }

  function subagentRow(
    id: string,
    timestamp: string
  ): Parameters<typeof projectSubagentMessageRow>[0] {
    return { id, sdk_message: rawAssistantText(`sub ${id}`), timestamp };
  }

  function firstText(message: SDKMessage): string | undefined {
    const content = (message as { message?: { content?: Array<{ type: string; text?: string }> } })
      .message?.content;
    return (content ?? []).find((block) => block.type === 'text')?.text;
  }

  test('reverses newest-first rows into chronological order and stops at the limit', () => {
    const rows = [
      topLevelRow('row-new', rawAssistantText('Newest'), '2026-08-11T10:02:00.000Z', 3),
      topLevelRow('row-mid', rawAssistantText('Middle'), '2026-08-11T10:01:00.000Z', 2),
      topLevelRow('row-old', rawAssistantText('Oldest'), '2026-08-11T10:00:00.000Z', 1),
    ];

    const { messages, hasMore } = composeMessagePage(rows, 2, () => []);

    expect(messages.map(firstText)).toEqual(['Middle', 'Newest']);
    expect(hasMore).toBe(true);
  });

  test('hasMore stays false when the top-level page is shorter than the limit', () => {
    const rows = [topLevelRow('row-a', rawAssistantText('A'), '2026-08-11T10:00:00.000Z', 1)];

    const { messages, hasMore } = composeMessagePage(rows, 2, () => []);

    expect(messages).toHaveLength(1);
    expect(hasMore).toBe(false);
  });

  test('appends subagent rows after the whole top-level page, projected with row metadata', () => {
    const rows = [
      topLevelRow('top-b', rawAssistantToolUse('tu-1'), '2026-08-11T10:04:00.000Z', 2),
      topLevelRow('top-a', rawAssistantText('Top A'), '2026-08-11T10:01:00.000Z', 1),
    ];
    const subRows = [
      subagentRow('sub-1', '2026-08-11T10:02:00.000Z'),
      subagentRow('sub-2', '2026-08-11T10:03:00.000Z'),
    ];

    const { messages, hasMore } = composeMessagePage(rows, 2, () => subRows);

    expect(messages.map((message) => (message as { id?: string }).id)).toEqual([
      'top-a',
      'top-b',
      'sub-1',
      'sub-2',
    ]);
    expect(messages).toHaveLength(4);
    expect(hasMore).toBe(true);
  });

  test('never reports hasMore from subagent fan-out alone', () => {
    const rows = [topLevelRow('top', rawAssistantToolUse('tu-1'), '2026-08-11T10:00:00.000Z', 1)];
    const subRows = Array.from({ length: 6 }, (_, index) =>
      subagentRow(`sub-${index}`, `2026-08-11T10:00:0${index}.000Z`)
    );

    const { messages, hasMore } = composeMessagePage(rows, 2, () => subRows);

    expect(messages).toHaveLength(7);
    expect(hasMore).toBe(false);
  });

  test('fans out once with every deduped tool-use id when the page has tool uses', () => {
    const rows = [
      topLevelRow('top-b', rawAssistantToolUse('tu-2'), '2026-08-11T10:03:00.000Z', 2),
      topLevelRow('top-a', rawAssistantToolUse('tu-1'), '2026-08-11T10:01:00.000Z', 1),
      topLevelRow('top-c', rawAssistantToolUse('tu-1'), '2026-08-11T10:00:00.000Z', 0),
    ];
    const fetchedIds: string[][] = [];
    composeMessagePage(rows, 3, (toolUseIds) => {
      fetchedIds.push(toolUseIds);
      return [];
    });

    expect(fetchedIds).toEqual([['tu-1', 'tu-2']]);
  });

  test('skips the subagent fetch entirely when the page has no tool uses', () => {
    const rows = [topLevelRow('top', rawAssistantText('No tools'), '2026-08-11T10:00:00.000Z', 1)];
    let fetchCount = 0;

    const { messages } = composeMessagePage(rows, 1, () => {
      fetchCount += 1;
      return [subagentRow('sub-1', '2026-08-11T10:00:01.000Z')];
    });

    expect(fetchCount).toBe(0);
    expect(messages).toHaveLength(1);
  });

  test('collects tool-use ids from the truncated page only — off-page rows fan out nothing', () => {
    const rows = [
      topLevelRow('top-b', rawAssistantToolUse('tu-b'), '2026-08-11T10:03:00.000Z', 1),
      topLevelRow('top-a', rawAssistantToolUse('tu-a'), '2026-08-11T10:02:00.000Z', 0),
    ];
    const fetchedIds: string[][] = [];
    composeMessagePage(rows, 1, (toolUseIds) => {
      fetchedIds.push(toolUseIds);
      return [subagentRow('sub-b', '2026-08-11T10:03:01.000Z')];
    });

    expect(fetchedIds).toEqual([['tu-b']]);
  });
});

describe('extractTextBlockContents — policy-parameterized block walk', () => {
  const msg = {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'text', text: 'First' },
        { type: 'tool_use', id: 'tu-1', name: 'Read' },
        { type: 'text', text: 'Second' },
        { type: 'text', text: 'Third' },
      ],
    },
  };

  test("policy 'join-all' collects every text block in content order", () => {
    expect(extractTextBlockContents(msg, 'join-all')).toEqual(['First', 'Second', 'Third']);
  });

  test("policy 'first-block-only' stops at the first text block", () => {
    expect(extractTextBlockContents(msg, 'first-block-only')).toEqual(['First']);
  });

  test('returns string content as a single element under both policies', () => {
    const stringContent = { type: 'user', message: { role: 'user', content: 'Plain' } };
    expect(extractTextBlockContents(stringContent, 'join-all')).toEqual(['Plain']);
    expect(extractTextBlockContents(stringContent, 'first-block-only')).toEqual(['Plain']);
  });

  test('returns an empty array for missing, null, or text-free content under both policies', () => {
    for (const policy of ['first-block-only', 'join-all'] as const) {
      expect(extractTextBlockContents({ type: 'user' }, policy)).toEqual([]);
      expect(
        extractTextBlockContents({ type: 'user', message: { content: null } }, policy)
      ).toEqual([]);
      expect(
        extractTextBlockContents(
          { type: 'user', message: { content: [{ type: 'tool_use', id: 'tu-1' }] } },
          policy
        )
      ).toEqual([]);
    }
  });

  test('both shapers delegate to the shared walk with their pinned policies', () => {
    expect(extractVisibleText(msg)).toBe('First\n\nSecond\n\nThird');
    expect(extractFirstTextBlockContent(msg as unknown as SDKMessage)).toBe('First');
  });
});

describe('extractVisibleText — join-all policy', () => {
  test('joins every text block with blank lines and trims the result', () => {
    const msg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: ' Alpha' },
          { type: 'tool_use', id: 'tu-1', name: 'Read' },
          { type: 'text', text: 'Beta ' },
        ],
      },
    };
    expect(extractVisibleText(msg)).toBe('Alpha\n\nBeta');
  });

  test('returns string content directly', () => {
    const msg = { type: 'user', message: { role: 'user', content: 'Plain string' } };
    expect(extractVisibleText(msg)).toBe('Plain string');
  });

  test('appends the result field for result messages', () => {
    const msg = { type: 'result', result: 'Final result', message: { content: null } };
    expect(extractVisibleText(msg)).toBe('Final result');
  });

  test('returns an empty string when no text content exists', () => {
    const msg = {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Read' }] },
    };
    expect(extractVisibleText(msg)).toBe('');
    expect(extractVisibleText({ type: 'assistant' })).toBe('');
  });
});

describe('extractToolCallNames', () => {
  test('collects tool_use block names in content order', () => {
    const msg = {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'Read' },
          { type: 'text', text: 'interlude' },
          { type: 'tool_use', id: 'tu-2', name: 'Edit' },
        ],
      },
    };
    expect(extractToolCallNames(msg)).toEqual(['Read', 'Edit']);
  });

  test('returns an empty array for text-only or string content', () => {
    expect(
      extractToolCallNames({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
      })
    ).toEqual([]);
    expect(
      extractToolCallNames({ type: 'user', message: { role: 'user', content: 'hi' } })
    ).toEqual([]);
  });
});

describe('extractFirstTextBlockContent — first-block-only policy', () => {
  test('returns only the first text block with whitespace preserved, unlike the join-all policy', () => {
    const message = {
      type: 'user',
      uuid: 'uuid-blocks',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: ' Padded first ' },
          { type: 'text', text: 'Second block' },
        ],
      },
    } as unknown as SDKMessage;

    expect(extractFirstTextBlockContent(message)).toBe(' Padded first ');
    expect(extractVisibleText(message as unknown as Record<string, unknown>)).toBe(
      'Padded first \n\nSecond block'
    );
  });

  test('returns string content verbatim', () => {
    const message = {
      type: 'user',
      message: { role: 'user', content: 'Simple string content' },
    } as unknown as SDKMessage;
    expect(extractFirstTextBlockContent(message)).toBe('Simple string content');
  });

  test('returns an empty string when no text block or content exists', () => {
    const toolOnly = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', id: 'tu-1' }] },
    } as unknown as SDKMessage;
    expect(extractFirstTextBlockContent(toolOnly)).toBe('');
    expect(extractFirstTextBlockContent({ type: 'user', uuid: 'u' } as unknown as SDKMessage)).toBe(
      ''
    );
    expect(
      extractFirstTextBlockContent({
        type: 'user',
        message: { role: 'user', content: '' },
      } as unknown as SDKMessage)
    ).toBe('');
  });
});

describe('projectRenderableTextRow', () => {
  function renderableRow(overrides: Partial<Parameters<typeof projectRenderableTextRow>[0]> = {}) {
    return {
      id: 'row-1',
      message_type: 'assistant',
      sdk_message: JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Visible' }] },
      }),
      timestamp: TIMESTAMP,
      ...overrides,
    };
  }

  test('projects a row with visible text and row metadata', () => {
    expect(projectRenderableTextRow(renderableRow({ message_type: 'user', id: 'u-1' }))).toEqual({
      id: 'u-1',
      type: 'user',
      text: 'Visible',
      timestamp: TIMESTAMP_MS,
    });
  });

  test('skips rows whose visible text is empty', () => {
    const row = renderableRow({
      sdk_message: JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'Read' }] },
      }),
    });
    expect(projectRenderableTextRow(row)).toBeNull();
  });

  test('skips malformed rows', () => {
    expect(projectRenderableTextRow(renderableRow({ sdk_message: RAW_MALFORMED }))).toBeNull();
  });
});

describe('resolveRenderableTextScanBudget', () => {
  test('is max(limit, 250): small limits get the 250-row floor, larger limits grow', () => {
    expect(resolveRenderableTextScanBudget(1)).toBe(250);
    expect(resolveRenderableTextScanBudget(20)).toBe(250);
    expect(resolveRenderableTextScanBudget(250)).toBe(250);
    expect(resolveRenderableTextScanBudget(400)).toBe(400);
  });
});

describe('buildRowIdHydrationBatches', () => {
  test('returns no batches for an empty projection', () => {
    expect(buildRowIdHydrationBatches([])).toEqual([]);
  });

  test('keeps a window within the batch size in one batch with one placeholder per row', () => {
    const batches = buildRowIdHydrationBatches([{ row_id: 3 }, { row_id: 1 }, { row_id: 2 }]);

    expect(batches).toHaveLength(1);
    expect(batches[0].rowIds).toEqual([3, 1, 2]);
    expect(batches[0].placeholders).toBe('?, ?, ?');
  });

  test('splits 901 projected rows into 900 + 1 at the hydration batch boundary', () => {
    const projected = Array.from({ length: 901 }, (_, row_id) => ({ row_id }));

    const batches = buildRowIdHydrationBatches(projected);

    expect(batches.map((batch) => batch.rowIds.length)).toEqual([900, 1]);
    expect(batches[0].rowIds[0]).toBe(0);
    expect(batches[0].rowIds[899]).toBe(899);
    expect(batches[1].rowIds).toEqual([900]);
    expect(batches[0].placeholders.split(', ')).toHaveLength(900);
    expect(batches[1].placeholders).toBe('?');
  });
});

describe('orderHydratedMessages', () => {
  test('preserves projected order regardless of hydration insertion order', () => {
    const projected = [{ row_id: 3 }, { row_id: 1 }, { row_id: 2 }];
    const hydrated = new Map([
      [1, 'one'],
      [3, 'three'],
      [2, 'two'],
    ]);

    expect(orderHydratedMessages(projected, hydrated)).toEqual(['three', 'one', 'two']);
  });

  test('drops row ids that did not hydrate', () => {
    const projected = [{ row_id: 3 }, { row_id: 9 }, { row_id: 1 }];
    const hydrated = new Map([
      [1, 'one'],
      [3, 'three'],
    ]);

    expect(orderHydratedMessages(projected, hydrated)).toEqual(['three', 'one']);
    expect(orderHydratedMessages([{ row_id: 9 }], new Map())).toEqual([]);
  });
});
