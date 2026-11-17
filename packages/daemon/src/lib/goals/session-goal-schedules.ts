import { GOAL_SESSION_CYCLE, NEO_GOAL_CYCLE } from '@hyperneo/prompts';
import { createHash } from 'node:crypto';
import type { SessionGoal } from '@hyperneo/shared/types/session-goal';
import type { SessionGoalRepository } from '../../storage/repositories/session-goal-repository.ts';
import type { NeoAskTodoRepository } from '../../storage/repositories/neo-ask-todo-repository.ts';
import type { SessionScheduleCadence } from '../../storage/repositories/session-schedule-repository.ts';
import type { NeoPack } from '../neo/pack-contract.ts';
import type { ScheduleSource, SessionScheduler } from '../scheduler/session-schedules.ts';

export class SessionGoalSchedules implements ScheduleSource {
  readonly kind = 'goal';

  constructor(
    private readonly goals: SessionGoalRepository,
    private readonly asks: NeoAskTodoRepository,
    private readonly scheduler: SessionScheduler,
    private readonly packs: () => readonly NeoPack[],
    private readonly canReturn: (sessionId: string) => boolean,
    private readonly mandateChange: (
      ref: string,
      revision: string | null
    ) => Promise<string | null> = async () => null,
    private readonly reviewReport: (sessionId: string) => string = (sessionId) =>
      this.canReturn(sessionId) ? ' Send Neo the review summary with session.clone.return.' : ''
  ) {
    scheduler.registerSource({
      kind: 'goal_review',
      alwaysFire: true,
      label: (id) => this.label(id),
      facts: async (id) => {
        const goal = goals.get(id);
        return goal && goal.status !== 'completed' && goal.status !== 'archived'
          ? { digest: 'review', summary: '' }
          : null;
      },
      message: (id) => this.reviewMessage(id),
    });
  }

  sync(
    goal: SessionGoal,
    cadence?: SessionScheduleCadence,
    nudgeEvery = 4,
    reviewCadence?: SessionScheduleCadence
  ): void {
    let known = this.scheduler.repo.getBySource(this.kind, goal.id);
    const config = known
      ? { cadence: known.cadence, nudgeEvery: known.nudgeEvery }
      : ((cadence ? { cadence, nudgeEvery } : this.goals.wakeSchedule(goal.id)) ?? {
          cadence: { kind: 'every' as const, everyMs: 3_600_000 },
          nudgeEvery: 4,
        });
    const previous = this.goals.wakeSchedule(goal.id);
    const review = reviewCadence ??
      previous?.reviewCadence ?? { kind: 'every' as const, everyMs: 86_400_000 };
    this.goals.saveWakeSchedule(goal.id, { ...config, reviewCadence: review });
    const canReview = goal.ownerSessionId.startsWith('neo:') || this.canReturn(goal.ownerSessionId);
    let reviewRow = this.scheduler.repo.getBySource('goal_review', goal.id);
    if (
      reviewRow &&
      (!canReview ||
        goal.status === 'completed' ||
        goal.status === 'archived' ||
        (goal.status === 'active' && reviewRow.status === 'done') ||
        (reviewCadence && JSON.stringify(reviewRow.cadence) !== JSON.stringify(review)))
    ) {
      this.scheduler.delete(reviewRow);
      reviewRow = null;
    }
    if (canReview && goal.status !== 'completed' && goal.status !== 'archived') {
      reviewRow ??= this.scheduler.create({
        target: { adapter: 'hyperneo', id: goal.ownerSessionId },
        sourceKind: 'goal_review',
        sourceId: goal.id,
        note: null,
        cadence: review,
        nudgeEvery: 4,
        createdBySession: goal.ownerSessionId,
      });
      if (goal.status === 'paused' && reviewRow.status === 'active')
        this.scheduler.pause(reviewRow);
      if (goal.status === 'active' && reviewRow.status === 'paused')
        this.scheduler.resume(reviewRow);
    }
    if (goal.status === 'completed' || goal.status === 'archived') {
      if (known) this.scheduler.delete(known);
      return;
    }
    if (goal.status === 'active' && known?.status === 'done') {
      this.scheduler.delete(known);
      known = null;
    }
    const row =
      known ??
      this.scheduler.create({
        target: { adapter: 'hyperneo', id: goal.ownerSessionId },
        sourceKind: this.kind,
        sourceId: goal.id,
        note: null,
        cadence: config.cadence,
        nudgeEvery: config.nudgeEvery,
        createdBySession: goal.ownerSessionId,
      });
    if (goal.status === 'paused' && row.status === 'active') this.scheduler.pause(row);
    if (goal.status === 'active' && row.status === 'paused') this.scheduler.resume(row);
  }

  label(id: string): string | null {
    return this.goals.get(id)?.title ?? null;
  }

  dailyRunLimit(id: string): number | null {
    return this.goals.get(id)?.dailyRunLimit ?? null;
  }

  async facts(id: string) {
    const goal = this.goals.get(id);
    if (!goal || goal.status === 'completed' || goal.status === 'archived') return null;
    const asks = await this.asks.read('listGoalAsks', id);
    const rows = await this.asks.read(
      'listTodosForAsks',
      asks.map((ask) => ask.id)
    );
    const todos = asks.flatMap((ask) => rows.filter((todo) => todo.askId === ask.id));
    const todoIds = todos.map((todo) => todo.id);
    const packs = this.packs();
    const state = this.goals.factState(id);
    const mandate = goal.mandateRef
      ? await this.mandateChange(goal.mandateRef, goal.mandateRev)
      : null;
    const lines = [
      ...(mandate
        ? [
            `Mandate changed: ${goal.mandateRef} at ${mandate}; read and reconcile, then goal.session.update mandateRev ${mandate}.`,
          ]
        : []),
      `Progress: ${goal.progress}`,
      ...Object.keys(goal.metrics)
        .sort()
        .map((key) => `Metric ${key}: ${JSON.stringify(goal.metrics[key])}`),
      ...asks.map(
        (ask) => `Ask ${ask.id} topic=${ask.topic ?? 'none'} "${ask.title}": ${ask.status}`
      ),
      ...todos.map((todo) => {
        const candidates = todo.check
          ? packs.filter((pack) => pack.id === todo.check!.pack)
          : packs;
        const status = candidates.map((pack) => pack.todos?.statusLine(todo)?.status).find(Boolean);
        return `Todo ${todo.id} "${todo.title}": ${todo.state}${status ? `; ${status}` : ''}`;
      }),
      ...packs.flatMap((pack) =>
        (pack.snapshotRows?.([], Date.now(), todoIds) ?? [])
          .filter((row) => typeof row.todoId === 'string' && todoIds.includes(row.todoId))
          .map(
            (row) =>
              `Pack ${pack.id}: ${JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))))}`
          )
      ),
      ...asks.flatMap((ask) =>
        this.asks
          .listQuestions(ask.id)
          .filter((question) => question.state === 'answered')
          .map(
            (question) =>
              `Answer ${question.id} "${question.text}": ${JSON.stringify(question.answer)}`
          )
      ),
    ].sort();
    const previous = state.lines;
    const summary = [
      ...previous.filter((line) => !lines.includes(line)).map((line) => `- ${line}`),
      ...lines.filter((line) => !previous.includes(line)).map((line) => `+ ${line}`),
    ].join('\n');
    return {
      lines,
      digest: createHash('sha256').update(JSON.stringify(lines)).digest('hex'),
      summary,
      commit: () => this.goals.recordFacts(id, lines),
    };
  }

  message(id: string, change: { summary: string; nudge: boolean }): string | null {
    const goal = this.goals.get(id);
    const schedule = this.scheduler.repo.getBySource(this.kind, id);
    if (!goal || goal.status === 'completed' || goal.status === 'archived' || !schedule)
      return null;
    const runId = `schedule:${schedule.id}:${schedule.nextRunAt}`;
    const state = this.goals.factState(id);
    const own = this.canReturn(goal.ownerSessionId);
    return `${own ? GOAL_SESSION_CYCLE : NEO_GOAL_CYCLE}\n\nGoal "${goal.title}": ${change.nudge ? 'Nothing moved; check what can advance.' : change.summary}
Read ${goal.mandateRef ?? 'the goal definition'} and this what-works note:
${state.note ?? 'No what-works note yet.'}
Act using the usual tools${own ? '' : `; new asks in this cycle carry goalId ${id}`}.
Then append one goal.journal.append entry for goalId ${id}, runId ${runId}.`;
  }

  private async reviewMessage(id: string): Promise<string | null> {
    const goal = this.goals.get(id);
    const schedule = this.scheduler.repo.getBySource('goal_review', id);
    if (!goal || !schedule || goal.status === 'completed' || goal.status === 'archived')
      return null;
    const entries = await this.goals.journalSinceReview(id);
    const runId = `goal-review:${schedule.id}:${schedule.nextRunAt}`;
    return `${this.canReturn(goal.ownerSessionId) ? 'This session owns the goal below. ' : ''}Review goal "${goal.title}". Journal entries since the previous review:\n${JSON.stringify(entries)}\nCurrent what-works note: ${goal.worksNote ?? 'None'}\nSummarize what worked and failed and whether this period had an effect (yes or no). Append the review through goal.journal.append with goalId ${id}, runId ${runId}, the summary in done, and yes or no in effect. Then update the what-works note with goal.session.update {goalId, worksNote}, retaining routines within the goal definition's limits.${this.reviewReport(goal.ownerSessionId)}`;
  }
}
