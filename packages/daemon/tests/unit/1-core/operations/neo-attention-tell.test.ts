import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  type NeoAttentionEvent,
  type NeoAttentionKnown,
  NEO_ATTENTION_KINDS,
} from '../../../../src/lib/neo/attention/decide.ts';
import {
  createNeoAttention,
  neoAttentionDelivery,
} from '../../../../src/lib/neo/attention/tell.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db';

const HOUR = 3_600_000;
const ROOT = 'neo:root';
const step = (change: Partial<NeoAttentionEvent> = {}): NeoAttentionEvent => ({
  kind: 'todo.neo_step',
  subject: { type: 'todo', id: 'todo-1' },
  since: 1_000,
  facts: { title: 'Ship it', reason: 'no_worker' },
  ...change,
});

describe('neo.attention.tell', () => {
  let mailbox: MailboxTestDb;
  let known: NeoAttentionKnown;
  let dropped: string[];
  let tell: ReturnType<typeof createNeoAttention>;
  const wakes = () => mailbox.jobsByQueue('mailbox').length;
  const digests = () => mailbox.jobsByQueue('neo_notes').length;

  beforeEach(() => {
    mailbox = createMailboxTestDb();
    known = { covered: false, latestReportAt: null };
    dropped = [];
    tell = createNeoAttention({
      kinds: () => NEO_ATTENTION_KINDS,
      read: () => known,
      ...neoAttentionDelivery(
        mailbox.db,
        () => ROOT,
        () => false
      ),
      dropped: (event, reason) => dropped.push(`${event.kind}: ${reason}`),
    });
  });
  afterEach(() => mailbox.close());

  test('a rung is sent once and the next rung is sent', async () => {
    const first = await tell(step(), 1_000);
    expect(await tell(step(), 1_000 + HOUR - 1)).toEqual(first);
    expect(first).toMatchObject({ told: 'wake', step: 0 });
    expect(wakes()).toBe(1);
    expect(await tell(step(), 1_000 + HOUR)).toMatchObject({ told: 'wake', step: 1 });
    await tell(step(), 1_000 + HOUR + 1);
    expect(wakes()).toBe(2);
    expect(JSON.stringify(mailbox.jobsByQueue('mailbox')[0])).toContain(
      'Todo \\"Ship it\\" (todo-1) needs your next step'
    );
  });

  test('a change of since restarts the ladder', async () => {
    await tell(step(), 1_000 + 5 * HOUR);
    expect(await tell(step({ since: 1_000 + 5 * HOUR }), 1_000 + 5 * HOUR)).toMatchObject({
      told: 'wake',
      step: 0,
    });
    expect(wakes()).toBe(2);
  });

  test('an unchanged Neo step is sent once each at 24 h, 48 h and 72 h, never twice within a day', async () => {
    const sent: number[] = [];
    for (let hour = 24; hour < 96; hour++) {
      const before = wakes();
      await tell(step(), 1_000 + hour * HOUR);
      if (wakes() > before) sent.push(hour);
    }
    expect(sent).toEqual([24, 48, 72]);
  });

  test('a digest item is held once and wakes nobody', async () => {
    const blocked = step({ kind: 'todo.blocked', facts: { text: 'Todo "Ship it" is blocked.' } });
    expect(await tell(blocked, 1_000)).toMatchObject({ told: 'digest', step: 0 });
    await tell(blocked, 2_000);
    expect([digests(), wakes()]).toEqual([1, 0]);
    await tell(blocked, 1_000 + 4 * HOUR);
    expect(digests()).toBe(2);
  });

  test('a drop delivers nothing and is logged with its reason', async () => {
    known = { covered: true, latestReportAt: null };
    expect(await tell(step(), 1_000)).toEqual({ dropped: 'covered by card' });
    expect([wakes(), digests(), dropped]).toEqual([0, 0, ['todo.neo_step: covered by card']]);
  });

  test('a real change in what Neo would be told is a new message on the same step', async () => {
    const failed = (detail: string) =>
      step({ facts: { title: 'Ship it', reason: 'failed', detail } });
    const first = await tell(failed('CI keeps failing'), 1_000);
    const second = await tell(failed('The worker stopped'), 1_000);
    expect(first).toMatchObject({ told: 'wake', step: 0 });
    expect(second).toMatchObject({ told: 'wake', step: 0 });
    expect(wakes()).toBe(2);
  });

  test('with no Neo session nothing is delivered', async () => {
    const quiet = createNeoAttention({
      kinds: () => NEO_ATTENTION_KINDS,
      read: () => known,
      ...neoAttentionDelivery(
        mailbox.db,
        () => null,
        () => false
      ),
      dropped: () => {},
    });
    await quiet(step(), 1_000);
    expect([wakes(), digests()]).toEqual([0, 0]);
  });

  test('a busy Neo gets the wake deferred, not lost', async () => {
    const busy = createNeoAttention({
      kinds: () => NEO_ATTENTION_KINDS,
      read: () => known,
      ...neoAttentionDelivery(
        mailbox.db,
        () => ROOT,
        () => true
      ),
      dropped: () => {},
    });
    await busy(step(), 1_000);
    expect(JSON.stringify(mailbox.jobsByQueue('mailbox'))).toContain('defer');
  });
});
