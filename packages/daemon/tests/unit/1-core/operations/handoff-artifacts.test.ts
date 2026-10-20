import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createDaemonOperationCatalog,
  type TaskOperationDependencies,
} from '../../../../src/lib/operations/catalog.ts';
import { invokeOperation } from '../../../../src/lib/operations/invoke.ts';
import { createMailboxTestDb, type MailboxTestDb } from '../../../helpers/mailbox-test-db.ts';

describe('worker handoff artifact operation contract', () => {
  let root: string;
  let before: string | undefined;
  let mailbox: MailboxTestDb;
  const sessionId = 'worker-1';
  let status = 'active';
  const text = 'Synthetic report 🔬\n'.repeat(16000);
  const sha256 = createHash('sha256').update(text).digest('hex');
  const drafts = () => join(root, 'handoffs', sessionId, 'drafts');
  const catalog = () =>
    createDaemonOperationCatalog(mailbox.jobQueue, {
      sessionStatus: (id: string) => (id === sessionId ? status : null),
    } as TaskOperationDependencies);
  const invoke = async (name: string, input: unknown, id = sessionId) => {
    const outcome = await invokeOperation(catalog(), name, input, { source: 'mcp', sessionId: id });
    expect(outcome.kind).toBe('completed');
    if (outcome.kind !== 'completed') throw new Error(JSON.stringify(outcome));
    return outcome.value as Record<string, unknown>;
  };
  const publish = (name = 'report.md', id = sessionId) => invoke('handoff.publish', { name }, id);

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'handoff-contract-')));
    before = process.env.HYPERNEO_DATA_DIR;
    process.env.HYPERNEO_DATA_DIR = root;
    mailbox = createMailboxTestDb();
    status = 'active';
    mkdirSync(drafts(), { recursive: true });
    writeFileSync(join(drafts(), 'report.md'), text);
  });
  afterEach(() => {
    mailbox.close();
    if (before === undefined) delete process.env.HYPERNEO_DATA_DIR;
    else process.env.HYPERNEO_DATA_DIR = before;
    rmSync(root, { recursive: true, force: true });
  });

  test('publishes a full snapshot, replays after restart, and reads bounded verified bytes', async () => {
    const published = await publish();
    expect(published.kind).toBe('published');
    const reference = published.reference as Record<string, unknown>;
    expect(reference).toMatchObject({
      sessionId,
      name: 'report.md',
      sha256,
      byteLength: Buffer.byteLength(text),
    });
    expect(reference.daemonId).toBeTypeOf('string');
    expect(readFileSync(reference.path as string, 'utf8')).toBe(text);
    expect(await publish()).toEqual(published);
    const chunks: Buffer[] = [];
    let offset = 0;
    do {
      const read = await invoke('handoff.read', { reference, offset });
      expect(read.kind).toBe('read');
      const chunk = Buffer.from(read.data as string, 'base64');
      expect(chunk.length).toBeLessThanOrEqual(256 * 1024);
      chunks.push(chunk);
      offset = read.nextOffset as number;
    } while (offset < Buffer.byteLength(text));
    expect(Buffer.concat(chunks).toString()).toBe(text);
    rmSync(drafts(), { recursive: true });
    mkdirSync(join(root, 'workspaces', sessionId), { recursive: true });
    rmSync(join(root, 'workspaces'), { recursive: true });
    expect((await invoke('handoff.read', { reference })).kind).toBe('read');
    expect(readdirSync(join(root, 'handoffs', sessionId, 'published'))).toHaveLength(1);
  });

  test.each(['idle', 'waiting_for_input', 'error'])(
    'a registered %s worker may preserve its report',
    async (state) => {
      status = state;
      expect((await publish()).kind).toBe('published');
    }
  );
  test.each(['ended', 'archived'])('a %s session cannot publish', async (state) => {
    status = state;
    expect((await publish()).kind).toBe('rejected');
  });

  test('reports tampering without returning content or replacing the old snapshot', async () => {
    const { reference } = (await publish()) as { reference: Record<string, unknown> };
    const path = reference.path as string;
    chmodSync(path, 0o600);
    writeFileSync(path, 'tampered');
    expect(await invoke('handoff.read', { reference })).toEqual({ kind: 'tampered' });
    expect(await publish()).toEqual({ kind: 'tampered' });
    expect(readFileSync(path, 'utf8')).toBe('tampered');
  });

  test('rejects traversal, cross-session source names and unregistered callers', async () => {
    for (const name of ['../report.md', '/tmp/report.md', '../../worker-2/drafts/report.md']) {
      const result = await invokeOperation(
        catalog(),
        'handoff.publish',
        { name },
        { source: 'mcp', sessionId }
      );
      expect(result.kind).toBe('failed');
    }
    expect((await publish('report.md', 'unknown-session')).kind).toBe('rejected');
    const result = await invokeOperation(
      catalog(),
      'handoff.publish',
      { name: 'report.md', sessionId: 'worker-2' },
      { source: 'mcp', sessionId }
    );
    expect(result.kind).toBe('failed');
  });

  test('rejects symlink and hard-linked drafts and symlinked parent directories', async () => {
    const external = join(root, 'private.md');
    writeFileSync(external, 'synthetic private');
    symlinkSync(external, join(drafts(), 'symlink.md'));
    linkSync(external, join(drafts(), 'hardlink.md'));
    for (const name of ['symlink.md', 'hardlink.md'])
      expect((await publish(name)).kind).toBe('rejected');
    rmSync(drafts(), { recursive: true });
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'report.md'), 'private');
    symlinkSync(outside, drafts());
    expect((await publish()).kind).toBe('rejected');
  });

  test('does not reinterpret a foreign-daemon reference or an altered path', async () => {
    const { reference } = (await publish()) as { reference: Record<string, unknown> };
    expect(
      (
        await invoke('handoff.read', {
          reference: { ...reference, daemonId: 'b0334375-3fd6-422c-8a37-d77975446469' },
        })
      ).kind
    ).toBe('unavailable');
    expect(
      (
        await invoke('handoff.read', {
          reference: { ...reference, path: join(root, 'private.md') },
        })
      ).kind
    ).toBe('rejected');
  });

  test('a snapshot disk-full failure returns no receipt and retains earlier results', async () => {
    const { reference } = (await publish()) as { reference: Record<string, unknown> };
    writeFileSync(join(drafts(), 'report.md'), 'a second synthetic report');
    const original = fs.open;
    const fault = spyOn(fs, 'open').mockImplementation((...args) =>
      String(args[0]).includes('/.staging/')
        ? Promise.reject(
            Object.assign(new Error('ENOSPC: synthetic disk full'), { code: 'ENOSPC' })
          )
        : original(...args)
    );
    try {
      expect(await publish()).toEqual({ kind: 'rejected', reason: 'ENOSPC: synthetic disk full' });
      expect((await invoke('handoff.read', { reference })).kind).toBe('read');
    } finally {
      fault.mockRestore();
    }
  });

  test('rejects a source replaced with a symlink after opening its descriptor', async () => {
    const privatePath = join(root, 'private.md');
    writeFileSync(privatePath, 'synthetic private sibling');
    const source = join(drafts(), 'report.md');
    const original = fs.open;
    const race = spyOn(fs, 'open').mockImplementation(async (...args) => {
      const descriptor = await original(...args);
      if (String(args[0]) === source) {
        renameSync(source, `${source}.moved`);
        symlinkSync(privatePath, source);
      }
      return descriptor;
    });
    try {
      expect((await publish()).kind).toBe('rejected');
      expect(readdirSync(join(root, 'handoffs', sessionId, '.staging'))).toHaveLength(0);
    } finally {
      race.mockRestore();
    }
  });

  test('rejects oversized read chunks and foreign worker reads', async () => {
    const { reference } = await publish();
    expect((await invoke('handoff.read', { reference }, 'worker-2')).kind).toBe('rejected');
    const result = await invokeOperation(
      catalog(),
      'handoff.read',
      { reference, length: 256 * 1024 + 1 },
      { source: 'mcp', sessionId }
    );
    expect(result.kind).toBe('failed');
  });
});
