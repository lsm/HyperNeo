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

test('a fresh publication id cannot answer an already claimed human input', () => {
  const id = crypto.randomUUID();
  inputs.accept(conversationId, id, true);
  expect(publish([id])).toMatchObject({ accepted: true, created: true });
  expect(publish([id])).toMatchObject({ accepted: false });
  expect(publications.list(conversationId)).toHaveLength(1);
  expect(inputs.get(conversationId, id)?.owner).not.toBeNull();
});

test('a conflicting batch neither publishes nor claims its unclaimed members', () => {
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  for (const id of ids) inputs.accept(conversationId, id, true);
  expect(publish([ids[0]])).toMatchObject({ accepted: true });
  expect(publish(ids)).toMatchObject({ accepted: false });
  expect(inputs.get(conversationId, ids[1])?.owner).toBeNull();
  expect(publications.list(conversationId)).toHaveLength(1);
});

test('the original publication retries without claiming or publishing again', () => {
  const id = crypto.randomUUID();
  const publicationId = crypto.randomUUID();
  inputs.accept(conversationId, id, true);
  expect(publish([id], publicationId)).toMatchObject({ accepted: true, created: true });
  expect(publish([id], publicationId)).toMatchObject({ accepted: true, created: false });
  expect(publications.list(conversationId)).toHaveLength(1);
});

test('historical answers block a second claim even when their owner was not recorded', () => {
  const id = crypto.randomUUID();
  expect(publish([id])).toMatchObject({ accepted: true });
  inputs.accept(conversationId, id, true);
  expect(publish([id])).toMatchObject({ accepted: false });
  expect(publications.list(conversationId)).toHaveLength(1);
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
