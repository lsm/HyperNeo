import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StructuredLogEvent } from '@hyperneo/shared';
import {
  clearStructuredLogSubscribers,
  configureLogger,
  installConsoleLogCapture,
  Logger,
  LogLevel,
  subscribeToStructuredLogs,
} from '../../../../src/lib/logger';
import {
  redactStructuredLogEvent,
  StructuredLogFileSink,
} from '../../../../src/lib/structured-log-file-sink';

const tempDirs: string[] = [];

afterEach(async () => {
  clearStructuredLogSubscribers();
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe('StructuredLogFileSink', () => {
  it('writes ordered JSONL records and creates missing directories', async () => {
    const path = await tempPath('nested/daemon.jsonl');
    const sink = createSink(path);
    sink.capture(event('first'));
    sink.capture(event('second'));
    await sink.close();

    expect((await records(path)).map((record) => record.message)).toEqual(['first', 'second']);
  });

  it('captures logger and direct console events once each', async () => {
    configureLogger({ level: LogLevel.INFO });
    const path = await tempPath('daemon.jsonl');
    const sink = createSink(path);
    const unsubscribe = subscribeToStructuredLogs((captured) => sink.capture(captured));
    const originalInfo = console.info;
    console.info = () => {};
    const restoreConsole = installConsoleLogCapture();
    try {
      new Logger('sink-test').info('logger event');
      console.info('console event');
    } finally {
      restoreConsole();
      console.info = originalInfo;
      unsubscribe();
      await sink.close();
    }

    const messages = (await records(path)).map((record) => record.message);
    expect(messages.filter((message) => message === 'logger event')).toHaveLength(1);
    expect(messages.filter((message) => message === 'console event')).toHaveLength(1);
  });

  it('redacts nested and inline credentials without mutating the source event', () => {
    const source = event(
      'Bearer abc.def token=raw {"apiKey":"json-secret","cookie":"session=abc"} Authorization: Basic abc123',
      {
        authorization: 'Bearer nested',
        nested: { apiKey: 'secret', safe: 'ok' },
      }
    );

    const redacted = redactStructuredLogEvent(source);

    expect(redacted.message).toBe(
      'Bearer [REDACTED] token=[REDACTED] {"apiKey":"[REDACTED]","cookie":"[REDACTED]"} Authorization: [REDACTED]'
    );
    expect(redacted.metadata).toEqual({
      authorization: '[REDACTED]',
      nested: { apiKey: '[REDACTED]', safe: 'ok' },
    });
    expect(source.metadata).toEqual({
      authorization: 'Bearer nested',
      nested: { apiKey: 'secret', safe: 'ok' },
    });
  });

  it('redacts unquoted header-form cookie values including semicolon tails', () => {
    // Colon-form cookie values (quoted-value pattern needs a quote after the
    // colon; the `=`-form needs `cookie=`) previously leaked verbatim.
    const redacted = redactStructuredLogEvent(
      event('Cookie: session=abc123; tracking=t2', {
        header: 'Set-Cookie: sid=secret123; Path=/; Expires=Wed, 21 Oct 2025 07:28:00 GMT',
        quoted: 'Cookie: "quoted=ok"',
      })
    );

    expect(redacted.message).toBe('Cookie: [REDACTED]');
    expect(redacted.metadata).toEqual({
      header: 'Set-Cookie: [REDACTED]',
      quoted: 'Cookie: "[REDACTED]"',
    });
    expect(JSON.stringify(redacted)).not.toContain('abc123');
    expect(JSON.stringify(redacted)).not.toContain('secret123');
  });

  it('rotates before crossing maxBytes and enforces retention', async () => {
    const path = await tempPath('daemon.jsonl');
    const probe = `${JSON.stringify(event('x'.repeat(40)))}\n`;
    const sink = createSink(path, Buffer.byteLength(probe) + 5, 2);
    sink.capture(event('a'.repeat(40)));
    sink.capture(event('b'.repeat(40)));
    sink.capture(event('c'.repeat(40)));
    sink.capture(event('d'.repeat(40)));
    await sink.close();

    expect((await records(path))[0]?.message).toBe('d'.repeat(40));
    expect((await records(path.replace('.jsonl', '.1.jsonl')))[0]?.message).toBe('c'.repeat(40));
    expect((await records(path.replace('.jsonl', '.2.jsonl')))[0]?.message).toBe('b'.repeat(40));
  });

  it('accounts for an existing active file on startup', async () => {
    const path = await tempPath('daemon.jsonl');
    const first = `${JSON.stringify(event('existing'))}\n`;
    await writeFile(path, first);
    const sink = createSink(path, Buffer.byteLength(first) + 5, 1);
    sink.capture(event('new'));
    await sink.close();

    expect((await records(path))[0]?.message).toBe('new');
    expect((await records(path.replace('.jsonl', '.1.jsonl')))[0]?.message).toBe('existing');
  });

  it('bounds pending writes and ignores capture after close', async () => {
    const path = await tempPath('daemon.jsonl');
    const sink = createSink(path, 10_000, 1, 1);
    sink.capture(event('dropped'));
    expect(sink.getDroppedCount()).toBe(1);
    await sink.close();
    sink.capture(event('ignored'));
    await sink.close();
    expect(await readFile(path, 'utf8').catch(() => '')).toBe('');
  });

  it('fails open for an unwritable target', async () => {
    const directory = await tempPath('occupied');
    await writeFile(directory, 'not a directory');
    const sink = createSink(join(directory, 'daemon.jsonl'));
    sink.capture(event('ignored'));
    await expect(sink.close()).resolves.toBeUndefined();
  });
});

function createSink(
  path: string,
  maxBytes = 10_000,
  retainedFiles = 2,
  maxPendingBytes = 10_000
): StructuredLogFileSink {
  return new StructuredLogFileSink({ path, maxBytes, retainedFiles, maxPendingBytes });
}

async function tempPath(relative: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hyperneo-log-sink-'));
  tempDirs.push(directory);
  return join(directory, relative);
}

async function records(path: string): Promise<StructuredLogEvent[]> {
  const content = await readFile(path, 'utf8');
  return content
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as StructuredLogEvent);
}

function event(message: string, metadata: Record<string, unknown> = {}): StructuredLogEvent {
  return {
    id: `event-${message.slice(0, 4)}`,
    timestamp: 123,
    level: 'info',
    message,
    module: 'test',
    source: 'logger',
    context: {},
    process: { pid: 123 },
    metadata,
  };
}
