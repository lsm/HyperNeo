import { Buffer } from 'node:buffer';
import { z } from 'zod';

const address = z.string().email().max(254);
export const draftInput = z
  .object({
    connectionId: z.string().min(1).max(200),
    draftId: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9_-]+$/)
      .refine((value) => value !== 'send')
      .optional(),
    to: z.array(address).min(1).max(10),
    cc: z.array(address).max(10).default([]),
    bcc: z.array(address).max(10).default([]),
    subject: z
      .string()
      .max(200)
      .regex(/^[^\r\n]*$/)
      .default(''),
    text: z.string().max(4096).default(''),
    attachments: z
      .array(
        z
          .object({
            filename: z.string().min(1).max(100),
            mimeType: z
              .string()
              .max(100)
              .regex(/^[\w.+-]+\/[\w.+-]+$/),
            data: z
              .string()
              .max(10924)
              .regex(/^[A-Za-z0-9_-]*$/)
              .refine(
                (value) =>
                  Buffer.from(value, 'base64url').toString('base64url') === value &&
                  Buffer.from(value, 'base64url').length <= 8192
              ),
          })
          .strict()
      )
      .max(2)
      .default([]),
  })
  .strict();
const encode = (value: Uint8Array) =>
  Buffer.from(value)
    .toString('base64')
    .match(/.{1,76}/g)
    ?.join('\r\n') ?? '';
function subject(value: string) {
  const words: string[] = [];
  let current = '';
  for (const point of value) {
    if (Buffer.byteLength(current + point) > 45) {
      words.push(current);
      current = '';
    }
    current += point;
  }
  if (current) words.push(current);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word).toString('base64')}?=`).join('\r\n ');
}
export function makeDraftMime(input: z.infer<typeof draftInput>, sender: string) {
  const boundary = 'hyperneo-draft';
  const headers = [
    `From: ${sender}`,
    ...(['to', 'cc', 'bcc'] as const).flatMap((key) =>
      input[key].length
        ? [`${key[0].toUpperCase()}${key.slice(1)}: ${input[key].join(',\r\n ')}`]
        : []
    ),
    `Subject: ${subject(input.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const text = [
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    encode(Buffer.from(input.text)),
  ].join('\r\n');
  const files = input.attachments.map((file) => {
    const filename = encodeURIComponent(file.filename).replace(
      /['()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
    );
    return [
      `Content-Type: ${file.mimeType}`,
      `Content-Disposition: attachment; filename*=UTF-8''${filename}`,
      'Content-Transfer-Encoding: base64',
      '',
      encode(Buffer.from(file.data, 'base64url')),
    ].join('\r\n');
  });
  const mime = `${headers.join('\r\n')}\r\n\r\n${[text, ...files].map((part) => `--${boundary}\r\n${part}\r\n`).join('')}--${boundary}--\r\n`;
  const raw = Buffer.from(mime).toString('base64url');
  return raw.length <= 65536
    ? { value: JSON.stringify({ message: { raw } }) }
    : { reason: { ok: false as const, reason: 'draft_too_large' } };
}
