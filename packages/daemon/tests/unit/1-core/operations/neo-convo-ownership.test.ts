import { afterEach, beforeEach, expect, test } from 'vitest';
import { createTestDb } from '../../../helpers/database.ts';
import { NeoFrontInputRepository } from '../../../../src/storage/repositories/neo-front-input-worker.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';
import { frontSessionId } from '../../../../src/lib/neo/front-mode.ts';
import { runMigration504 } from '../../../../src/storage/schema/m504-neo-front-input-owner-backfill.ts';

const conversationId = '10000000-0000-4000-8000-000000000001';
let db: Awaited<ReturnType<typeof createTestDb>>;
let inputs: NeoFrontInputRepository;
let publications: NeoPublicationRepository;
beforeEach(async () => {
  db = await createTestDb();
  inputs = new NeoFrontInputRepository(db.getDatabase());
  publications = new NeoPublicationRepository(db.getDatabase());
});
afterEach(() => db.close());
function publish(ids: string[], publicationId = crypto.randomUUID()) {
  return publications.append({
    conversationId,
    publicationId,
    fullText: 'Answer',
    verbatim: true,
    replyTo: ids,
    links: [],
  });
}

test('one human input can receive twenty distinct published updates', () => {
  const id = crypto.randomUUID();
  inputs.accept(conversationId, id, true);
  for (let index = 0; index < 20; index++)
    expect(publish([id])).toMatchObject({ accepted: true, created: true });
  expect(publications.list(conversationId)).toHaveLength(20);
  expect(inputs.get(conversationId, id)?.owner).not.toBeNull();
});

test('a batch can include an input that already has an answer', () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  for (const id of ids) inputs.accept(conversationId, id, true);
  expect(publish([ids[0]])).toMatchObject({ accepted: true });
  expect(publish(ids)).toMatchObject({ accepted: true, created: true });
  expect(inputs.get(conversationId, ids[1])?.owner).not.toBeNull();
  expect(publications.list(conversationId)).toHaveLength(2);
});

test('the original publication retries without claiming or publishing again', () => {
  const id = crypto.randomUUID();
  const publicationId = crypto.randomUUID();
  inputs.accept(conversationId, id, true);
  expect(publish([id], publicationId)).toMatchObject({ accepted: true, created: true });
  expect(publish([id], publicationId)).toMatchObject({ accepted: true, created: false });
  expect(publications.list(conversationId)).toHaveLength(1);
});

test('historical answers allow a later result for the same input', () => {
  const id = crypto.randomUUID();
  expect(publish([id])).toMatchObject({ accepted: true });
  inputs.accept(conversationId, id, true);
  expect(publish([id])).toMatchObject({ accepted: true, created: true });
  expect(publications.list(conversationId)).toHaveLength(2);
});

test('an acknowledgment with no answer targets leaves the input claim available', () => {
  const id = crypto.randomUUID();
  inputs.accept(conversationId, id, true);
  expect(publish([])).toMatchObject({ accepted: true });
  expect(inputs.get(conversationId, id)?.owner).toBeNull();
  expect(publish([id])).toMatchObject({ accepted: true });
  expect(
    publications.list(conversationId)!.filter((entry) => entry.replyTo?.includes(id))
  ).toHaveLength(1);
});

const front = frontSessionId(conversationId);
const root = `neo:${conversationId}`;
const speak = (speaker: string, ids: string[], publicationId = crypto.randomUUID()) =>
  publications.append(
    { conversationId, publicationId, fullText: 'Answer', verbatim: true, replyTo: ids, links: [] },
    speaker
  );

test('the other lane cannot answer an input one lane owns', async () => {
  await db.updateGlobalSettings({ neo: { front: { enabled: true } } });
  const id = crypto.randomUUID();
  inputs.accept(conversationId, id, true);
  expect(speak(root, [id])).toMatchObject({ accepted: true });
  expect(speak(front, [id])).toEqual({ accepted: false, reason: 'input_handed_off' });
  expect(speak(root, [id])).toMatchObject({ accepted: true, created: true });
});

test('a card reply on an input the front owns is accepted with its card', async () => {
  await db.updateGlobalSettings({ neo: { front: { enabled: true } } });
  const id = crypto.randomUUID();
  inputs.accept(conversationId, id, true);
  expect(speak(front, [id])).toMatchObject({ accepted: true });
  const raw = db.getDatabase();
  raw.exec('PRAGMA foreign_keys = OFF');
  raw
    .prepare(
      "INSERT INTO neo_questions (id, ask_id, text, kind, created_at) VALUES ('q', 'ask', 'Ship?', 'yesno', 0)"
    )
    .run();
  expect(
    publications.append({
      conversationId,
      publicationId: crypto.randomUUID(),
      fullText: 'I replied · View card · Ship?',
      shortText: 'I replied · View card · Ship?',
      links: [],
      cardReply: {
        sourceMessageIds: [id],
        askId: 'ask',
        questionId: 'q',
        mutationId: crypto.randomUUID(),
      },
    })
  ).toMatchObject({ accepted: true, created: true });
  expect(inputs.get(conversationId, id)?.owner).toBe('front');
});

test('after the upgrade an input answered by inferred owner refuses the other lane', async () => {
  await db.updateGlobalSettings({ neo: { front: { enabled: true } } });
  const id = crypto.randomUUID();
  const publicationId = crypto.randomUUID();
  expect(publish([id], publicationId)).toMatchObject({ accepted: true });
  inputs.accept(conversationId, id, true);
  runMigration504(db.getDatabase());
  expect(inputs.get(conversationId, id)?.owner).toBe('neo');
  expect(speak(front, [id])).toEqual({ accepted: false, reason: 'input_handed_off' });
  expect(publish([id], publicationId)).toMatchObject({ accepted: true, created: false });
});
