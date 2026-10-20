import type { SpaceGoal, SpaceGoalMetrics, SpaceGoalStatus, SpaceGoalType } from './space.ts';

export interface SessionGoal {
  id: string;
  ownerSessionId: string;
  title: string;
  description: string;
  status: SpaceGoalStatus;
  type: SpaceGoalType;
  priority: SpaceGoal['priority'];
  metrics: SpaceGoalMetrics;
  doneTest: string | null;
  summary: string;
  progress: number;
  nextSteps: string[];
  mandateRef: string | null;
  mandateRev: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  revision: number;
}

export type SessionGoalDraft = Pick<SessionGoal, 'title'> &
  Partial<
    Pick<
      SessionGoal,
      | 'description'
      | 'type'
      | 'priority'
      | 'metrics'
      | 'doneTest'
      | 'summary'
      | 'progress'
      | 'nextSteps'
      | 'mandateRef'
      | 'mandateRev'
    >
  >;

export type SessionGoalPatch = Partial<SessionGoalDraft & Pick<SessionGoal, 'status'>>;
