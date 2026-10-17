import type { NeoWork } from '@hyperneo/shared/types/neo-context';
import type {
  NeoAsk,
  NeoAskItem,
  NeoAskTodo,
  NeoCardView,
  NeoWorkPrReceipt,
  NeoWorkSupersession,
} from '@hyperneo/shared/types/neo-snapshot';
import { neoTodoCriterionMet } from './todo-criterion.ts';
import { neoCodingTodoProgress } from './packs/coding/todo-progress.ts';

export type NeoAskTodoParts = {
  work: readonly NeoWork[];
  supersessions: readonly NeoWorkSupersession[];
};

const question = (item: NeoAskItem) =>
  !!(item.decision || item.kind || item.question || item.options?.length);

function startedAt(ask: NeoAsk): number | null {
  const answers = (ask.doneItems ?? []).flatMap((item) =>
    item.kind === 'approval' &&
    item.answer?.choice === item.options?.at(-1) &&
    item.answer?.at != null
      ? [item.answer.at]
      : []
  );
  return answers.length ? Math.min(...answers) : (ask.approvedAt ?? null);
}

function itemProgress(item: NeoAskItem): Pick<NeoAskTodo, 'state' | 'status'> {
  if (item.removed) return { state: 'cancelled', status: item.removedReason ?? '已取消' };
  if (neoTodoCriterionMet(item)) return { state: 'done', status: '完成标准已满足' };
  if (item.state === 'reported') return { state: 'running', status: '已回报，等核实' };
  return { state: 'pending', status: '等 daemon 核实' };
}

export function projectNeoAskTodos(
  ask: NeoAsk,
  cards: readonly NeoCardView[],
  prs: readonly NeoWorkPrReceipt[],
  parts: NeoAskTodoParts
): NeoAskTodo[] {
  const items = (ask.doneItems ?? []).filter((item) => !question(item));
  const work = ask.workIds.flatMap((id) => parts.work.find((row) => row.id === id) ?? []);
  const start = startedAt(ask);
  const rows: NeoAskTodo[] = work.map((row) => {
    const card = cards.find((view) => view.workId === row.id);
    const owned = items.filter((item) => item.deliveredBy === row.id && !item.removed);
    const removed = items.filter((item) => item.deliveredBy === row.id && item.removed);
    const replacedBy = parts.supersessions.find((link) => link.workId === row.id)?.supersededBy;
    const replacement = parts.work.find((candidate) => candidate.id === replacedBy);
    let progress: Pick<NeoAskTodo, 'state' | 'status'>;
    const coding = neoCodingTodoProgress(
      owned,
      prs.find((receipt) => receipt.workId === row.id)?.prs ?? []
    );
    if (row.status === 'cancelled' || replacedBy)
      progress = {
        state: 'cancelled',
        status: replacement
          ? `换成「${replacement.title}」`
          : replacedBy
            ? '已换成其他 todo'
            : card?.controlFailure
              ? `已取消；会话可能仍在跑：无法${card.controlFailure.operation === 'stop' ? '停止' : '撤回'}（${card.controlFailure.detail}）`
              : '已取消',
      };
    else if (row.status === 'failed' || card?.phase === 'stopped')
      progress = {
        state: 'failed',
        status: `${row.status === 'failed' ? '没交出去' : '会话停了'}：${card?.talk ?? row.report ?? '没有完成'}`,
      };
    else if (card?.phase === 'abandoned')
      progress = { state: 'failed', status: '会话没有回报结果' };
    else if (row.status === 'proposed')
      progress = {
        state: 'pending',
        status: owned.map((item) => item.text).join('；') || card?.doneWhen || '等你开始',
      };
    else if (row.status === 'queued' && !row.sessionId && !card?.adapter)
      progress = { state: 'pending', status: '还没交给会话' };
    else if (coding) progress = coding;
    else if (owned.length && owned.every(neoTodoCriterionMet))
      progress = { state: 'done', status: '完成标准已满足' };
    else if (row.status === 'reported')
      progress = {
        state: owned.some((item) => item.check || item.watch?.length) ? 'running' : 'done',
        status: '会话说做完了，没查到 PR',
      };
    else
      progress = {
        state: 'running',
        status:
          card?.phase === 'handed'
            ? '已交给会话'
            : card?.phase === 'needs_you'
              ? '会话等你回复'
              : card?.phase === 'checking'
                ? '会话已结束，daemon 正在核实'
                : '会话在做',
      };
    return {
      id: row.id,
      workId: row.id,
      ...(card ? { open: card.open } : {}),
      title: row.title,
      ...progress,
      status: [
        progress.status,
        ...removed.map(
          (item) =>
            `已取消标准：${item.text}${item.removedReason ? `（${item.removedReason}）` : ''}`
        ),
      ].join('；'),
      added: start !== null && row.createdAt > start,
    };
  });
  const ids = new Set(work.map((row) => row.id));
  for (const item of items.filter((item) => !item.deliveredBy || !ids.has(item.deliveredBy)))
    rows.push({
      id: item.id,
      workId: null,
      title: item.text,
      ...itemProgress(item),
      added: start !== null && item.addedAt !== null && item.addedAt > start,
    });
  return rows;
}
