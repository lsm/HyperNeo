export type FlowUnwindEntry = {
  stage: string;
  status: 'compensated' | 'failed';
  error?: unknown;
};

export type FlowOutcome = {
  status: 'completed' | 'superseded' | 'error';
  result?: unknown;
  stage?: string;
  error?: unknown;
  unwind?: readonly FlowUnwindEntry[];
};
