import type { Database } from '../../../../storage/sqlite-compat.ts';
import { NeoTodoSessionRepository } from '../../../../storage/repositories/neo-todo-session-repository.ts';
import { githubUrlKey, parsePrUrl } from '../../../github/parse-pr-url.ts';
import { CodingAssignmentsRepository } from './assignments.ts';
import { CodingPrLedgerRepository } from './pr-ledger.ts';
import { CodingTodoPrRepository } from './todo-prs.ts';

export type CodingMergeLocalRequest = { todoId: string; url: string; head: string };

export function readCodingMergeLocal(db: Database, input: CodingMergeLocalRequest) {
  const ledger = new CodingPrLedgerRepository(db);
  const pr = parsePrUrl(input.url)!;
  return {
    assignments: new CodingAssignmentsRepository(db).read(input.todoId, input.url, input.head),
    write: new NeoTodoSessionRepository(db).readCard(input.todoId)?.ref,
    facts: ledger.stageFacts.read(input.url),
    policy: ledger.policy(`${pr.owner}/${pr.repo}`),
    live: !!db
      .prepare(
        "SELECT 1 FROM neo_todos t JOIN neo_asks a ON a.id=t.ask_id WHERE t.id=? AND t.state IN ('doing','blocked') AND a.status='open'"
      )
      .get(input.todoId),
    linked: new CodingTodoPrRepository(db).urls(input.todoId).includes(githubUrlKey(input.url)),
  };
}

export type CodingMergeLocalAdmission = {
  input: CodingMergeLocalRequest;
  state: ReturnType<typeof readCodingMergeLocal>;
};
