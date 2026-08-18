import { TaskMilestoneTimeline } from './TaskMilestoneTimeline';

interface TaskTimelineFeedProps {
  taskId: string;
  topInsetClass?: string;
  bottomInsetPx?: number;
}

export function TaskTimelineFeed({ taskId, topInsetClass, bottomInsetPx }: TaskTimelineFeedProps) {
  return (
    <TaskMilestoneTimeline
      taskId={taskId}
      topInsetClass={topInsetClass}
      bottomInsetPx={bottomInsetPx}
    />
  );
}
