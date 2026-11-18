import type { Database } from '../../../../storage/sqlite-compat.ts';
import type { WorkRef } from '../../../drivers/types.ts';
import type { NeoPackPreferenceDeclaration } from '../../pack-contract.ts';
import { listPackPreferences } from '../../preference-operations.ts';

const STRATEGIES = ['long_lived', 'per_task', 'per_pr'] as const;
export type CodingSessionStrategy = (typeof STRATEGIES)[number];

export const CODING_SESSION_STRATEGY_PREFERENCE: NeoPackPreferenceDeclaration = {
  label: { en: 'Session strategy', 'zh-Hans': '会话策略' },
  question: { en: 'How should sessions be reused?', 'zh-Hans': '如何复用会话？' },
  valueLabels: {
    long_lived: { en: 'Long-lived work-type sessions', 'zh-Hans': '按工作类型长期复用会话' },
    per_task: { en: 'One session per task', 'zh-Hans': '每个任务一个会话' },
    per_pr: { en: 'One session per PR', 'zh-Hans': '每个 PR 一个会话' },
  },
  valueDescriptions: {
    long_lived: {
      en: 'Reuse work-type sessions across tasks.',
      'zh-Hans': '按工作类型跨任务复用会话。',
    },
    per_task: { en: 'Start one session per task.', 'zh-Hans': '每个任务启动一个会话。' },
    per_pr: { en: 'Start one session per pull request.', 'zh-Hans': '每个拉取请求启动一个会话。' },
  },
  scope: 'repo',
  type: { kind: 'enum', values: STRATEGIES },
  default: 'long_lived',
  ask: 'How should Neo reuse sessions in this repository? Long-lived reuses work-type sessions and keeps a feature in one session; per-task and per-PR start one session each. Until answered, Neo uses long-lived without saving a preference.',
};

/** @public */
export function codingSessionStrategy(db: Database, repo: string): CodingSessionStrategy {
  return savedCodingSessionStrategy(db, repo) ?? 'long_lived';
}

export function savedCodingSessionStrategy(db: Database, repo: string) {
  const saved = listPackPreferences(db, 'coding').filter((row) => row.key === 'sessionStrategy');
  const value = (
    saved.find(
      (row) => row.scope.kind === 'repo' && row.scope.key.toLowerCase() === repo.toLowerCase()
    ) ?? saved.find((row) => row.scope.kind === 'global')
  )?.value;
  return STRATEGIES.find((strategy) => strategy === value) ?? null;
}

type Session = { ref: WorkRef; name: string; state: 'available' | 'busy' | 'unknown' | 'archived' };
type Plan =
  | { verb: 'send'; ref: WorkRef; bind: boolean }
  | { verb: 'queue'; ref: WorkRef }
  | { verb: 'start'; name?: string }
  | { verb: 'wait' };

const ofType = (name: string, workType: string) =>
  name === workType ||
  (name.startsWith(`${workType}-`) && /^\d+$/.test(name.slice(workType.length + 1)));

function workTypeName(workType: string, pool: readonly Session[]): string {
  const taken = new Set(pool.map((candidate) => candidate.name));
  if (!taken.has(workType)) return workType;
  let n = 2;
  while (taken.has(`${workType}-${n}`)) n++;
  return `${workType}-${n}`;
}

/** @public */
export function planCodingSessionDispatch(input: {
  strategy: CodingSessionStrategy;
  workType: string;
  assigned?: Session;
  pool: readonly Session[];
}): Plan {
  const { assigned, pool, workType } = input;
  if (assigned)
    return assigned.state === 'available'
      ? { verb: 'send', ref: assigned.ref, bind: false }
      : assigned.state === 'busy'
        ? { verb: 'queue', ref: assigned.ref }
        : { verb: 'wait' };
  if (input.strategy !== 'long_lived') return { verb: 'start' };
  const idle = pool.filter((candidate) => candidate.state === 'available');
  const reuse = idle.find((candidate) => ofType(candidate.name, workType));
  if (reuse) return { verb: 'send', ref: reuse.ref, bind: true };
  if (pool.some((candidate) => candidate.state === 'unknown')) return { verb: 'wait' };
  return { verb: 'start', name: workTypeName(workType, pool) };
}
