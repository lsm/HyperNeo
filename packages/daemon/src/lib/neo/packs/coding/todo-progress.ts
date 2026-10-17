import type { NeoAskItem, NeoAskTodo, NeoWorkPr } from '@hyperneo/shared/types/neo-snapshot';

export function neoCodingTodoProgress(
  items: readonly NeoAskItem[],
  prs: readonly NeoWorkPr[]
): Pick<NeoAskTodo, 'state' | 'status'> | null {
  const coding = items.filter((item) => item.check?.startsWith('coding.pr_'));
  if (!prs.length) return coding.length ? { state: 'running', status: '等 PR 开出来' } : null;
  const current = prs.some((pr) => pr.state !== 'CLOSED')
    ? prs.filter((pr) => pr.state !== 'CLOSED')
    : prs;
  const labels = prs.map((pr) => {
    const number = `#${pr.url.split('/').pop()}`;
    if (pr.state === 'MERGED') return `${number} 已合并`;
    if (pr.state === 'CLOSED') return `${number} 已关闭，没合并`;
    const waiting =
      pr.checks === 'failing'
        ? 'CI 没过'
        : pr.review === 'changes_requested'
          ? 'bot 要求修改'
          : pr.checks === 'pending'
            ? '等 CI'
            : pr.review === 'approved'
              ? '已批准，等合并'
              : '等 bot 批准';
    return `${number} 开着，${waiting}`;
  });
  const otherChecks = items.some(
    (item) => item.check && !item.check.startsWith('coding.pr_') && item.state !== 'met'
  );
  const done =
    !otherChecks &&
    current.every(
      (pr) =>
        pr.state === 'MERGED' ||
        (pr.state === 'OPEN' &&
          coding.length > 0 &&
          coding.every((item) => item.check === 'coding.pr_opened'))
    );
  return {
    state: done
      ? 'done'
      : current.some((pr) => pr.state === 'OPEN') || otherChecks
        ? 'running'
        : 'failed',
    status: labels.join('；'),
  };
}
