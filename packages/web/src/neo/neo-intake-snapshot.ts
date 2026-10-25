import { DRAFT_CHAR_LIMIT, type MessageImage } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import type { NeoPendingAsk, NeoQuote, neoDraftThumbnails } from './neo-intake.ts';
import { readNeoPreviewReference } from './neo-preview-context.ts';

type Thumbnail = Awaited<ReturnType<typeof neoDraftThumbnails>>[number];
type Entry = NeoPendingAsk & { thumbnails?: readonly Thumbnail[] };
type Snapshot = { version: 1; entries: Entry[] };
type Refusal = { kind: 'invalid_snapshot' };
const refusal: Refusal = Object.freeze({ kind: 'invalid_snapshot' });
const MAX_JSON = 16 * 1024 * 1024;
const MAX_IMAGES = 8 * 1024 * 1024;

function shape(value: unknown, keys: string): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Object.keys(value).every((key) => keys.split(',').includes(key))
  );
}

function text(value: unknown, max: number, required = false): value is string {
  return typeof value === 'string' && value.length <= max && (!required || !!value.trim());
}

function base64(value: unknown, max: number): value is string {
  return text(value, max, true) && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function image(value: unknown): value is MessageImage {
  return (
    shape(value, 'data,media_type') &&
    base64(value.data, MAX_IMAGES) &&
    typeof value.media_type === 'string' &&
    ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(value.media_type)
  );
}

function reply(value: unknown): boolean {
  return (
    shape(value, 'kind,id,author,excerpt') &&
    typeof value.kind === 'string' &&
    ['question', 'todo', 'message', 'ask'].includes(value.kind) &&
    text(value.id, 160, true) &&
    (value.author === undefined || value.author === 'neo' || value.author === 'user') &&
    (value.excerpt === undefined || text(value.excerpt, 320, true))
  );
}

function quote(value: unknown): value is NeoQuote {
  return (
    shape(value, 'author,text,anchor,replyTo') &&
    (value.author === 'You' || value.author === 'Neo') &&
    text(value.text, DRAFT_CHAR_LIMIT) &&
    text(value.anchor, 2048, true) &&
    (value.replyTo === undefined || reply(value.replyTo))
  );
}

function dimension(value: unknown): boolean {
  return (
    value === undefined ||
    (Number.isInteger(value) && Number(value) > 0 && Number(value) <= 100_000)
  );
}

function thumbnail(value: unknown): value is Thumbnail {
  return (
    shape(value, 'index,mediaType,data,width,height') &&
    Number.isInteger(value.index) &&
    Number(value.index) >= 0 &&
    Number(value.index) <= 999_999 &&
    value.mediaType === 'image/jpeg' &&
    base64(value.data, 44_000) &&
    dimension(value.width) &&
    dimension(value.height)
  );
}

function entry(value: unknown): value is Entry {
  return (
    shape(
      value,
      'requestId,sessionId,text,images,quote,previewContext,createdAt,state,reason,thumbnails'
    ) &&
    typeof value.requestId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value.requestId
    ) &&
    text(value.sessionId, 200, true) &&
    value.sessionId.startsWith('neo:') &&
    value.sessionId.length > 4 &&
    text(value.text, DRAFT_CHAR_LIMIT) &&
    Array.isArray(value.images) &&
    value.images.length <= 6 &&
    value.images.every(image) &&
    value.images.reduce((sum, item) => sum + item.data.length, 0) <= MAX_IMAGES &&
    (!!value.text.trim() || value.images.length > 0) &&
    (value.quote === undefined || quote(value.quote)) &&
    (value.previewContext === undefined ||
      readNeoPreviewReference(value.previewContext) !== null) &&
    text(value.createdAt, 32, true) &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    new Date(value.createdAt).toISOString() === value.createdAt &&
    typeof value.state === 'string' &&
    ['sending', 'accepted', 'failed'].includes(value.state) &&
    (value.reason === undefined || text(value.reason, DRAFT_CHAR_LIMIT)) &&
    (value.thumbnails === undefined ||
      (Array.isArray(value.thumbnails) &&
        value.thumbnails.length <= value.images.length &&
        value.thumbnails.every(thumbnail) &&
        new Set(value.thumbnails.map((item) => item.index)).size === value.thumbnails.length))
  );
}

function snapshot(value: unknown): value is Snapshot {
  return (
    shape(value, 'version,entries') &&
    value.version === 1 &&
    Array.isArray(value.entries) &&
    value.entries.length <= 20 &&
    value.entries.every(entry) &&
    new Set(value.entries.map((item) => item.requestId)).size === value.entries.length
  );
}

function parse(raw: unknown): { value: Snapshot } | { reason: Refusal } {
  try {
    if (!text(raw, MAX_JSON, true)) return { reason: refusal };
    const parsed: unknown = JSON.parse(raw);
    return snapshot(parsed) ? { value: parsed } : { reason: refusal };
  } catch {
    return { reason: refusal };
  }
}

function serialize(entries: unknown): { value: string } | { reason: Refusal } {
  try {
    const value = { version: 1, entries };
    return snapshot(value) ? { value: JSON.stringify(value) } : { reason: refusal };
  } catch {
    return { reason: refusal };
  }
}

const decode = (superpipe({})('neo-intake-snapshot-decode') as PipelineAPI)
  .input(['raw'])
  .pipe(parse, 'raw', 'result:snapshot')
  .end('snapshot') as (raw: unknown) => Snapshot | Refusal;

const encode = (superpipe({})('neo-intake-snapshot-encode') as PipelineAPI)
  .input(['entries'])
  .pipe(serialize, 'entries', 'result:encoded')
  .pipe(
    (encoded: string) => ('value' in parse(encoded) ? { value: encoded } : { reason: refusal }),
    'encoded',
    'result:encoded'
  )
  .end('encoded') as (entries: unknown) => string | Refusal;

export const neoIntakeSnapshots = { encode, decode };
