export type TaskLifecycleStatus =
  | 'draft'
  | 'open'
  | 'in_progress'
  | 'review'
  | 'approved'
  | 'done'
  | 'blocked'
  | 'cancelled'
  | 'archived'
  | 'rate_limited'
  | 'usage_limited'
  | 'stopped';

export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export interface TaskCore {
  id: string;
  title: string;
  description: string;
  status: TaskLifecycleStatus;
  priority: TaskPriority;
  labels: string[];
  dependsOn: string[];
  result: string | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  archivedAt: number | null;
  updatedAt: number;
}
