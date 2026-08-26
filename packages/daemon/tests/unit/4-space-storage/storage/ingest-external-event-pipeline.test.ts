import { describe, expect, it } from 'bun:test';
import {
  classifyIngestEvent,
  type IngestExternalEventCtx,
  type IngestExternalEventDeps,
  ingestExternalEvent,
  persistIngestEvent,
  renderIngestEvent,
  validateIngestEvent,
} from '../../../../src/lib/external-events/ingest-external-event-pipeline.ts';
import type { ExternalEvent, StoreResult } from '../../../../src/lib/external-events/types.ts';

const OCCURRED_AT = 1_753_600_940_000;
const PR_URL = 'https://github.com/acme/widgets/pull/42';

function hhmm(): string {
  return new Date(OCCURRED_AT).toISOString().slice(11, 16);
}

let eventSeq = 0;

function makeEvent(overrides: Partial<ExternalEvent> = {}): ExternalEvent {
  eventSeq += 1;
  const id = overrides.id ?? `evt-${eventSeq}`;
  return {
    id,
    spaceId: 'space-ingest',
    topic: 'github/acme/widgets/pull_request/42.check_failed',
    occurredAt: OCCURRED_AT,
    ingestedAt: OCCURRED_AT,
    source: 'github',
    summary: 'CI build-linux failed on PR #42',
    externalUrl: PR_URL,
    payload: {
      eventType: 'check_run',
      action: 'completed',
      actor: 'github-actions[bot]',
      repoOwner: 'acme',
      repoName: 'widgets',
      prNumber: 42,
      checkName: 'build-linux',
      conclusion: 'failure',
    },
    dedupeKey: `dedupe-${id}`,
    ...overrides,
  };
}

function makePolledEvent(): ExternalEvent {
  return makeEvent({
    topic: 'github/acme/widgets/pull_request/42.polled',
    summary: 'PR #42 state polled open',
    externalUrl: undefined,
    payload: {
      eventType: 'pull_request',
      action: 'polled',
      actor: 'alice',
      repoOwner: 'acme',
      repoName: 'widgets',
      prNumber: 42,
      state: 'open',
      merged: false,
      draft: false,
    },
  });
}

const noopDeps: IngestExternalEventDeps = {
  store(): StoreResult {
    throw new Error('store must not be called by this stage');
  },
};

function makeCtx(event: ExternalEvent): IngestExternalEventCtx {
  return { event, deps: noopDeps };
}

interface FakeStore {
  deps: IngestExternalEventDeps;
  writes: ExternalEvent[];
  calls: number;
}

function fakeStore(terminalOnDuplicate = false): FakeStore {
  const rows = new Map<string, ExternalEvent>();
  const writes: ExternalEvent[] = [];
  const store: FakeStore = {
    writes,
    calls: 0,
    deps: {
      store(event: ExternalEvent): StoreResult {
        store.calls += 1;
        const key = JSON.stringify([event.spaceId, event.source, event.dedupeKey]);
        const existing = rows.get(key);
        if (existing) {
          return { event: existing, duplicate: true, terminal: terminalOnDuplicate };
        }
        rows.set(key, event);
        writes.push(event);
        return { event, duplicate: false, terminal: false };
      },
    },
  };
  return store;
}

describe('ingest-external-event pipeline stages', () => {
  describe('validateIngestEvent', () => {
    it('leaves a well-formed event unsettled', () => {
      const ctx = validateIngestEvent(makeCtx(makeEvent()));
      expect(ctx.outcome).toBeUndefined();
    });

    const REJECTIONS: Array<[overrides: Record<string, unknown>, reason: string]> = [
      [{ id: '' }, 'ExternalEvent.id is required'],
      [
        { source: 'Gitlab' },
        'ExternalEvent.source invalid: Source "Gitlab" must be lowercase, start with a letter, ' +
          'and use only alphanumerics, dashes, and underscores',
      ],
      [
        { topic: 'github/acme/widgets/pull_request/42.*' },
        'ExternalEvent.topic invalid: Published event topic must be a literal (no wildcards); ' +
          'got "github/acme/widgets/pull_request/42.*"',
      ],
      [{ source: 'space' }, 'ExternalEvent.topic first segment "github" must equal source "space"'],
      [{ summary: 42 }, 'ExternalEvent.summary must be a string'],
    ];

    for (const [overrides, reason] of REJECTIONS) {
      it(`rejects an event with ${reason.slice(0, 32)}`, () => {
        const event = { ...makeEvent(), ...overrides } as ExternalEvent;
        const ctx = validateIngestEvent(makeCtx(event));
        expect(ctx.outcome).toEqual({ action: 'invalid', reason });
      });
    }
  });

  describe('classifyIngestEvent', () => {
    it('marks a failed check immediate', () => {
      const ctx = classifyIngestEvent(makeCtx(makeEvent()));
      expect(ctx.urgency).toBe('immediate');
      expect(ctx.outcome).toBeUndefined();
    });

    it('marks a polled state queued', () => {
      const ctx = classifyIngestEvent(makeCtx(makePolledEvent()));
      expect(ctx.urgency).toBe('queued');
    });
  });

  describe('renderIngestEvent', () => {
    it('renders the check block for a failed check', () => {
      const event = makeEvent();
      const ctx = renderIngestEvent(makeCtx(event));
      expect(ctx.render).toBe(
        `- CI check "build-linux": failure ×1, latest ${hhmm()} UTC — ${PR_URL} (latest eventId: ${event.id})`
      );
    });

    it('derives the PR scope from the topic when externalUrl is absent', () => {
      const event = makePolledEvent();
      const ctx = renderIngestEvent(makeCtx(event));
      expect(ctx.render).toBe(
        `- PR #42 state: open (latest poll ${hhmm()} UTC, ×1 polls folded) — ${PR_URL} (latest eventId: ${event.id})`
      );
    });
  });

  describe('persistIngestEvent', () => {
    it('writes urgency and render onto the event through the store primitive', () => {
      const store = fakeStore();
      const ctx = persistIngestEvent({
        ...makeCtx(makeEvent()),
        deps: store.deps,
        urgency: 'immediate',
        render: '- CI check "build-linux": failure ×1',
      });
      expect(ctx.outcome).toEqual({
        action: 'ingested',
        eventId: ctx.event.id,
        urgency: 'immediate',
        render: '- CI check "build-linux": failure ×1',
      });
      expect(store.writes).toHaveLength(1);
      expect(store.writes[0]).toMatchObject({ urgency: 'immediate', render: expect.any(String) });
    });

    it('reports a duplicate without a second write, passing terminal through', () => {
      const store = fakeStore(true);
      const event = makeEvent();
      const first = persistIngestEvent({
        ...makeCtx(event),
        deps: store.deps,
        urgency: 'queued',
        render: 'r',
      });
      expect(first.outcome).toMatchObject({ action: 'ingested' });
      const second = persistIngestEvent({
        ...makeCtx(event),
        deps: store.deps,
        urgency: 'queued',
        render: 'r',
      });
      expect(second.outcome).toEqual({ action: 'duplicate', eventId: event.id, terminal: true });
      expect(store.writes).toHaveLength(1);
    });

    it('maps a store throw to a failed outcome', () => {
      const error = new Error('database is locked');
      const deps: IngestExternalEventDeps = {
        store(): StoreResult {
          throw error;
        },
      };
      const ctx = persistIngestEvent({
        ...makeCtx(makeEvent()),
        deps,
        urgency: 'queued',
        render: 'r',
      });
      expect(ctx.outcome).toEqual({ action: 'failed', stage: 'persist', error });
    });
  });
});

describe('ingestExternalEvent end-to-end', () => {
  it('ingests a fresh event with urgency and render persisted', () => {
    const store = fakeStore();
    const event = makeEvent();
    const outcome = ingestExternalEvent(store.deps, event);
    expect(outcome).toEqual({
      action: 'ingested',
      eventId: event.id,
      urgency: 'immediate',
      render: `- CI check "build-linux": failure ×1, latest ${hhmm()} UTC — ${PR_URL} (latest eventId: ${event.id})`,
    });
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]).toMatchObject({ id: event.id, urgency: 'immediate' });
    expect(store.writes[0]?.render).toContain('CI check "build-linux"');
  });

  it('never reaches the store for an invalid event', () => {
    const store = fakeStore();
    const outcome = ingestExternalEvent(store.deps, {
      ...makeEvent(),
      topic: 'gitlab/acme/widgets/pull_request/42.check_failed',
    });
    expect(outcome).toEqual({
      action: 'invalid',
      reason: 'ExternalEvent.topic first segment "github" must equal source "gitlab"',
    });
    expect(store.calls).toBe(0);
  });

  it('re-ingesting a duplicate is a no-op write', () => {
    const store = fakeStore();
    const event = makePolledEvent();
    const first = ingestExternalEvent(store.deps, event);
    expect(first).toMatchObject({ action: 'ingested', urgency: 'queued' });
    const firstWrite = store.writes[0];
    const second = ingestExternalEvent(store.deps, event);
    expect(second).toEqual({ action: 'duplicate', eventId: event.id, terminal: false });
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]).toBe(firstWrite);
  });
});
