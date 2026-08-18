import type { SpaceTaskRepository } from '../../../storage/repositories/space-task-repository';

export interface CompletionOptions {
  workflowRunId: string;
}

export class CompletionDetector {
  constructor(private readonly taskRepo: SpaceTaskRepository) {}

  isComplete(options: CompletionOptions): boolean {
    const tasks = this.taskRepo.listByWorkflowRun(options.workflowRunId);
    if (tasks.length === 0) return false;

    for (const task of tasks) {
      if (task.status === 'done' || task.status === 'cancelled') return true;
      if (task.reportedStatus !== null) return true;
    }
    return false;
  }
}
