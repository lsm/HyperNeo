import { useEffect, useRef } from 'preact/hooks';
import { cn } from '../../../lib/utils.ts';

let hljsModule: typeof import('highlight.js') | null = null;

async function getHljs() {
  if (!hljsModule) {
    hljsModule = await import('highlight.js');
  }
  return hljsModule.default;
}

export interface CodeViewerProps {
  code: string;
  language?: string;
  filePath?: string;
  showLineNumbers?: boolean;
  maxHeight?: string;
  className?: string;
  showHeader?: boolean;
}

function detectLanguageFromPath(filePath: string): string | undefined {
  const ext = filePath.split('.').pop()?.toLowerCase();

  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    py: 'python',
    rb: 'ruby',
    go: 'go',
    rs: 'rust',
    java: 'java',
    c: 'c',
    cpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    swift: 'swift',
    kt: 'kotlin',
    sql: 'sql',
    sh: 'bash',
    bash: 'bash',
    zsh: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    json: 'json',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    md: 'markdown',
    txt: 'plaintext',
  };

  return ext ? languageMap[ext] : undefined;
}

export function CodeViewer({
  code,
  language,
  filePath,
  showLineNumbers = true,
  maxHeight = '500px',
  className,
  showHeader = true,
}: CodeViewerProps) {
  const codeRef = useRef<HTMLElement>(null);
  const detectedLanguage = language || (filePath ? detectLanguageFromPath(filePath) : undefined);

  useEffect(() => {
    if (!codeRef.current) return;
    const el = codeRef.current;
    let cancelled = false;

    getHljs().then((hljs) => {
      if (cancelled || !el) return;

      el.removeAttribute('data-highlighted');

      let highlightedCode: string;
      if (detectedLanguage) {
        try {
          const highlighted = hljs.highlight(code, {
            language: detectedLanguage,
          });
          highlightedCode = highlighted.value;
        } catch {
          const highlighted = hljs.highlightAuto(code);
          highlightedCode = highlighted.value;
        }
      } else {
        const highlighted = hljs.highlightAuto(code);
        highlightedCode = highlighted.value;
      }

      if (showLineNumbers) {
        const lines = highlightedCode.split('\n');
        const wrappedLines = lines
          .map((line) => {
            return `<div class="code-line"><span class="code-line-content">${line || ' '}</span></div>`;
          })
          .join('');
        el.innerHTML = `<div class="code-with-lines">${wrappedLines}</div>`;
      } else {
        el.innerHTML = highlightedCode;
      }
    });

    return () => {
      cancelled = true;
    };
  }, [code, detectedLanguage, showLineNumbers]);

  const lines = code.split('\n');
  const lineCount = lines.length;

  return (
    <div class={cn('rounded-lg overflow-hidden border border-line', className)}>
      {showHeader && filePath && (
        <div class="bg-surface-raised px-3 py-2 border-b border-line flex items-center justify-between">
          <div class="text-xs font-mono text-fg-soft">{filePath}</div>
          <div class="flex items-center gap-2">
            <div class="text-xs text-fg-muted font-mono">{lineCount}</div>
            {detectedLanguage && (
              <div class="text-xs px-2 py-0.5 rounded bg-fill-strong text-fg-muted">
                {detectedLanguage}
              </div>
            )}
          </div>
        </div>
      )}

      <div class="relative bg-surface" style={{ maxHeight }}>
        <pre class="!m-0 !p-0 overflow-auto">
          <code ref={codeRef} class="block text-xs font-mono" style={{ whiteSpace: 'pre' }} />
        </pre>
      </div>

      {showLineNumbers && (
        <div class="bg-surface-raised px-3 py-1.5 border-t border-line text-xs text-fg-muted">
          {lineCount} {lineCount === 1 ? 'line' : 'lines'}
        </div>
      )}
    </div>
  );
}
