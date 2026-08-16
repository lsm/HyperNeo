import { appendFile, chmod, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { StructuredLogEvent } from '@hyperneo/shared';
import { withConsoleLogCaptureSuppressed } from './logger';

export interface StructuredLogFileSinkOptions {
  path: string;
  maxBytes: number;
  retainedFiles: number;
  maxPendingBytes: number;
}

const SENSITIVE_KEY = /token|secret|password|api[-_]?key|authorization|cookie/i;

export class StructuredLogFileSink {
  private tail: Promise<void>;
  private currentBytes = 0;
  private pendingBytes = 0;
  private closed = false;
  private disabled = false;
  private warned = false;
  private dropped = 0;

  constructor(private readonly options: StructuredLogFileSinkOptions) {
    this.tail = this.initialize();
  }

  capture(event: StructuredLogEvent): void {
    if (this.closed || this.disabled) return;

    let line: string;
    try {
      line = `${JSON.stringify(redactStructuredLogEvent(event))}\n`;
    } catch (error) {
      // One unserializable record (bigint / circular metadata) must not kill
      // the sink for the rest of the process — drop just this record.
      this.dropped++;
      this.warnOnce(
        `unserializable log record dropped: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }

    const bytes = Buffer.byteLength(line);
    if (this.pendingBytes + bytes > this.options.maxPendingBytes) {
      this.dropped++;
      this.warnOnce(`pending log queue exceeded ${this.options.maxPendingBytes} bytes`);
      return;
    }

    this.pendingBytes += bytes;
    this.tail = this.tail
      .then(() => this.writeLine(line, bytes))
      .catch((error: unknown) => this.disable(error))
      .finally(() => {
        this.pendingBytes = Math.max(0, this.pendingBytes - bytes);
      });
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  async close(): Promise<void> {
    if (this.closed) {
      await this.tail;
      return;
    }
    this.closed = true;
    await this.tail;
  }

  getDroppedCount(): number {
    return this.dropped;
  }

  private async initialize(): Promise<void> {
    try {
      await mkdir(dirname(this.options.path), { recursive: true });
      const info = await stat(this.options.path);
      this.currentBytes = info.size;
      // Tighten a log file created by an older version at the umask default
      // (e.g. 0644) — see writeLine for the privacy rationale. Best-effort.
      await chmod(this.options.path, 0o600).catch(() => {});
    } catch (error) {
      if (isMissingFile(error)) {
        this.currentBytes = 0;
        return;
      }
      this.disable(error);
    }
  }

  private async writeLine(line: string, bytes: number): Promise<void> {
    if (this.disabled) return;
    if (this.currentBytes > 0 && this.currentBytes + bytes > this.options.maxBytes) {
      await this.rotate();
    }
    // 0o600 on CREATE (mode is ignored once the file exists): the JSONL holds
    // redacted-but-sensitive daemon diagnostics, so under a common 022 umask it
    // must not come up world/group-readable. Rotation recreates the live file
    // through this same call, so rotated-in files inherit the mode too.
    // (Codex P2, PR #2499.)
    await appendFile(this.options.path, line, { encoding: 'utf8', mode: 0o600 });
    this.currentBytes += bytes;
  }

  private async rotate(): Promise<void> {
    if (this.options.retainedFiles <= 0) {
      await unlinkIfPresent(this.options.path);
      this.currentBytes = 0;
      return;
    }

    await unlinkIfPresent(this.rotatedPath(this.options.retainedFiles));
    for (let generation = this.options.retainedFiles - 1; generation >= 1; generation--) {
      await renameIfPresent(this.rotatedPath(generation), this.rotatedPath(generation + 1));
    }
    await renameIfPresent(this.options.path, this.rotatedPath(1));
    this.currentBytes = 0;
  }

  private rotatedPath(generation: number): string {
    const extension = extname(this.options.path);
    const stem = basename(this.options.path, extension);
    return join(dirname(this.options.path), `${stem}.${generation}${extension}`);
  }

  private disable(error: unknown): void {
    this.disabled = true;
    this.warnOnce(error instanceof Error ? error.message : String(error));
  }

  private warnOnce(reason: string): void {
    if (this.warned) return;
    this.warned = true;
    withConsoleLogCaptureSuppressed(() => {
      process.stderr.write(
        `[Daemon] Structured log file sink disabled or dropping records: ${reason}\n`
      );
    });
  }
}

export function redactStructuredLogEvent(event: StructuredLogEvent): StructuredLogEvent {
  return {
    ...event,
    message: redactString(event.message),
    stack: event.stack ? redactString(event.stack) : undefined,
    context: redactLogValue(event.context) as StructuredLogEvent['context'],
    process: { ...event.process },
    metadata: redactLogValue(event.metadata) as Record<string, unknown>,
  };
}

function redactLogValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map(redactLogValue);
  if (!value || typeof value !== 'object') return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactLogValue(nested);
  }
  return result;
}

function redactString(value: string): string {
  return (
    value
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
      // URL userinfo (`scheme://user:pass@host`) can carry Basic credentials
      // without any `authorization`/`token`/`password` label; redact the
      // userinfo component. (Codex P1, PR #2499.)
      .replace(/(\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
      // Header tuple form (Array.from(headers.entries())) serializes a header as
      // `["Name","value"]` — the value carries no adjacent `Name:` label, so no
      // other rule catches it. Redact the second element when the first is a
      // sensitive header name. (Codex P1, PR #2499.)
      .replace(
        /(["'](?:authorization|cookie|set-cookie|api[-_]?key|token|secret|password)["']\s*,\s*["'])([^"']+)(["'])/gi,
        '$1[REDACTED]$3'
      )
      // Authorization values legitimately contain structural commas (Digest
      // `username="u", nonce="…", response="…"`, AWS `…, Signature=…`), so —
      // like cookies — redact through end of line; a `,`/`}` boundary would
      // persist the nonce/response/signature verbatim. (Codex P2, PR #2499.)
      .replace(/(authorization\s*:\s*)(?![\s"'])[^\r\n]+/gi, '$1[REDACTED]')
      // Header-form cookie values carry session credentials and legitimately
      // contain `;` and `,` (e.g. Expires dates), so redact to end of line rather
      // than the `,`/`}` boundaries the other rules use. The lookahead
      // also rejects a bare space so `\s*` cannot backtrack to zero-width and
      // swallow quoted values (those keep the quoted rule's quoted output).
      .replace(/((?:cookie|set-cookie)\s*:\s*)(?![\s"'])[^\r\n]+/gi, '$1[REDACTED]')
      // Plain colon-form values for the other sensitive keys (`token: abc`,
      // `api-key: sk-…`, `AWS_SECRET_ACCESS_KEY: …`) — same boundaries as the
      // authorization rule. The key matches a sensitive COMPONENT inside a
      // compound name (`[\w.-]{0,64}` around the alternation), so serialized
      // env/config objects like `{"AWS_SECRET_ACCESS_KEY":"…"}` are caught.
      // Quoted values keep the quoted rule's output via the lookahead. (Codex P1.)
      .replace(
        /((?:[\w.-]{0,64}(?:api[-_]?key|token|secret|password)[\w.-]{0,64})\s*:\s*)(?![\s"'])([^,}\r\n]+)/gi,
        '$1[REDACTED]'
      )
      .replace(
        /(["']?(?:[\w.-]{0,64}(?:api[-_]?key|token|secret|password|authorization|cookie|set-cookie)[\w.-]{0,64})["']?\s*[:=]\s*)(["'])((?:\\.|(?!\2).)*)\2/gi,
        '$1$2[REDACTED]$2'
      )
      // Equals-form Authorization/Cookie values legitimately contain spaces
      // (Digest `username=…, nonce=…`, AWS `Credential=…, Signature=…`,
      // Set-Cookie attributes); the generic `=` rule below stops at the first
      // whitespace and would persist the credential/nonce/signature. Redact
      // through end of line, mirroring the colon-form rules. (Codex P1, PR #2499.)
      .replace(/(authorization\s*=\s*)(?![\s"'])[^\r\n]+/gi, '$1[REDACTED]')
      .replace(/((?:cookie|set-cookie)\s*=\s*)(?![\s"'])[^\r\n]+/gi, '$1[REDACTED]')
      .replace(
        /((?:[\w.-]{0,64}(?:api[-_]?key|token|secret|password)[\w.-]{0,64})\s*=\s*)([^\s&;,}]+)/gi,
        '$1[REDACTED]'
      )
  );
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

async function renameIfPresent(from: string, to: string): Promise<void> {
  try {
    await rename(from, to);
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
