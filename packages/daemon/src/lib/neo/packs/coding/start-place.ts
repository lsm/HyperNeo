import type { Database } from '../../../../storage/sqlite-compat.ts';
import type { NeoStartPlacePolicy } from '../../start-place.ts';
import { CodingTodoPrRepository, createCodingTodoPolicy } from './todo-prs.ts';
import { isNeoReadCheckoutPath } from './read-checkout-path.ts';

export function createCodingStartPlacePolicy(db: Database): NeoStartPlacePolicy {
  const { repository } = createCodingTodoPolicy(new CodingTodoPrRepository(db));
  return (todo, ask, folder) =>
    (folder && isNeoReadCheckoutPath(folder)) ||
    repository(todo ?? { check: null, named: null }, { ask, todo, start: true })
      ? 'explicit'
      : 'shared-home';
}
