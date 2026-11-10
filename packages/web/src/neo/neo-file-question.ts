import superpipe, { type PipelineAPI } from 'superpipe';

export const neoFileQuestionText = (superpipe({})('neo-file-question-text') as PipelineAPI)
  .input(['text', 'path'])
  .pipe(
    (path: string) => {
      const ticks = '`'.repeat(Math.max(0, ...(path.match(/`+/g) ?? []).map((s) => s.length)) + 1);
      const body = /^[ `]|[ `]$/.test(path) ? ` ${path} ` : path;
      return `${ticks}${body}${ticks}`;
    },
    'path',
    'reference'
  )
  .pipe(
    (text: string, reference: string) =>
      text.includes(reference) ? text : [text, reference].filter(Boolean).join('\n\n'),
    ['text', 'reference'],
    'text'
  )
  .end('text') as (text: string, path: string) => string;
