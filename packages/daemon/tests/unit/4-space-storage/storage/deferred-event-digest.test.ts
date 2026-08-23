import { describe, expect, it } from 'bun:test';
import {
  buildDeferredEventDigestEnvelopeText,
  buildExternalEventDigestMessage,
  DEFERRED_EXTERNAL_EVENT_ROW_CAP,
  type DeferredDeliveryRow,
  type DeferredEventDigestRowOps,
  deferredExternalEventEntryEvents,
  foldDeferredExternalEventOverflow,
  foldDeferredExternalEventsAtFlush,
  parseDeferredDeliveryRow,
  parseDeferredExternalEventText,
  partitionDeferredExternalEventRows,
  planDeferredExternalEventOverflow,
} from '../../../../src/lib/external-events/deferred-event-digest';
import { formatExternalEventEssence } from '../../../../src/lib/external-events/event-essence';
import {
  classifyExternalEventTier,
  EXTERNAL_EVENT_TOPIC_TIERS,
  externalEventTopicSuffix,
} from '../../../../src/lib/external-events/event-tiers';
import type { ExternalEventPublishedPayload } from '../../../../src/lib/external-events/external-event-service';

const PR_URL = 'https://github.com/lsm/HyperNeo/pull/2828';

function at(hour: number, minute = 0): number {
  return Date.UTC(2026, 7, 23, hour, minute);
}

interface EssenceArgs {
  eventId: string;
  topic: string;
  eventType: string;
  occurredAt: number;
  action?: string;
  actor?: string;
  prNumber?: number;
  body?: string;
  extra?: Record<string, unknown>;
}

function essenceText(args: EssenceArgs): string {
  const event: ExternalEventPublishedPayload = {
    namespaceId: 'ns',
    spaceId: 'space-1',
    eventId: args.eventId,
    source: 'github',
    topic: args.topic,
    dedupeKey: args.eventId,
    summary: 'summary',
    externalUrl: `${PR_URL}#${args.eventId}`,
    occurredAt: args.occurredAt,
    ingestedAt: args.occurredAt,
    payload: {
      eventType: args.eventType,
      action: args.action ?? 'polled',
      actor: args.actor ?? 'codex[bot]',
      repoOwner: 'lsm',
      repoName: 'HyperNeo',
      prNumber: args.prNumber ?? 2828,
      prUrl: PR_URL,
      body: args.body ?? '',
      ...args.extra,
    },
  };
  return formatExternalEventEssence(event);
}

function row(dbId: string, uuid: string, text: string): DeferredDeliveryRow {
  return {
    type: 'user',
    uuid,
    session_id: 'session-1',
    parent_tool_use_id: null,
    dbId,
    timestamp: 0,
    message: { role: 'user', content: [{ type: 'text', text }] },
  } as DeferredDeliveryRow;
}

function checkText(eventId: string, occurredAt: number, conclusion: string): string {
  return essenceText({
    eventId,
    topic: 'github/lsm/hyperneo/pull_request/2828.check_failed',
    eventType: 'check_run',
    occurredAt,
    extra: { checkName: 'Build Binary (linux-x64)', conclusion },
  });
}

describe('external event tier registry', () => {
  it('maps the known topic suffixes to the digest tier', () => {
    expect(EXTERNAL_EVENT_TOPIC_TIERS.review_comment_polled).toBe('digest');
    expect(EXTERNAL_EVENT_TOPIC_TIERS.check_failed).toBe('digest');
    expect(EXTERNAL_EVENT_TOPIC_TIERS.polled).toBe('digest');
    expect(EXTERNAL_EVENT_TOPIC_TIERS.comment_polled).toBe('digest');
    expect(EXTERNAL_EVENT_TOPIC_TIERS.reaction_added).toBe('digest');
  });

  it('classifies unknown suffixes as digest', () => {
    expect(classifyExternalEventTier('github/lsm/hyperneo/pull_request/9.made_up_suffix')).toBe(
      'digest'
    );
    expect(classifyExternalEventTier('weird-topic-without-suffix')).toBe('digest');
  });

  it('extracts the suffix after the final dot', () => {
    expect(externalEventTopicSuffix('github/lsm/hyperneo/pull_request/2828.check_failed')).toBe(
      'check_failed'
    );
    expect(externalEventTopicSuffix('plain')).toBe('plain');
  });
});

describe('parseDeferredExternalEventText', () => {
  it('parses a formatted external event essence payload', () => {
    const text = essenceText({
      eventId: 'evt-1',
      topic: 'github/lsm/hyperneo/pull_request/2828.reaction_added',
      eventType: 'reaction',
      occurredAt: at(15, 10),
      action: 'added',
      actor: 'marcliu',
      body: '👍',
    });
    const entry = parseDeferredExternalEventText(text);
    expect(entry?.kind).toBe('event');
    if (entry?.kind !== 'event') return;
    expect(entry.essence.eventId).toBe('evt-1');
    expect(entry.essence.topic).toBe('github/lsm/hyperneo/pull_request/2828.reaction_added');
    expect(entry.essence.actor).toBe('marcliu');
    expect(entry.essence.prNumber).toBe(2828);
    expect(entry.essence.occurredAt).toBe(at(15, 10));
  });

  it('parses an early-fold digest envelope back into its events', () => {
    const events = deferredExternalEventEntryEvents({
      kind: 'event',
      essence: {
        eventId: 'evt-1',
        topic: 'github/lsm/hyperneo/pull_request/2828.check_failed',
      },
    });
    const envelope = buildDeferredEventDigestEnvelopeText(events);
    const parsed = parseDeferredExternalEventText(envelope);
    expect(parsed?.kind).toBe('fold');
    if (parsed?.kind !== 'fold') return;
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0]?.eventId).toBe('evt-1');
  });

  it('parses the space-runtime rate-limit digest text as foldable events', () => {
    const annotated =
      '2 events received for topics: github/o/r/pull_request/7.check_failed ' +
      '(oldest: 2026-08-23T15:00:00.000Z, newest: 2026-08-23T16:00:00.000Z). ' +
      'Event IDs: rl-1 (github/o/r/pull_request/7.check_failed), ' +
      'rl-2 (github/o/r/pull_request/7.check_failed). ' +
      'Use get_external_event(eventId) for full details.';
    const entry = parseDeferredExternalEventText(annotated);
    expect(entry?.kind).toBe('fold');
    if (entry?.kind !== 'fold') return;
    expect(entry.events).toHaveLength(2);
    expect(entry.events[0]).toMatchObject({
      eventId: 'rl-1',
      topic: 'github/o/r/pull_request/7.check_failed',
    });
    expect(entry.events[1]).toMatchObject({ eventId: 'rl-2' });

    const legacy =
      '1 events received for topics: github/o/r/pull_request/7.check_failed ' +
      '(oldest: 2026-08-23T15:00:00.000Z, newest: 2026-08-23T16:00:00.000Z). ' +
      'Event IDs: rl-legacy. Use get_external_event(eventId) for full details.';
    const legacyEntry = parseDeferredExternalEventText(legacy);
    expect(legacyEntry?.kind).toBe('fold');
    if (legacyEntry?.kind !== 'fold') return;
    expect(legacyEntry.events[0]).toMatchObject({
      eventId: 'rl-legacy',
      topic: 'github/o/r/pull_request/7.check_failed',
    });
  });

  it('returns null for non-external-event text', () => {
    expect(parseDeferredExternalEventText('a human follow-up')).toBeNull();
    expect(parseDeferredExternalEventText('{"type":"chat","topic":"x"}')).toBeNull();
    expect(parseDeferredExternalEventText('not json')).toBeNull();
    expect(parseDeferredExternalEventText('{"type":"external_event","topic":"t"}')).toBeNull();
  });
});

describe('parseDeferredDeliveryRow', () => {
  it('reads the essence from a deferred delivery row', () => {
    const text = checkText('chk-1', at(16, 34), 'failure');
    const entry = parseDeferredDeliveryRow(row('db-1', 'u-1', text));
    expect(entry?.kind).toBe('event');
    if (entry?.kind !== 'event') return;
    expect(entry.essence.checkName).toBe('Build Binary (linux-x64)');
  });
});

describe('buildExternalEventDigestMessage', () => {
  it('collapses a mixed incident-shaped backlog into one grouped summary', () => {
    const events: string[] = [];
    for (let i = 0; i < 6; i++) {
      events.push(checkText(`chk-c-${i}`, at(15, 5 + i), 'canceled'));
    }
    for (let i = 0; i < 4; i++) {
      events.push(checkText(`chk-f-${i}`, at(15, 40 + i), 'failure'));
    }
    events.push(checkText('check-11', at(16, 34), 'failure'));
    for (let i = 0; i < 3; i++) {
      events.push(
        essenceText({
          eventId: `rc-${i + 1}`,
          topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
          eventType: 'pull_request_review_comment',
          occurredAt: [at(15, 50), at(16), at(16, 20)][i]!,
          body: i === 2 ? 'latest review body' : `review body ${i + 1}`,
          extra: {
            commentId: `rc-${i + 1}`,
            inReplyToId: 'rc-thread-1',
            path: 'packages/daemon/src/lib/agent/query-mode-handler.ts',
            line: 88,
          },
        })
      );
    }
    events.push(
      essenceText({
        eventId: 'rc-4',
        topic: 'github/lsm/hyperneo/pull_request/2828.review_comment_polled',
        eventType: 'pull_request_review_comment',
        occurredAt: at(16, 25),
        body: 'standalone review',
        extra: {
          commentId: 'rc-4',
          path: 'packages/web/src/app.tsx',
          line: 12,
        },
      })
    );
    for (let i = 0; i < 5; i++) {
      events.push(
        essenceText({
          eventId: `pc-${i + 1}`,
          topic: 'github/lsm/hyperneo/pull_request/2828.comment_polled',
          eventType: 'issue_comment',
          occurredAt: at(15, 30 + i),
          actor: 'marcliu',
          body: i === 4 ? 'latest pr comment' : `pr comment ${i + 1}`,
          extra: { commentId: `pc-${i + 1}` },
        })
      );
    }
    for (let i = 0; i < 8; i++) {
      events.push(
        essenceText({
          eventId: `st-${i + 1}`,
          topic: 'github/lsm/hyperneo/pull_request/2828.polled',
          eventType: 'pull_request',
          occurredAt: at(16, 0 + i * 5),
          extra: { state: 'open' },
        })
      );
    }
    events.push(
      essenceText({
        eventId: 're-1',
        topic: 'github/lsm/hyperneo/pull_request/2828.reaction_added',
        eventType: 'reaction',
        occurredAt: at(15, 5),
        action: 'added',
        actor: 'marcliu',
        body: '👍',
      })
    );
    events.push(
      essenceText({
        eventId: 're-2',
        topic: 'github/lsm/hyperneo/pull_request/2828.reaction_added',
        eventType: 'reaction',
        occurredAt: at(15, 10),
        action: 'added',
        actor: 'marcliu',
        body: '🚀',
      })
    );

    const essences = events
      .map((text) => parseDeferredExternalEventText(text))
      .flatMap((entry) => (entry ? deferredExternalEventEntryEvents(entry) : []));

    const digest = buildExternalEventDigestMessage(essences);
    const lines = digest.split('\n');

    expect(lines).toHaveLength(11);
    expect(lines[0]).toBe('External events while you were working (30 events, PR #2828):');
    expect(lines[1]).toBe(
      '- CI check "Build Binary (linux-x64)": 11 runs (canceled ×6, failure ×5), ' +
        `latest 16:34 UTC (most cancelled, likely superseded by newer pushes) — ${PR_URL}#check-11`
    );
    expect(lines[2]).toBe(
      '- Review comments on packages/daemon/src/lib/agent/query-mode-handler.ts:L88: ×3, ' +
        `latest by codex[bot] at 16:20 UTC — "latest review body" — ${PR_URL}#rc-3`
    );
    expect(lines[3]).toBe(
      `- Review comment on packages/web/src/app.tsx:L12: ×1, ` +
        `latest by codex[bot] at 16:25 UTC — "standalone review" — ${PR_URL}#rc-4`
    );
    for (let i = 0; i < 5; i++) {
      const body = i === 4 ? 'latest pr comment' : `pr comment ${i + 1}`;
      expect(lines[4 + i]).toBe(
        `- PR comment: ×1, latest by marcliu at 15:${30 + i} UTC — "${body}" — ` +
          `${PR_URL}#pc-${i + 1}`
      );
    }
    expect(lines[9]).toBe(
      `- PR #2828 state: open (latest poll 16:35 UTC, ×8 polls folded) — ${PR_URL}#st-8`
    );
    expect(lines[10]).toBe(
      `- Reactions on PR #2828: ×2, latest 🚀 by marcliu at 15:10 UTC — ${PR_URL}#re-2`
    );
  });

  it('renders date-inclusive timestamps when the backlog spans multiple UTC days', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'd-1',
        topic: 'github/o/r/pull_request/7.check_failed',
        checkName: 'lint',
        conclusion: 'failure',
        occurredAt: Date.UTC(2026, 7, 22, 16, 34),
      },
      {
        eventId: 'd-2',
        topic: 'github/o/r/pull_request/7.check_failed',
        checkName: 'lint',
        conclusion: 'failure',
        occurredAt: Date.UTC(2026, 7, 23, 16, 34),
      },
    ]);
    expect(digest).toContain('latest 08-23 16:34 UTC');
  });

  it('bounds envelope size and carries dropped events through to the digest totals', () => {
    const events = Array.from({ length: 205 }, (_, i) => ({
      eventId: `env-${i}`,
      topic: 'github/o/r/pull_request/7.check_failed',
      checkName: 'lint',
      conclusion: 'failure',
      occurredAt: at(15) + i * 1000,
    }));
    const envelope = buildDeferredEventDigestEnvelopeText(events);
    const parsed = parseDeferredExternalEventText(envelope);
    expect(parsed?.kind).toBe('fold');
    if (parsed?.kind !== 'fold') return;
    expect(parsed.events).toHaveLength(200);
    expect(parsed.events[0]).toMatchObject({ eventId: 'env-5' });
    expect(parsed.droppedCount).toBe(5);

    const partition = partitionDeferredExternalEventRows([row('db-env', 'u-env', envelope)]);
    expect(partition.digestEvents).toHaveLength(200);
    expect(partition.droppedCount).toBe(5);
    const digest = buildExternalEventDigestMessage(partition.digestEvents, {
      droppedEventCount: partition.droppedCount,
    });
    expect(digest.split('\n')[0]).toBe('External events while you were working (205 events):');
    expect(digest).toContain(
      '5 older events were folded out of earlier overflow envelopes and are superseded.'
    );
  });

  it('keeps only the newest state across superseded polls', () => {
    const essences = [
      ...deferredExternalEventEntryEvents({
        kind: 'event',
        essence: {
          eventId: 's1',
          topic: 'github/o/r/pull_request/7.polled',
          prNumber: 7,
          state: 'open',
        },
      }),
      ...deferredExternalEventEntryEvents({
        kind: 'event',
        essence: {
          eventId: 's2',
          topic: 'github/o/r/pull_request/7.polled',
          prNumber: 7,
          state: 'closed',
        },
      }),
    ];
    const digest = buildExternalEventDigestMessage(essences);
    expect(digest).toContain('PR #7 state: closed');
    expect(digest).toContain('×2 polls folded');
    expect(digest).not.toContain('open');
  });

  it('does not claim a majority cancellation note when failures dominate', () => {
    const essences = [
      { conclusion: 'canceled', occurredAt: at(15) },
      { conclusion: 'failure', occurredAt: at(16) },
      { conclusion: 'failure', occurredAt: at(16, 30) },
    ].map((fields, i) => ({
      eventId: `c-${i}`,
      topic: 'github/o/r/pull_request/7.check_failed',
      checkName: 'lint',
      ...fields,
    }));
    const digest = buildExternalEventDigestMessage(essences);
    expect(digest).toContain('CI check "lint": 3 runs (failure ×2, canceled ×1)');
    expect(digest).not.toContain('most cancelled');
  });

  it('falls back to a topic line for unknown suffixes', () => {
    const digest = buildExternalEventDigestMessage([
      { eventId: 'u-1', topic: 'github/o/r/pull_request/9.merge_group_polled', prNumber: 9 },
      { eventId: 'u-2', topic: 'github/o/r/pull_request/9.merge_group_polled', prNumber: 9 },
    ]);
    expect(digest).toContain('External events while you were working (2 events, PR #9):');
    expect(digest).toContain('github/o/r/pull_request/9.merge_group_polled: ×2');
    expect(digest).toContain('latest eventId: u-2');
  });

  it('preserves actionable payload fields on other-tier lines', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'dep-1',
        topic: 'github/o/r/pull_request/9.deployment_status_failure',
        prNumber: 9,
        state: 'failure',
        environment: 'production',
        description: 'Deploy failed: health check timed out',
        occurredAt: at(16, 5),
      },
    ]);
    expect(digest).toContain('state: failure');
    expect(digest).toContain('environment: production');
    expect(digest).toContain('"Deploy failed: health check timed out"');
    expect(digest).toContain('latest eventId: dep-1');
  });

  it('collapses a single-conclusion check group without a runs clause', () => {
    const digest = buildExternalEventDigestMessage([
      {
        eventId: 'c-1',
        topic: 'github/o/r/pull_request/7.check_failed',
        checkName: 'lint',
        conclusion: 'failure',
        occurredAt: at(16),
      },
      {
        eventId: 'c-2',
        topic: 'github/o/r/pull_request/7.check_failed',
        checkName: 'lint',
        conclusion: 'failure',
        occurredAt: at(16, 10),
      },
    ]);
    expect(digest).toContain('CI check "lint": failure ×2');
    expect(digest).not.toContain('runs (');
  });

  it('uses a singular header for a single event and omits scope without a PR', () => {
    const digest = buildExternalEventDigestMessage([
      { eventId: 'u-1', topic: 'github/o/r/repo/42.branch_protection_edited' },
    ]);
    expect(digest.split('\n')[0]).toBe('External events while you were working (1 event):');
  });

  it('is deterministic for identical input', () => {
    const essences = [
      { eventId: 'a', topic: 'github/o/r/pull_request/1.polled', state: 'open' },
      { eventId: 'b', topic: 'github/o/r/pull_request/1.reaction_added', body: '👍' },
    ];
    expect(buildExternalEventDigestMessage(essences)).toBe(
      buildExternalEventDigestMessage([...essences].reverse())
    );
  });
});

describe('partitionDeferredExternalEventRows', () => {
  it('splits digest-tier external rows from everything else', () => {
    const external = row('db-1', 'u-1', checkText('chk-1', at(16), 'failure'));
    const plain = row('db-2', 'u-2', '─── Message from coder ───');
    const partition = partitionDeferredExternalEventRows([external, plain]);
    expect(partition.digestRows.map((r) => r.dbId)).toEqual(['db-1']);
    expect(partition.digestEvents).toHaveLength(1);
    expect(partition.remainder.map((r) => r.dbId)).toEqual(['db-2']);
  });

  it('keeps rows of a future direct tier in the remainder', () => {
    const tiers = EXTERNAL_EVENT_TOPIC_TIERS as Record<string, 'digest' | 'direct'>;
    const previous = tiers.review_requested;
    tiers.review_requested = 'direct';
    try {
      const direct = row(
        'db-1',
        'u-1',
        essenceText({
          eventId: 'evt-direct',
          topic: 'github/lsm/hyperneo/pull_request/2828.review_requested',
          eventType: 'pull_request',
          occurredAt: at(16),
        })
      );
      const partition = partitionDeferredExternalEventRows([direct]);
      expect(partition.digestRows).toHaveLength(0);
      expect(partition.remainder.map((r) => r.dbId)).toEqual(['db-1']);
    } finally {
      if (previous === undefined) delete tiers.review_requested;
      else tiers.review_requested = previous;
    }
  });

  it('flattens early-fold envelope rows into the digest events', () => {
    const envelopeText = buildDeferredEventDigestEnvelopeText([
      { eventId: 'e-1', topic: 'github/o/r/pull_request/1.check_failed' },
      { eventId: 'e-2', topic: 'github/o/r/pull_request/1.check_failed' },
    ]);
    const folded = row('db-fold', 'u-fold', envelopeText);
    const partition = partitionDeferredExternalEventRows([folded]);
    expect(partition.digestRows.map((r) => r.dbId)).toEqual(['db-fold']);
    expect(partition.digestEvents).toHaveLength(2);
  });
});

describe('deferred external event overflow cap', () => {
  function externalRows(count: number): DeferredDeliveryRow[] {
    return Array.from({ length: count }, (_, i) =>
      row(`db-${i}`, `u-${i}`, checkText(`chk-${i}`, at(15) + i * 1000, 'failure'))
    );
  }

  it('plans no overflow at or below the cap', () => {
    expect(
      planDeferredExternalEventOverflow(externalRows(DEFERRED_EXTERNAL_EVENT_ROW_CAP), 100)
    ).toBeNull();
    expect(planDeferredExternalEventOverflow(externalRows(3), 100)).toBeNull();
  });

  it('plans the oldest rows as overflow above the cap', () => {
    const rows = [...externalRows(102), row('db-plain', 'u-plain', 'human chat stays')];
    const plan = planDeferredExternalEventOverflow(rows, 100);
    expect(plan).not.toBeNull();
    expect(plan?.overflowRows).toHaveLength(3);
    expect(plan?.overflowRows.map((r) => r.dbId)).toEqual(['db-0', 'db-1', 'db-2']);
    expect(plan?.events).toHaveLength(3);
  });

  it('folds the oldest rows into a deferred envelope and marks them superseded', async () => {
    const opsCalls: string[] = [];
    const saved: Array<{ status: 'enqueued' | 'deferred'; text: string }> = [];
    const superseded: string[][] = [];
    const ops: DeferredEventDigestRowOps = {
      saveRow: async (message, sendStatus) => {
        opsCalls.push('save');
        const text = (message.message?.content as Array<{ type: string; text?: string }>)[0]?.text;
        saved.push({ status: sendStatus, text: text ?? '' });
        return `db-saved-${saved.length}`;
      },
      markSuperseded: async (dbIds) => {
        opsCalls.push('supersede');
        superseded.push(dbIds);
      },
    };
    const folded = await foldDeferredExternalEventOverflow({
      sessionId: 'session-1',
      rows: externalRows(101),
      cap: 100,
      ops,
    });
    expect(folded).toBe(2);
    expect(opsCalls).toEqual(['save', 'supersede']);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.status).toBe('deferred');
    const envelope = parseDeferredExternalEventText(saved[0]?.text ?? '');
    expect(envelope?.kind).toBe('fold');
    if (envelope?.kind === 'fold') {
      expect(envelope.events.map((entry) => entry.eventId)).toEqual(['chk-0', 'chk-1']);
    }
    expect(superseded).toEqual([['db-0', 'db-1']]);
  });

  it('leaves a backlog under the cap untouched', async () => {
    let saveCalls = 0;
    let supersedeCalls = 0;
    const ops: DeferredEventDigestRowOps = {
      saveRow: async () => {
        saveCalls += 1;
        return 'db';
      },
      markSuperseded: async () => {
        supersedeCalls += 1;
      },
    };
    const folded = await foldDeferredExternalEventOverflow({
      sessionId: 'session-1',
      rows: externalRows(50),
      cap: 100,
      ops,
    });
    expect(folded).toBe(0);
    expect(saveCalls).toBe(0);
    expect(supersedeCalls).toBe(0);
  });
});

describe('foldDeferredExternalEventsAtFlush', () => {
  function recordingOps(
    calls: string[],
    superseded: string[][]
  ): DeferredEventDigestRowOps & { savedTexts: string[] } {
    const savedTexts: string[] = [];
    return {
      savedTexts,
      saveRow: async (message, sendStatus) => {
        calls.push(`save:${sendStatus}`);
        const text = (message.message?.content as Array<{ type: string; text?: string }>)[0]?.text;
        savedTexts.push(text ?? '');
        return 'db-digest';
      },
      markSuperseded: async (dbIds) => {
        calls.push('supersede');
        superseded.push(dbIds);
      },
    };
  }

  it('creates one digest row, supersedes the sources, and keeps the remainder', async () => {
    const calls: string[] = [];
    const superseded: string[][] = [];
    const ops = recordingOps(calls, superseded);
    const externalA = row('db-a', 'u-a', checkText('chk-a', at(16), 'failure'));
    const externalB = row(
      'db-b',
      'u-b',
      essenceText({
        eventId: 're-b',
        topic: 'github/lsm/hyperneo/pull_request/2828.reaction_added',
        eventType: 'reaction',
        occurredAt: at(15, 10),
        action: 'added',
        actor: 'marcliu',
        body: '👍',
      })
    );
    const plain = row('db-plain', 'u-plain', '─── Message from coder ───');

    const result = await foldDeferredExternalEventsAtFlush({
      sessionId: 'session-1',
      rows: [externalA, externalB, plain],
      ops,
    });

    expect(calls).toEqual(['save:enqueued', 'supersede']);
    expect(superseded).toEqual([['db-a', 'db-b']]);
    expect(result.foldedCount).toBe(2);
    expect(result.digestRow?.dbId).toBe('db-digest');
    expect(result.digestRow?.uuid).toBeTruthy();
    expect(ops.savedTexts[0]).toContain('External events while you were working (2 events');
    expect(result.remainder.map((r) => r.dbId)).toEqual(['db-plain']);
  });

  it('returns rows untouched when no external events are deferred', async () => {
    const calls: string[] = [];
    const superseded: string[][] = [];
    const ops = recordingOps(calls, superseded);
    const plain = row('db-plain', 'u-plain', 'a human follow-up');
    const result = await foldDeferredExternalEventsAtFlush({
      sessionId: 'session-1',
      rows: [plain],
      ops,
    });
    expect(result.digestRow).toBeNull();
    expect(result.foldedCount).toBe(0);
    expect(result.remainder).toEqual([plain]);
    expect(calls).toEqual([]);
  });
});
