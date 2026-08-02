import { TaskMilestoneTimeline } from './TaskMilestoneTimeline';

interface TaskTimelineFeedProps {
  taskId: string;
  topInsetClass?: string;
  bottomInsetPx?: number;
}

/**
 * Task panel Timeline section. Renders the curated milestone feed
 * (creation, status transitions, instructions, agent answers, PR / review /
 * result artifacts, GitHub CI activity, collapsed API retries) — replacing the
 * verbose raw actor-message log. See `TaskMilestoneTimeline`.
 */
export function TaskTimelineFeed({ taskId, topInsetClass, bottomInsetPx }: TaskTimelineFeedProps) {
  return (
    <TaskMilestoneTimeline
      taskId={taskId}
      topInsetClass={topInsetClass}
      bottomInsetPx={bottomInsetPx}
    />
  );
}
