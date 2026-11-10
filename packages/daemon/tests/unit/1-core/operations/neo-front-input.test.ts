import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createTestDb } from '../../../helpers/database.ts';
import type { Database } from '../../../../src/storage/database.ts';
import { NeoFrontInputRepository } from '../../../../src/storage/repositories/neo-front-input-worker.ts';

let db: Database;
let inputs: NeoFrontInputRepository;
beforeEach(async () => {
  db = await createTestDb();
  inputs = new NeoFrontInputRepository(db.getDatabase());
});
afterEach(() => db.close());

test('eligibility is stamped once even when a retry flips the setting', () => {
  inputs.accept('conversation', 'off', false);
  inputs.accept('conversation', 'on', true);
  inputs.accept('conversation', 'off', true);
  inputs.accept('conversation', 'on', false);
  expect(inputs.get('conversation', 'off')?.eligible).toBe(false);
  expect(inputs.get('conversation', 'on')?.eligible).toBe(true);
});

test('front and Neo contend for the same durable input and a replay cannot take ownership', () => {
  inputs.accept('conversation', 'input', true);
  expect(inputs.claim('conversation', ['input'], 'front')).toBe(true);
  expect(inputs.claim('conversation', ['input'], 'neo')).toBe(false);
  expect(inputs.claim('conversation', ['input'], 'front')).toBe(false);
});

test('a mixed batch does not partially claim when one message already belongs to the front', () => {
  inputs.accept('conversation', 'first', true);
  inputs.accept('conversation', 'second', true);
  inputs.claim('conversation', ['first'], 'front');
  expect(inputs.claim('conversation', ['first', 'second'], 'neo')).toBe(false);
  expect(inputs.get('conversation', 'second')?.owner).toBe(null);
});

test('missing, cross-conversation and disabled inputs cannot be claimed', () => {
  inputs.accept('conversation', 'input', false);
  expect(inputs.claim('conversation', ['input'], 'front')).toBe(false);
  expect(inputs.claim('other', ['input'], 'front')).toBe(false);
  expect(inputs.claim('conversation', ['missing'], 'neo')).toBe(false);
  expect(inputs.claim('conversation', [], 'neo')).toBe(false);
});
