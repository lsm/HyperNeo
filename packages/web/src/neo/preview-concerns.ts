export interface PreviewConcern {
  id: string;
  title: string;
  summary: string;
  context: string[];
  sources: string[];
}

export const previewConcerns: PreviewConcern[] = [
  {
    id: 'launch',
    title: 'The September launch',
    summary: 'Keep the launch small enough to ship. Bring timing decisions back to you.',
    context: [
      'The original target was Friday.',
      'A reliable signup matters more than extra features.',
    ],
    sources: ['Product Space · signup verification task', 'Launch Space · release checklist'],
  },
  {
    id: 'home',
    title: 'Finding our next home',
    summary: 'Keep the shortlist focused on places that work for your everyday life.',
    context: ['A short commute matters.', 'No viewings during launch week.'],
    sources: ['Research session · neighborhood shortlist'],
  },
  {
    id: 'japanese',
    title: 'Getting comfortable with Japanese',
    summary: 'Small, regular practice. No elaborate study plan to keep up with.',
    context: ['Ten minutes is enough.', 'Prioritize conversations over exam preparation.'],
    sources: [],
  },
];
