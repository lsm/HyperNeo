import { afterEach, beforeEach, expect, test } from 'vitest';
import { createTestDb } from '../../../helpers/database.ts';
import { NeoFrontInputRepository } from '../../../../src/storage/repositories/neo-front-input-worker.ts';
import { NeoPublicationRepository } from '../../../../src/storage/repositories/neo-publication-repository.ts';

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
