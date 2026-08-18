export type TaskMilestoneCategory =
  | 'creation'
  | 'status'
  | 'instruction'
  | 'answer'
  | 'artifact'
  | 'review'
  | 'github'
  | 'retry';

export type TaskMilestoneTone =
  | 'neutral'
  | 'info'
  | 'progress'
  | 'success'
  | 'warning'
  | 'danger'
  | 'special';

export type TaskMilestoneSourceKind = 'human' | 'agent' | 'system' | 'github' | 'review';

export interface TaskMilestoneRow {
  id: string;
  taskId: string;
  category: TaskMilestoneCategory;
  tone: TaskMilestoneTone;
  title: string;
  body: string | null;
  sourceLabel: string | null;
  sourceKind: TaskMilestoneSourceKind | null;
  sourceId: string | null;
  createdAt: number;
}
