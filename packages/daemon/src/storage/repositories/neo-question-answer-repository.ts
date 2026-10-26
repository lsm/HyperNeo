import type { NeoQuestionAnswer, NeoQuestionSource } from '@hyperneo/shared/types/neo-ask';
import type { Database } from '../sqlite-compat.ts';
import { isAgentResolvedQuestion } from '@hyperneo/shared/types/neo-ask';

type StoredRoute = {
  id: string;
  todoId: string;
  sourceSession: NeoQuestionSource;
  receipt: string | null;
  acceptedAt: number | null;
  attemptedAt?: number | null;
};
type AnswerRow = {
  state: 'open' | 'answered' | 'retired';
  id: string;
  answer: string | null;
  answeredBy: 'button' | 'chat' | null;
  answeredAt: number | null;
  routes: string | null;
};

export class NeoQuestionAnswerRepository {
  constructor(
    private readonly db: Database,
    private readonly write: (id: string, routes: string) => void,
    private readonly atomic: <T>(work: () => T) => T
  ) {}

  snapshot<T>(id: string, question: () => T) {
    return this.atomic(() => ({ question: question(), answerDelivery: this.list(id) }));
  }

  bind(questionId: string, todoId: string, sourceSession: NeoQuestionSource): void {
    const routes = JSON.parse(this.rows(questionId)[0]?.routes ?? '[]') as StoredRoute[];
    const existing = routes.find((route) => route.todoId === todoId);
    if (existing) {
      if (existing.acceptedAt !== null) return;
      existing.sourceSession = sourceSession;
      this.write(questionId, JSON.stringify(routes));
      return;
    }
    this.write(
      questionId,
      JSON.stringify([
        ...routes,
        { id: `${questionId}:${todoId}`, todoId, sourceSession, receipt: null, acceptedAt: null },
      ])
    );
  }

  list(questionId: string) {
    return this.project(this.rows(questionId));
  }

  pending(questionId?: string) {
    return this.project(this.rows(questionId)).filter((route) => route.state === 'pending');
  }

  accept(id: string, receipt: string, now: number, expected?: string): boolean {
    return this.change(id, receipt, now, expected);
  }

  claim(id: string, key: string): boolean {
    return this.change(id, key, null, null);
  }

  retry(id: string, key: string): boolean {
    return this.change(id, null, null, key);
  }

  delivered(todoId: string, ref: string | null): boolean {
    const route = this.project(this.rows()).find((route) => route.todoId === todoId);
    const assigned = ref ? JSON.parse(ref) : null;
    return (
      route?.state === 'accepted' &&
      assigned?.adapter === route.sourceSession.adapter &&
      assigned.id === route.sourceSession.id &&
      assigned.daemon === route.sourceSession.daemon
    );
  }

  private change(
    id: string,
    receipt: string | null,
    now: number | null,
    expected?: string | null
  ): boolean {
    return this.atomic(() => {
      const route = this.pending().find((route) => route.id === id);
      if (!route || (expected !== undefined && route.receipt !== expected)) return false;
      const routes = JSON.parse(this.rows(route.questionId)[0].routes!) as StoredRoute[];
      this.write(
        route.questionId,
        JSON.stringify(
          routes.map((stored) =>
            stored.id === id
              ? {
                  ...stored,
                  receipt,
                  acceptedAt: now,
                  ...(now === null ? { attemptedAt: receipt === null ? null : Date.now() } : {}),
                }
              : stored
          )
        )
      );
      return true;
    });
  }

  private rows(id?: string): AnswerRow[] {
    return this.db
      .prepare(`SELECT id, state, answer, answered_by AS answeredBy,
      answered_at AS answeredAt, worker_answers_json AS routes FROM neo_questions
      WHERE ${id ? 'id = ?' : 'worker_answers_json IS NOT NULL'} ORDER BY rowid DESC`)
      .all(...(id ? [id] : [])) as AnswerRow[];
  }

  private project(rows: AnswerRow[]) {
    return rows.flatMap((row) =>
      (JSON.parse(row.routes ?? '[]') as StoredRoute[]).map((route) => ({
        ...route,
        questionId: row.id,
        answer: row.answer === null ? null : (JSON.parse(row.answer) as NeoQuestionAnswer),
        answeredBy: isAgentResolvedQuestion(row) ? ('rule' as const) : row.answeredBy,
        answeredAt: row.answeredAt,
        state:
          route.acceptedAt !== null
            ? ('accepted' as const)
            : row.answer !== null
              ? ('pending' as const)
              : ('waiting' as const),
      }))
    );
  }
}
