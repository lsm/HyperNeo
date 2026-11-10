import type { SpaceGoal } from '@hyperneo/shared';

export function goalTaskLabels(goal: SpaceGoal): string[] {
  return Array.from(new Set(['goal', `goal:${goal.id}`, ...goal.labels]));
}

export function buildTaskDescription(goal: SpaceGoal): string {
  const sections = [
    `Goal: ${goal.title}`,
    goal.description,
    goal.summary ? `Current summary:\n${goal.summary}` : '',
    goal.nextSteps.length > 0
      ? `Next steps:\n${goal.nextSteps.map((s) => `- ${s}`).join('\n')}`
      : '',
  ].filter(Boolean);
  return sections.join('\n\n');
}
