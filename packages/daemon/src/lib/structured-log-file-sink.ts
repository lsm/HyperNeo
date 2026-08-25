import { appendFile, chmod, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import type { StructuredLogEvent } from '@hyperneo/shared';
import { withConsoleLogCaptureSuppressed } from './logger.ts';

export interface StructuredLogFileSinkOptions {
  path: string;
  maxBytes: number;
  retainedFiles: number;
  maxPendingBytes: number;
}

const SENSITIVE_KEY =
  /token|secret|password|api[-_]?key|private[-_]?key|authorization|cookie|credential|signature/i;

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
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'string' && SENSITIVE_KEY.test(value[0])) {
      return [value[0], '[REDACTED]'];
    }
    return value.map(redactLogValue);
  }
  if (!value || typeof value !== 'object') return value;

  const object = value as Record<string, unknown>;
  if (typeof object.name === 'string' && SENSITIVE_KEY.test(object.name) && 'value' in object) {
    return { ...object, value: '[REDACTED]' };
  }

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(object)) {
    result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redactLogValue(nested);
  }
  return result;
}

function redactString(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/(\/\/)[^/\s?#]+@/gi, '$1[REDACTED]@')
    .replace(/(\/\/)[^/\s?#]+:[^/\s?#]+$/gi, '$1[REDACTED]')
    .replace(/([?&]sig=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(
      /([[,]\s*["'][\w.-]{0,64}(?:authorization|cookie|set-cookie|api[-_]?key|private[-_]?key|token|secret|password|credential|signature)[\w.-]{0,64}["']\s*,\s*)(["'])((?:\\[\s\S]|(?!\2)[^\\])*)\2/gi,
      '$1$2[REDACTED]$2'
    )
    .replace(/(authorization\s*:\s*)(?![\s"'])[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/((?:cookie|set-cookie)\s*:\s*)(?![\s"'])[^\r\n]+/gi, '$1[REDACTED]')
    .replace(
      /((?:[\w.-]{0,64}(?:api[-_]?key|private[-_]?key|token|secret|password|credential|signature)[\w.-]{0,64})\s*:\s*)(?![\s"'])([^,}\r\n]+)/gi,
      '$1[REDACTED]'
    )
    .replace(
      /(["']?(?:[\w.-]{0,64}(?:api[-_]?key|private[-_]?key|token|secret|password|credential|signature|authorization|cookie|set-cookie)[\w.-]{0,64})["']?\s*[:=]\s*)(["'])((?:\\[\s\S]|(?!\2)[^\\])*)\2/gi,
      '$1$2[REDACTED]$2'
    )
    .replace(
      /(["']?(?:[\w.-]{0,64}(?:api[-_]?key|private[-_]?key|token|secret|password|credential|signature|authorization|cookie|set-cookie)[\w.-]{0,64})["']?\s*[:=]\s*)(["'])((?:\\[\s\S]|(?!\2)[^\\])*)$/gi,
      '$1$2[REDACTED]'
    )
    .replace(/(authorization\s*=\s*)(?![\s"'])[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/((?:cookie|set-cookie)\s*=\s*)(?![\s"'])[^\r\n]+/gi, '$1[REDACTED]')
    .replace(/((?:password|secret|private[-_]?key)\s*=\s*)(?![\s"'])[^\r\n]+/gi, '$1[REDACTED]')
    .replace(
      /((?:[\w.-]{0,64}(?:api[-_]?key|token|credential|signature)[\w.-]{0,64})\s*=\s*)([^\s&;,}]+)/gi,
      '$1[REDACTED]'
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
