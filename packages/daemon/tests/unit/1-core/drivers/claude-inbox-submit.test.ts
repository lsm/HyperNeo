import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  requireClaudeReplyDestination,
  submitClaudeInboxMessage,
} from '../../../../src/lib/drivers/claude-inbox-submit';
import { WorkDeliverySchema, type WorkCallContext } from '../../../../src/lib/drivers/types';

const sessionId = randomUUID();
const live = { sessionId, pid: 456, owner: 'cli' as const };
const registration = {
  sessionId,
  pid: 456,
  procStart: 'Thu Oct 15 15:18:31 2026',
  entrypoint: 'cli',
  version: '2.1.295',
  messagingSocketPath: '/tmp/cc-socks/456.sock',
};
const context: WorkCallContext = {
  from: 'session:neo%3Aroot',
  caller: { source: 'internal', role: 'neo' },
};
const submission = () => ({
  messageId: randomUUID(),
  inputId: randomUUID(),
  text: '调查 "文件"\n原样发送',
  fromMode: 'prompting' as const,
});
type Deps = Parameters<typeof submitClaudeInboxMessage>[3];

describe('requireClaudeReplyDestination', () => {
  test.each(['chat', 'user', 'agent:space/worker', 'daemon:remote::session:origin'])(
    'does not guess a reply destination for %s',
    (from) => {
      expect(
        requireClaudeReplyDestination({ ...context, from }, { hasSession: () => true })
      ).toMatchObject({ reason: { reason: 'unsupported' } });
    }
  );
  test('checks the decoded session identity before returning its canonical address', () => {
    const seen: string[] = [];
    expect(
      requireClaudeReplyDestination(context, {
        hasSession: (id) => {
          seen.push(id);
          return true;
        },
      })
    ).toEqual({ value: context.from });
    expect(seen).toEqual(['neo:root']);
    expect(requireClaudeReplyDestination(context, { hasSession: () => false })).toMatchObject({
      reason: { reason: 'unreachable' },
    });
  });
});

describe('owner-verified Claude inbox submission', () => {
  let dir: string;
  let deps: Deps;
  let writes: Parameters<Deps['write']>[];
  let reads: number;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'claude-submit-'));
    await writeFile(join(dir, '456.json'), JSON.stringify(registration));
    writes = [];
    reads = 0;
    deps = {
      registrationsDir: dir,
      liveSessions: async () => {
        reads++;
        return [live];
      },
      hasSession: (id) => id === 'neo:root',
      write: async (...args) => {
        writes.push(args);
        return { written: true };
      },
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('writes exact text and caller identities but does not claim peer acceptance', async () => {
    const input = submission();
    const result = await submitClaudeInboxMessage(sessionId, input, context, deps);
    expect(result).toEqual({
      ok: true,
      value: {
        delivered: false,
        unconfirmed: true,
        receipt: { executionId: sessionId, inputId: input.inputId },
      },
    });
    if (!result.ok) throw new Error('Expected a written receipt');
    expect(WorkDeliverySchema.parse(result.value)).toEqual(result.value);
    expect(writes).toEqual([
      [
        {
          sessionId,
          pid: 456,
          version: '2.1.295',
          socketPath: registration.messagingSocketPath,
        },
        context.from,
        input,
      ],
    ]);
    expect(reads).toBe(1);
  });

  test('passes the same retry identities to the transport without generating new ones', async () => {
    const input = submission();
    await submitClaudeInboxMessage(sessionId, input, context, deps);
    await submitClaudeInboxMessage(sessionId, input, context, deps);
    expect(writes.map((args) => args[2])).toEqual([input, input]);
    expect(reads).toBe(2);
  });

  test.each(['desktop', 'unknown', 'absent', 'ambiguous'])(
    'never writes when live ownership is %s',
    async (owner) => {
      deps.liveSessions = async () =>
        owner === 'absent'
          ? []
          : owner === 'ambiguous'
            ? [live, live]
            : [{ ...live, owner: owner === 'desktop' ? 'desktop' : 'unknown' }];
      expect(await submitClaudeInboxMessage(sessionId, submission(), context, deps)).toMatchObject({
        ok: false,
        reason: 'unreachable',
      });
      expect(writes).toEqual([]);
    }
  );

  test('revalidates registered ownership before each submission', async () => {
    await submitClaudeInboxMessage(sessionId, submission(), context, deps);
    await writeFile(
      join(dir, '456.json'),
      JSON.stringify({ ...registration, entrypoint: 'claude-desktop' })
    );
    expect(await submitClaudeInboxMessage(sessionId, submission(), context, deps)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
    expect(writes).toHaveLength(1);
    expect(reads).toBe(2);
  });

  test('requires a live local reply destination before writing', async () => {
    deps.hasSession = () => false;
    expect(await submitClaudeInboxMessage(sessionId, submission(), context, deps)).toMatchObject({
      ok: false,
      reason: 'unreachable',
    });
    expect(writes).toEqual([]);
  });

  test('propagates write uncertainty as an infrastructure failure with no fallback', async () => {
    const failure = new Error('write outcome uncertain');
    deps.write = async () => {
      throw failure;
    };
    await expect(submitClaudeInboxMessage(sessionId, submission(), context, deps)).rejects.toBe(
      failure
    );
    expect(writes).toEqual([]);
  });
});
