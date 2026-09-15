export class PendingCompletionSupersededError extends Error {
  constructor(taskId: string) {
    super(`Pending completion decision superseded for task ${taskId}`);
    this.name = 'PendingCompletionSupersededError';
  }
}
