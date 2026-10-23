import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { vi } from 'vitest';
import type { MessageHub } from '@hyperneo/shared';
import type { NeoAsk, NeoAskItem, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';
import type { NeoRefState } from '../../../../src/lib/neo/packs/coding/ask-prs.ts';
import { readNeoGithubRef } from '../../../../src/lib/neo/packs/coding/github-read.ts';
import type { NeoPack } from '../../../../src/lib/neo/pack-contract.ts';
import { NeoService } from '../../../../src/lib/neo/service.ts';
import {
  InternalEventBus,
  type DaemonInternalEventMap,
} from '../../../../src/lib/internal-event-bus.ts';
import type { SessionManager } from '../../../../src/lib/session/session-manager.ts';
import { createTestDb, createTestSession } from '../../../helpers/database.ts';

const pull = (n: number, repo = 'lsm/HyperNeo') => `https://github.com/${repo}/pull/${n}`;
const issueUrl = (n: number) => `https://github.com/lsm/HyperNeo/issues/${n}`;
const item = (id: string, watch: string[], extra: Partial<NeoAskItem> = {}): NeoAskItem => ({
  id,
  text: `item ${id}`,
  state: 'pending',
  evidence: null,
  check: null,
  metBy: null,
  removed: false,
  addedAt: null,
  watch,
  ...extra,
});
const ask = (items: NeoAskItem[], id = 'a1'): NeoAsk => ({
  id,
  requestKey: `k-${id}`,
  projectId: null,
  originSessionId: 'neo:root',
  originMessageId: 'm0',
  title: 'Watch',
  ask: 'Land the fix',
  doneWhen: '',
  doneSource: 'human',
  status: 'open',
  outcome: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  settledAt: null,
  workIds: [],
  doneItems: items,
});
const prState = (n: number, state: NeoRefState['state'], repo?: string): NeoRefState => ({
  url: pull(n, repo),
  kind: 'pr',
  state,
  at: state === 'OPEN' ? null : 5_000,
  done: state === 'MERGED',
  closedBy: null,
});
const issueState = (n: number, extra: Partial<NeoRefState> = {}): NeoRefState => ({
  url: issueUrl(n),
  kind: 'issue',
  state: 'OPEN',
  at: null,
  done: false,
  closedBy: null,
  createdAt: 2_000,
  parent: null,
  ...extra,
});

describe('readNeoGithubRef', () => {
  const detail: NeoWorkPr = {
    url: pull(5),
    state: 'OPEN',
    checks: 'failing',
    review: 'changes_requested',
    title: 'fix: it',
    blockers: ['1 unresolved review thread'],
  };

  test('PR URLs read the work ledger without a separate reference acquisition', async () => {
    const readRefStates = vi.fn(async () => []);
    const readPrs = vi.fn(async () => [detail]);
    expect(await readNeoGithubRef({ readRefStates, readPrs }, pull(5))).toEqual({
      ok: true,
      kind: 'pr',
      ...detail,
    });
    expect(readRefStates).not.toHaveBeenCalled();
    expect(readPrs).toHaveBeenCalledExactlyOnceWith([pull(5)]);
  });

  test('returns a PR with its checks, review verdict and blockers', async () => {
    const readPrs = vi.fn(async () => [detail]);
    const result = await readNeoGithubRef(
      { readRefStates: async () => [prState(5, 'OPEN')], readPrs },
      issueUrl(5)
    );
    expect(readPrs).toHaveBeenCalledWith([pull(5)]);
    expect(result).toEqual({
      ok: true,
      kind: 'pr',
      url: pull(5),
      state: 'OPEN',
      checks: 'failing',
      review: 'changes_requested',
      blockers: ['1 unresolved review thread'],
      title: 'fix: it',
    });
  });

  test('returns an issue with how it closed, without a PR read', async () => {
    const readPrs = vi.fn(async () => []);
    const result = await readNeoGithubRef(
      {
        readRefStates: async () => [
          issueState(6, {
            state: 'CLOSED',
            done: false,
            duplicate: true,
            parent: { url: issueUrl(6002), at: null },
          }),
        ],
        readPrs,
      },
      issueUrl(6)
    );
    expect(readPrs).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      kind: 'issue',
      url: issueUrl(6),
      state: 'CLOSED',
      closedAs: 'duplicate',
      closedBy: null,
      parent: issueUrl(6002),
    });
  });

  test('refuses a URL that is not a GitHub ref, and says when GitHub could not be read', async () => {
    const readers = { readRefStates: vi.fn(async () => []), readPrs: vi.fn(async () => []) };
    expect(await readNeoGithubRef(readers, 'https://example.com/x')).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not_a_ref'),
    });
    expect(readers.readRefStates).not.toHaveBeenCalled();
    expect(await readNeoGithubRef(readers, pull(8))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('unreadable'),
    });
  });

  test('says a PR is unreadable when its checks and review could not be read', async () => {
    const result = await readNeoGithubRef(
      { readRefStates: async () => [prState(9, 'OPEN')], readPrs: async () => null },
      pull(9)
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining('unreadable') });
  });
});
