import { expect, test } from 'bun:test';
import { NEO_PACK_CODING_INSTRUCTIONS } from '@hyperneo/prompts';
import {
  createNeoTodoOperations,
  type NeoTodoControls,
} from '../../../../src/lib/neo/todo-operations.ts';
import type { NeoAskTodoRepository } from '../../../../src/storage/repositories/neo-ask-todo-repository.ts';
import type { NeoTodoSessionRepository } from '../../../../src/storage/repositories/neo-todo-session-repository.ts';

const operations = createNeoTodoOperations(
  {} as NeoAskTodoRepository,
  {} as NeoTodoSessionRepository,
  {} as NeoTodoControls,
  () => [],
  () => null
);

test.each(['neo.todo.add', 'neo.todo.edit'])('%s explains the PR todo chain', (name) => {
  const description = operations.find((op) => op.name === name)!.description;
  for (const term of ['one PR per todo', 'pr_merged', 'after', 'addUrls'])
    expect(description).toContain(term);
});

test('coding guidance shows separate PR checks and the existing dependency queue', () => {
  for (const term of [
    'one PR per todo',
    'after',
    'addUrls',
    'queue starts',
    'Example:',
    'pr_merged',
  ])
    expect(NEO_PACK_CODING_INSTRUCTIONS).toContain(term);
  expect(NEO_PACK_CODING_INSTRUCTIONS).not.toContain('Existing pr_merged todos keep working.');
});
