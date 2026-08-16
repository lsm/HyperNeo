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

  it('redacts comma-delimited Authorization schemes through end of line', () => {
    // Digest/AWS-style values carry structural commas; a `,` boundary would
    // persist the nonce/response/signature verbatim.
    const redacted = redactStructuredLogEvent(
      event(
        'Authorization: Digest username="u", nonce="secret-nonce", response="hash", algorithm=SHA-256'
      )
    );
    expect(redacted.message).toBe('Authorization: [REDACTED]');
  });

  it('redacts quoted values containing escaped quotes through the closing quote', () => {
    // A JSON-serialized Digest value carries escaped quotes (`\"`); the naive
    // `.*?` value treats the first escaped quote as the closing delimiter and
    // persists the username/nonce/response. The escape-aware matcher consumes
    // the whole value. (Codex P1, PR #2499.)
    const redacted = redactStructuredLogEvent(
      event('{"Authorization":"Digest username=\\"u\\", nonce=\\"secret\\""}')
    );
    expect(redacted.message).toBe('{"Authorization":"[REDACTED]"}');
  });

  it('redacts equals-form Authorization values containing spaces through end of line', () => {
    // AWS/Digest equals-form values carry spaces and structural commas; the
    // generic `=` rule stops at the first whitespace and would persist the
    // credential/signature. (Codex P1, PR #2499.)
    const redacted = redactStructuredLogEvent(
      event('Authorization=AWS4-HMAC-SHA256 Credential=AKIA123, Signature=deadbeef')
    );
    expect(redacted.message).toBe('Authorization=[REDACTED]');
  });

  it('redacts URL userinfo credentials', () => {
    // A Basic-auth URL (`scheme://user:pass@host`) carries credentials without
    // any `authorization`/`token`/`password` label; the userinfo must be
    // redacted before the record is written. (Codex P1, PR #2499.)
    const redacted = redactStructuredLogEvent(
      event('installing from https://oauth2:secret@host/repo.git')
    );
    expect(redacted.message).toBe('installing from https://[REDACTED]@host/repo.git');
  });

  it('redacts URL userinfo through the final @ delimiter', () => {
    // A password containing an unescaped `@` must be consumed through the host
    // delimiter, not the first `@`. (Codex P1, PR #2499.)
    const redacted = redactStructuredLogEvent(event('https://user:p@ass@host/repo.git'));
    expect(redacted.message).toBe('https://[REDACTED]@host/repo.git');
  });

  it('redacts multiline quoted secret values', () => {
    // `.` does not consume newlines, so a quoted value spanning a line break was
    // previously left verbatim. (Codex P1, PR #2499.)
    const redacted = redactStructuredLogEvent(event('token: "line1\nline2"'));
    expect(redacted.message).toBe('token: "[REDACTED]"');
  });

  it('redacts compound secret keys in serialized objects', () => {
    // A serialized env/config object carries compound credential names
    // (`AWS_SECRET_ACCESS_KEY`); the key matcher must recognize the sensitive
    // COMPONENT inside the compound name, not only a bare `secret`/`token`/…
    // key. (Codex P1, PR #2499.)
    const redacted = redactStructuredLogEvent(
      event('{"AWS_SECRET_ACCESS_KEY":"supersecret","DB_PASSWORD":"hunter2"}')
    );
    expect(redacted.message).toBe(
      '{"AWS_SECRET_ACCESS_KEY":"[REDACTED]","DB_PASSWORD":"[REDACTED]"}'
    );
  });

  it('redacts sensitive header tuple values', () => {
    // `Array.from(headers.entries())` serializes a header as a two-element
    // tuple; the value has no adjacent `Authorization:`/`Cookie:` label.
    // (Codex P1, PR #2499.)
    const redacted = redactStructuredLogEvent(
      event(`[['Authorization','Basic dXNlcjpwYXNz'],['Cookie','session=secret']]`)
    );
    expect(redacted.message).toBe(`[['Authorization','[REDACTED]'],['Cookie','[REDACTED]']]`);
  });

  it('redacts escaped-quote header tuple values through the closing quote', () => {
    // A Digest/AWS tuple value carries escaped quotes; the naive value matcher
    // stops at the first `\"` and persists the nonce/signature. (Codex P1.)
    const redacted = redactStructuredLogEvent(
      event(`["Authorization","Digest username=\\"u\\", nonce=\\"secret\\""]`)
    );
    expect(redacted.message).toBe(`["Authorization","[REDACTED]"]`);
  });

  it('redacts structured header tuples in metadata arrays', () => {
    // `Array.from(headers.entries())` in `metadata`/`context` is a real nested
    // array, not a string — the string rules never see it, and element-wise
    // recursion persists the credential. (Codex P1, PR #2499.)
    const redacted = redactStructuredLogEvent(
      event('msg', { headers: [['Authorization', 'Basic dXNlcjpwYXNz']] })
    );
    expect(redacted.metadata).toEqual({ headers: [['Authorization', '[REDACTED]']] });
  });

  it('redacts private-key fields', () => {
    // `privateKey`/`private_key`/`SSH_PRIVATE_KEY` hold PEM/key material but are
    // not recognized by the bare `secret`/`token`/`password` alternation.
    // (Codex P1, PR #2499.)
    const redacted = redactStructuredLogEvent(
      event('{"privateKey":"-----BEGIN PRIVATE KEY-----","SSH_PRIVATE_KEY":"…"}', {
        private_key: 'pem',
      })
    );
    expect(redacted.message).toBe('{"privateKey":"[REDACTED]","SSH_PRIVATE_KEY":"[REDACTED]"}');
    expect(redacted.metadata).toEqual({ private_key: '[REDACTED]' });
  });

  it('does not redact an @ in the URL query or fragment', () => {
    // The userinfo is confined to the authority (before `/`, `?`, or `#`); an
    // `@` in a query/fragment must not be treated as a userinfo delimiter.
    // (Codex P2, PR #2499.)
    const redacted = redactStructuredLogEvent(event('https://example.com?email=user@example.org'));
    expect(redacted.message).toBe('https://example.com?email=user@example.org');
  });

  it('redacts prefixed sensitive header tuples', () => {
    // `X-Api-Key`/`Proxy-Authorization` carry the sensitive component inside a
    // prefixed name; the tuple-name matcher must recognize it. (Codex P1.)
    const redacted = redactStructuredLogEvent(event(`["X-Api-Key","secret"]`));
    expect(redacted.message).toBe(`["X-Api-Key","[REDACTED]"]`);
  });

  it('redacts presigned URL query credentials', () => {
    // AWS-style presigned URLs carry `X-Amz-Credential`/`X-Amz-Signature`
    // parameters; neither is a bare `secret`/`token`/`password` key. (Codex P1.)
    const redacted = redactStructuredLogEvent(
      event('https://s3.amazonaws.com/bucket/key?X-Amz-Credential=AKIA123&X-Amz-Signature=deadbeef')
    );
    expect(redacted.message).toBe(
      'https://s3.amazonaws.com/bucket/key?X-Amz-Credential=[REDACTED]&X-Amz-Signature=[REDACTED]'
    );
  });

  it('redacts truncated unterminated quoted values', () => {
    // The logger truncates messages at a fixed length, which can end inside a
    // quoted credential; the value has no closing quote. (Codex P1, PR #2499.)
    const redacted = redactStructuredLogEvent(event('token: "abcdefghij'));
    expect(redacted.message).toBe('token: "[REDACTED]');
  });

  it('redacts unquoted colon-form values for every sensitive key', () => {
    // `token: abc` (no quotes, no `=`) previously passed through every rule —
    // only authorization and cookies had colon-form handling. Like the
    // authorization rule, the value runs to the `,`/`}`/EOL boundary.
    const redacted = redactStructuredLogEvent(
      event('token: abc', {
        plain1: 'api-key: sk-secret',
        plain2: 'password: hunter2',
        plain3: 'secret: shh-plain',
        quoted: 'token: "quoted-ok"',
      })
    );

    expect(redacted.message).toBe('token: [REDACTED]');
    expect(redacted.metadata).toEqual({
      plain1: 'api-key: [REDACTED]',
      plain2: 'password: [REDACTED]',
      plain3: 'secret: [REDACTED]',
      quoted: 'token: "[REDACTED]"',
    });
    expect(JSON.stringify(redacted)).not.toContain('abc');
    expect(JSON.stringify(redacted)).not.toContain('sk-secret');
    expect(JSON.stringify(redacted)).not.toContain('hunter2');
    expect(JSON.stringify(redacted)).not.toContain('shh-plain');
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

  it('drops only an unserializable record instead of disabling the sink', async () => {
    // A bigint (or circular value) in metadata must not permanently disable
    // the sink — later records, including fatals, still persist.
    const path = await tempPath('daemon.jsonl');
    const sink = createSink(path);
    sink.capture(event('good-before'));
    sink.capture({
      ...event('bad'),
      metadata: { unserializable: 123n },
    } as unknown as StructuredLogEvent);
    sink.capture(event('good-after'));
    await sink.close();

    const messages = (await records(path)).map((record) => record.message);
    expect(messages).toEqual(['good-before', 'good-after']);
    expect(sink.getDroppedCount()).toBe(1);
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
