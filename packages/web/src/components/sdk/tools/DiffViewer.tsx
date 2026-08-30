import { cn } from '../../../lib/utils.ts';

export interface DiffViewerProps {
  oldText: string;
  newText: string;
  filePath?: string;
  mode?: 'unified' | 'split';
  className?: string;
}

interface DiffLine {
  type: 'add' | 'remove' | 'context' | 'separator';
  oldLineNum?: number;
  newLineNum?: number;
  content: string;
}

function generateDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const diff: DiffLine[] = [];

  let firstDiffIndex = 0;
  while (
    firstDiffIndex < Math.min(oldLines.length, newLines.length) &&
    oldLines[firstDiffIndex] === newLines[firstDiffIndex]
  ) {
    firstDiffIndex++;
  }

  let lastDiffIndexOld = oldLines.length - 1;
  let lastDiffIndexNew = newLines.length - 1;
  while (
    lastDiffIndexOld > firstDiffIndex &&
    lastDiffIndexNew > firstDiffIndex &&
    oldLines[lastDiffIndexOld] === newLines[lastDiffIndexNew]
  ) {
    lastDiffIndexOld--;
    lastDiffIndexNew--;
  }

  const contextBefore = Math.max(0, firstDiffIndex - 3);
  for (let i = contextBefore; i < firstDiffIndex; i++) {
    diff.push({
      type: 'context',
      oldLineNum: i + 1,
      newLineNum: i + 1,
      content: oldLines[i],
    });
  }

  if (contextBefore > 0) {
    diff.push({
      type: 'separator',
      content: '...',
    });
  }

  for (let i = firstDiffIndex; i <= lastDiffIndexOld; i++) {
    diff.push({
      type: 'remove',
      oldLineNum: i + 1,
      content: oldLines[i],
    });
  }

  for (let i = firstDiffIndex; i <= lastDiffIndexNew; i++) {
    diff.push({
      type: 'add',
      newLineNum: i + 1,
      content: newLines[i],
    });
  }

  const contextAfter = Math.min(oldLines.length, lastDiffIndexOld + 4);
  for (let i = lastDiffIndexOld + 1; i < contextAfter; i++) {
    if (i < oldLines.length) {
      diff.push({
        type: 'context',
        oldLineNum: i + 1,
        newLineNum: i - lastDiffIndexOld + lastDiffIndexNew + 1,
        content: oldLines[i],
      });
    }
  }

  if (contextAfter < oldLines.length) {
    diff.push({
      type: 'separator',
      content: '...',
    });
  }

  return diff;
}

export function DiffViewer({
  oldText,
  newText,
  filePath,
  mode: _mode = 'unified',
  className,
}: DiffViewerProps) {
  const diff = generateDiff(oldText, newText);
  const addedLines = diff.filter((l) => l.type === 'add').length;
  const removedLines = diff.filter((l) => l.type === 'remove').length;

  return (
    <div class={cn('rounded-lg overflow-hidden border border-line', className)}>
      {filePath && (
        <div class="bg-surface-raised px-3 py-2 border-b border-line flex items-center justify-between">
          <div class="text-xs font-mono text-fg-soft">{filePath}</div>
          <div class="text-xs font-mono flex items-center gap-1">
            <span class="text-success">+{addedLines}</span>
            <span class="text-danger">-{removedLines}</span>
          </div>
        </div>
      )}

      <div class="bg-surface overflow-x-auto">
        <table class="w-full text-xs font-mono">
          <tbody>
            {diff.map((line, idx) => {
              if (line.type === 'separator') {
                return (
                  <tr key={idx} class="bg-surface-raised">
                    <td class="px-2 py-1 text-center text-fg-muted select-none" colSpan={3}>
                      {line.content}
                    </td>
                  </tr>
                );
              }

              const bgClass =
                line.type === 'add'
                  ? 'bg-success/10'
                  : line.type === 'remove'
                    ? 'bg-danger/10'
                    : 'bg-surface';

              const textClass =
                line.type === 'add'
                  ? 'text-success-soft'
                  : line.type === 'remove'
                    ? 'text-danger-soft'
                    : 'text-fg-soft';

              const signClass =
                line.type === 'add'
                  ? 'text-success'
                  : line.type === 'remove'
                    ? 'text-danger'
                    : 'text-fg-faint';

              const sign = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
              const lineNum = line.type === 'add' ? line.newLineNum : line.oldLineNum;

              return (
                <tr key={idx} class={bgClass}>
                  <td class="px-2 py-0.5 text-right text-fg-faint select-none w-12 border-r border-line">
                    {lineNum}
                  </td>
                  <td class={cn('px-2 py-0.5 w-6 select-none', signClass)}>{sign}</td>
                  <td class={cn('px-2 py-0.5 whitespace-pre', textClass)}>{line.content || ' '}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div class="bg-surface-raised px-3 py-1.5 border-t border-line flex gap-4 text-xs">
        <div class="flex items-center gap-1">
          <span class="text-success">+</span>
          <span class="text-fg-soft">{diff.filter((l) => l.type === 'add').length} additions</span>
        </div>
        <div class="flex items-center gap-1">
          <span class="text-danger">-</span>
          <span class="text-fg-soft">
            {diff.filter((l) => l.type === 'remove').length} deletions
          </span>
        </div>
      </div>
    </div>
  );
}
