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
  worksNote: string | null;
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

export interface GoalJournalEvidence {
  kind: 'pr' | 'todo' | 'metric' | 'url' | 'commit' | 'text';
  ref: string;
  note?: string;
}

export interface GoalJournalEntry {
  id: string;
  goalId: string;
  runId: string | null;
  sessionId: string | null;
  done: string;
  effect: string;
  evidence: GoalJournalEvidence[];
  worked: string;
  failed: string | null;
  createdAt: number;
}

export type GoalJournalDraft = Pick<GoalJournalEntry, 'done' | 'effect' | 'evidence' | 'worked'> &
  Partial<Pick<GoalJournalEntry, 'runId' | 'failed'>>;
