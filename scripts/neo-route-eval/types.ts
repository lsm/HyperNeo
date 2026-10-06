export type CaseKind =
  | 'follow_up'
  | 'second_last'
  | 'waiting_yes'
  | 'two_waiting'
  | 'one_off'
  | 'new_subject'
  | 'thanks'
  | 'long_dictated'
  | 'mixed_language'
  | 'real';

export interface EvalTopic {
  id: string;
  title: string;
  summary: string;
  latest?: { ask: string; answer: string };
  waiting?: string;
}

export interface EvalTurn {
  topic: string;
  ask: string;
  answer: string;
  at: string;
}

export interface EvalCase {
  id: string;
  source: 'real' | 'synthetic';
  kind: CaseKind;
  now: string;
  topics: EvalTopic[];
  turns: EvalTurn[];
  message: string;
  expected: string[];
  followUp: boolean;
}

export interface SystemOneChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface SystemOneRequest {
  state: string;
  model?: string;
  questions: Record<string, SystemOneChoiceQuestion>;
}

export interface SystemOneResponse {
  answers: Record<
    string,
    { type: 'choice'; choice: string; confidence?: number; probabilities?: Record<string, number> }
  >;
  usage?: { input_tokens?: number; output_tokens?: number };
  latency_ms?: number;
}

export interface EvalResult {
  caseId: string;
  kind: CaseKind;
  source: EvalCase['source'];
  followUp: boolean;
  expected: string[];
  predicted: string;
  confidence?: number;
  latencyMs: number;
  serverLatencyMs?: number;
  servedModel?: string;
  thinkingBlocks?: number;
  rawAnswer?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  error?: string;
}
