import { describe, expect, test } from 'bun:test';
import {
  NEO_SESSION_READS_MAX,
  NEO_SESSION_RECHECK_MS,
  planNeoSessionReads,
} from '../../../../src/lib/neo/session-ask-links.ts';
import { type NeoListedSession, neoSessionKey } from '../../../../src/lib/neo/session-watch.ts';

const listed = (id: string, overrides: Partial<NeoListedSession> = {}): NeoListedSession => ({
  key: neoSessionKey({ adapter: 'codex-desktop', id }),
  ref: { adapter: 'codex-desktop', id },
  title: id,
  status: 'running',
  lastActivityAt: 1,
  link: `codex://threads/${id}`,
  ...overrides,
});

describe('planNeoSessionReads', () => {
  test('reads unchecked sessions, those needing the human first, within a bound', () => {
    const sessions = [
      listed('checked'),
      listed('reading'),
      listed('old', { lastActivityAt: 1 }),
      listed('new', { lastActivityAt: 5 }),
      listed('stuck', { status: 'needs_you', lastActivityAt: 0 }),
    ];
    const now = NEO_SESSION_RECHECK_MS;
    const plan = planNeoSessionReads(
      sessions,
      [sessions[1]!],
      new Map([[sessions[0]!.key, now]]),
      now
    );
    expect(plan.map((session) => session.title)).toEqual(['stuck', 'new', 'old']);
    const many = Array.from({ length: NEO_SESSION_READS_MAX + 3 }, (_, i) => listed(`s${i}`));
    expect(planNeoSessionReads(many, [], new Map(), now)).toHaveLength(NEO_SESSION_READS_MAX);
  });

  test('reads every session again after a while, so its later turns are recorded', () => {
    const session = listed('quiet');
    const checked = new Map([[session.key, 1]]);
    expect(planNeoSessionReads([session], [], checked, 2)).toEqual([]);
    expect(
      planNeoSessionReads([session], [], checked, NEO_SESSION_RECHECK_MS + 1).map(
        (read) => read.title
      )
    ).toEqual(['quiet']);
  });
});
