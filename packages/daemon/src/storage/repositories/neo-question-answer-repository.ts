import type { NeoQuestionAnswer, NeoQuestionSource } from '@hyperneo/shared/types/neo-ask';
import type { Database } from '../sqlite-compat.ts';

type StoredRoute = {
  id: string;
  todoId: string;
  sourceSession: NeoQuestionSource;
  receipt: string | null;
  acceptedAt: number | null;
};
type AnswerRow = {
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

  pending() {
    return this.project(this.rows()).filter((route) => route.state === 'pending');
  }

  accept(id: string, receipt: string, now: number): boolean {
    return this.atomic(() => {
      const route = this.pending().find((route) => route.id === id);
      if (!route) return false;
      const routes = JSON.parse(this.rows(route.questionId)[0].routes!) as StoredRoute[];
      this.write(
        route.questionId,
        JSON.stringify(
          routes.map((stored) =>
            stored.id === id ? { ...stored, receipt, acceptedAt: now } : stored
          )
        )
      );
      return true;
    });
  }

  private rows(id?: string): AnswerRow[] {
    return this.db
      .prepare(`SELECT id, answer, answered_by AS answeredBy,
      answered_at AS answeredAt, worker_answers_json AS routes FROM neo_questions
      WHERE ${id ? 'id = ?' : 'answer IS NOT NULL AND worker_answers_json IS NOT NULL'} ORDER BY id`)
      .all(...(id ? [id] : [])) as AnswerRow[];
  }

  private project(rows: AnswerRow[]) {
    return rows.flatMap((row) =>
      (JSON.parse(row.routes ?? '[]') as StoredRoute[]).map((route) => ({
        ...route,
        questionId: row.id,
        answer: row.answer === null ? null : (JSON.parse(row.answer) as NeoQuestionAnswer),
        answeredBy: row.answeredBy,
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
