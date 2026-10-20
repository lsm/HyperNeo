export interface NeoConversationWake {
  scheduleId: string;
  sourceKind: string;
  sourceId: string;
  title: string;
  firedAt: number;
  settledAt: number | null;
  summary: string | null;
  additions: {
    kind: 'ask' | 'todo' | 'question' | 'publication' | 'journal';
    id: string;
    label: string;
  }[];
}
