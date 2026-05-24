import { useEffect, useRef, useState } from 'preact/hooks';

interface MarkdownRendererProps {
  content: string;
  class?: string;
}

// Lazy-loaded modules — cached after first import
let markedModule: typeof import('marked') | null = null;
let hljsModule: typeof import('highlight.js') | null = null;

async function getMarked() {
  if (!markedModule) {
    markedModule = await import('marked');
    markedModule.marked.setOptions({ breaks: true, gfm: true });
  }
  return markedModule.marked;
}

async function getHljs() {
  if (!hljsModule) {
    hljsModule = await import('highlight.js');
  }
  return hljsModule.default;
}

export default function MarkdownRenderer({ content, class: className }: MarkdownRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null>(null);

  // Parse markdown asynchronously
  useEffect(() => {
    let cancelled = false;
    getMarked().then((marked) => {
      if (!cancelled) {
        setHtml(marked.parse(content) as string);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [content]);

  // Apply syntax highlighting after HTML is set
  useEffect(() => {
    if (html == null || !containerRef.current) return;
    containerRef.current.innerHTML = html;

    // Apply syntax highlighting to code blocks
    const codeBlocks = containerRef.current.querySelectorAll('pre code');
    if (codeBlocks.length > 0) {
      getHljs().then((hljs) => {
        codeBlocks.forEach((block) => {
          hljs.highlightElement(block as HTMLElement);
        });
      });
    }

    // Wrap tables in scrollable container to prevent horizontal overflow
    const tables = containerRef.current.querySelectorAll('table');
    tables.forEach((table) => {
      if (!table.parentElement?.classList.contains('prose-table-wrapper')) {
        const wrapper = document.createElement('div');
        wrapper.className = 'prose-table-wrapper';
        table.parentNode?.insertBefore(wrapper, table);
        wrapper.appendChild(table);
      }
    });

    // Remove top margin from first paragraph and bottom margin from last paragraph
    const paragraphs = containerRef.current.querySelectorAll('p');
    if (paragraphs.length > 0) {
      const firstP = paragraphs[0] as HTMLElement;
      const lastP = paragraphs[paragraphs.length - 1] as HTMLElement;
      firstP.style.marginTop = '0';
      lastP.style.marginBottom = '0';
    }
  }, [html]);

  return <div ref={containerRef} class={`prose ${className || ''}`} />;
}
