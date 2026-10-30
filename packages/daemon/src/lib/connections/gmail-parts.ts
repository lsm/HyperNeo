import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { z } from 'zod';
import type { GoogleReply } from './google-http.ts';

const partSchema = z.object({
  mimeType: z.string().max(100).default('application/octet-stream'),
  filename: z.string().max(1000).default(''),
  headers: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .max(100)
    .default([]),
  body: z
    .object({
      size: z.number().int().nonnegative().optional(),
      data: z.string().optional(),
      attachmentId: z.string().max(200).optional(),
    })
    .default({}),
  parts: z.array(z.unknown()).max(1000).default([]),
});
export const bodyPart = z.object({
  mimeType: z.string(),
  text: z.string().optional(),
  omitted: z.string().optional(),
});
export const attachment = z.object({
  filename: z.string(),
  mimeType: z.string(),
  size: z.number(),
  data: z.string().optional(),
  omitted: z.string().optional(),
});
function bytes(data: string) {
  const value = Buffer.from(data, 'base64url');
  if (value.toString('base64url') !== data.replace(/=+$/, '')) throw new Error('Invalid base64url');
  return value;
}
export async function readGmailParts(
  payload: unknown,
  options: { body: boolean; attachments: boolean },
  load: (id: string) => Promise<GoogleReply>
) {
  const bodyParts: z.infer<typeof bodyPart>[] = [],
    attachments: z.infer<typeof attachment>[] = [];
  const queue = [payload];
  let visited = 0,
    remaining = 4096,
    truncated = false;
  while (queue.length && visited++ < 32) {
    const part = partSchema.parse(queue.shift());
    queue.push(...part.parts);
    if (part.mimeType.startsWith('multipart/')) continue;
    const file = !!part.filename || !part.mimeType.startsWith('text/');
    if (file ? !options.attachments : !options.body) continue;
    if (file && attachments.length >= 2) {
      truncated = true;
      continue;
    }
    const summary = {
      filename: part.filename.slice(0, 100),
      mimeType: part.mimeType,
      size: part.body.size ?? 0,
    };
    let data = part.body.data;
    if (summary.size > 8192 && (file || part.body.attachmentId)) {
      if (file) attachments.push({ ...summary, omitted: 'byte_limit' });
      else bodyParts.push({ mimeType: part.mimeType, omitted: 'byte_limit' });
      truncated = true;
      continue;
    }
    if (data === undefined && part.body.attachmentId) {
      const reply = await load(part.body.attachmentId);
      if (!reply.ok) return reply;
      data = z.object({ data: z.string().max(10924) }).parse(reply.data).data;
    }
    const content = bytes(data ?? '');
    if (file && content.length > 8192) throw new Error('Attachment byte limit exceeded');
    if (file) attachments.push({ ...summary, data: content.toString('base64url') });
    else {
      const type = part.headers.find(
        (header) => header.name.toLowerCase() === 'content-type'
      )?.value;
      const charset = type?.match(/charset\s*=\s*["']?([^"';\s]+)/i)?.[1] ?? 'utf-8';
      try {
        const text = new TextDecoder(charset).decode(content);
        bodyParts.push({ mimeType: part.mimeType, text: text.slice(0, remaining) });
        truncated ||= text.length > remaining;
        remaining = Math.max(0, remaining - text.length);
      } catch {
        bodyParts.push({ mimeType: part.mimeType, omitted: 'unsupported_charset' });
        truncated = true;
      }
    }
    truncated ||= part.filename.length > 100;
  }
  return {
    ok: true as const,
    data: {
      ...(options.body ? { bodyParts } : {}),
      ...(options.attachments ? { attachments } : {}),
      truncated: truncated || queue.length > 0,
    },
  };
}
