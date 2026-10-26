import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateUUID } from '@hyperneo/shared';
import { handoffDraftDirectory, publishHandoff } from './outbox.ts';

export async function publishTextHandoff(dataDir: string, sessionId: string, text: string) {
  const sha = createHash('sha256').update(text).digest('hex');
  const name = `message-${generateUUID()}.txt`;
  const path = join(handoffDraftDirectory(dataDir, sessionId), name);
  await writeFile(path, text, { flag: 'wx', mode: 0o600 });
  const published = await publishHandoff(dataDir, sessionId, name);
  if (published.kind !== 'published') throw new Error(published.kind);
  if (
    published.reference.sha256 !== sha ||
    published.reference.byteLength !== Buffer.byteLength(text)
  )
    throw new Error('tampered');
  return published.reference;
}
