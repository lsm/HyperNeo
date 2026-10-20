import { claudeOwnerSession } from '../../../../../../.claude/skills/verify/pr-owner-session.ts';
import { planCodingPrOwner } from '../../../../src/lib/neo/packs/coding/pr-ledger.ts';
import { describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeCreatedPr,
  createClaudeSessionPrReader,
} from '../../../../src/lib/drivers/claude-session-prs.ts';
import { createCodingClaudeOwnerReader } from '../../../../src/lib/neo/packs/coding/claude-pr-owners.ts';

const url = (number: number) => `https://github.com/synthetic/cart-sandbox/pull/${number}`;
const operation = (action: string, number: number) =>
  JSON.stringify({
    type: 'user',
    toolUseResult: { gitOperation: { pr: { action, number, url: url(number) } } },
  });

describe('Claude transcript PR creation evidence', () => {
  test('only a structured successful creation establishes the PR, not comments, edits or quoted text', () => {
    expect(claudeCreatedPr(operation('created', 4))).toBe(url(4));
    for (const action of ['commented', 'edited', 'merged', 'closed'])
      expect(claudeCreatedPr(operation(action, 4))).toBeNull();
    expect(
      claudeCreatedPr(
        JSON.stringify({ type: 'assistant', message: { content: operation('created', 4) } })
      )
    ).toBeNull();
    expect(
      claudeCreatedPr(JSON.stringify({ ...JSON.parse(operation('created', 4)), isError: true }))
    ).toBeNull();
    expect(claudeCreatedPr('{"gitOperation":')).toBeNull();
  });

  test('retains earlier creation across append and incomplete lines, refreshes changed metadata, replacement and truncation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-pr-facts-'));
    const scope = join(root, 'sessions/account/scope');
    const project = join(root, 'projects/-synthetic');
    mkdirSync(scope, { recursive: true });
    mkdirSync(project, { recursive: true });
    const meta = join(scope, 'local_one.json');
    const transcript = join(project, 'cli-one.jsonl');
    const record = {
      sessionId: 'local_one',
      cliSessionId: 'cli-one',
      cwd: '/synthetic',
      branch: 'before',
      prs: [{ url: url(4) }],
    };
    writeFileSync(meta, JSON.stringify(record));
    writeFileSync(join(scope, 'auth.json'), 'not session metadata');
    writeFileSync(transcript, operation('created', 4) + '\n' + operation('commented', 9) + '\n');
    const read = createClaudeSessionPrReader(join(root, 'sessions'), join(root, 'projects'));
    try {
      expect((await read()).map((s) => [s.record.sessionId, s.createdPrs, s.branches])).toEqual([
        ['local_one', [url(4)], ['before']],
      ]);
      expect((await read())[0].createdPrs).toEqual([url(4)]);
      const next = operation('created', 5);
      appendFileSync(transcript, next.slice(0, 25));
      expect((await read())[0].createdPrs).toEqual([url(4)]);
      appendFileSync(transcript, next.slice(25) + '\n');
      expect((await read())[0].createdPrs).toEqual([url(4), url(5)]);
      writeFileSync(meta, JSON.stringify({ ...record, branch: 'after' }));
      utimesSync(meta, new Date(), new Date(Date.now() + 5000));
      expect((await read())[0].branches).toEqual(['after']);
      writeFileSync(transcript, operation('created', 6) + '\n');
      expect((await read())[0].createdPrs).toEqual([url(6)]);
      const replacement = join(project, 'new.jsonl');
      writeFileSync(replacement, operation('created', 7) + '\n');
      renameSync(replacement, transcript);
      expect((await read())[0].createdPrs).toEqual([url(7)]);
      rmSync(meta);
      expect(await read()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps byte offsets across a multi-chunk UTF-8 tool result', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-pr-chunks-'));
    const scope = join(root, 'sessions/account/scope');
    const project = join(root, 'projects/-synthetic');
    mkdirSync(scope, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(scope, 'local_one.json'),
      JSON.stringify({ sessionId: 'local_one', cliSessionId: 'one', cwd: '/synthetic' })
    );
    const transcript = join(project, 'one.jsonl');
    writeFileSync(
      transcript,
      JSON.stringify({ ...JSON.parse(operation('created', 4)), content: '😀'.repeat(40_000) }) +
        '\n'
    );
    const read = createClaudeSessionPrReader(join(root, 'sessions'), join(root, 'projects'));
    try {
      expect((await read())[0].createdPrs).toEqual([url(4)]);
      appendFileSync(transcript, operation('created', 5) + '\n');
      expect((await read())[0].createdPrs).toEqual([url(4), url(5)]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('retains a folder identity across sweeps and refreshes after the folder leaves the reader', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-owner-identity-'));
    const scope = join(root, 'sessions/account/scope');
    mkdirSync(scope, { recursive: true });
    for (const id of ['local_one', 'local_two'])
      writeFileSync(
        join(scope, `${id}.json`),
        JSON.stringify({ sessionId: id, cwd: '/synthetic' })
      );
    let reads = 0;
    const read = createCodingClaudeOwnerReader(
      join(root, 'sessions'),
      join(root, 'projects'),
      async () => {
        reads++;
        return { remotes: ['git@github.com:synthetic/cart-sandbox.git'] };
      }
    );
    try {
      expect((await read()).map((session) => session.remotes)).toEqual([
        ['git@github.com:synthetic/cart-sandbox.git'],
        ['git@github.com:synthetic/cart-sandbox.git'],
      ]);
      await read();
      expect(reads).toBe(1);
      rmSync(join(scope, 'local_one.json'));
      rmSync(join(scope, 'local_two.json'));
      expect(await read()).toEqual([]);
      writeFileSync(
        join(scope, 'local_one.json'),
        JSON.stringify({ sessionId: 'local_one', cwd: '/synthetic' })
      );
      await read();
      expect(reads).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('the live verification projection keeps a no-sidebar transcript creator owned', () => {
    const ref = { adapter: 'claude-desktop', id: 'local_one' };
    const session = claudeOwnerSession({
      ref,
      status: 'done',
      lastActivityAt: 1,
      remotes: [],
      branches: [],
      openedPrs: [url(4)],
    });
    expect(
      planCodingPrOwner(
        { repo: 'synthetic/cart-sandbox', number: 4, branch: 'other', owner: null },
        new Map(),
        [session]
      )
    ).toBe(JSON.stringify(ref));
  });

  test('the coding pack corroborates a sidebar link but honors dismissal and explicit own links', async () => {
    const root = mkdtempSync(join(tmpdir(), 'claude-owner-'));
    const scope = join(root, 'sessions/account/scope');
    const project = join(root, 'projects/-synthetic');
    mkdirSync(scope, { recursive: true });
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(scope, 'local_one.json'),
      JSON.stringify({
        sessionId: 'local_one',
        cliSessionId: 'one',
        cwd: '/synthetic',
        prs: [
          { url: url(4) },
          { url: url(5), dismissed: true },
          { url: url(6), own: true },
          { url: url(9) },
        ],
      })
    );
    writeFileSync(
      join(project, 'one.jsonl'),
      [
        operation('created', 4),
        operation('created', 5),
        operation('commented', 9),
        operation('created', 7),
      ].join('\n') + '\n'
    );
    const read = createCodingClaudeOwnerReader(
      join(root, 'sessions'),
      join(root, 'projects'),
      async () => ({ remotes: ['git@github.com:synthetic/cart-sandbox.git'] })
    );
    try {
      expect((await read())[0].linkedPrs).toEqual([
        { url: url(4), own: true },
        { url: url(5), dismissed: true },
        { url: url(6), own: true },
        { url: url(9) },
        { url: url(7), own: true },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
