import { useEffect, useState } from 'preact/hooks';
import type MarkdownRendererComponent from '../components/chat/MarkdownRenderer.tsx';

type Renderer = typeof MarkdownRendererComponent;

let rendererPromise: Promise<Renderer> | null = null;

function loadMarkdownRenderer(): Promise<Renderer> {
  if (!rendererPromise) {
    rendererPromise = import('../components/chat/MarkdownRenderer.tsx')
      .then((module) => module.default)
      .catch((error) => {
        rendererPromise = null;
        throw error;
      });
  }
  return rendererPromise;
}

export function NeoQuoteExcerpt({
  excerpt,
  demoteLinks,
}: {
  excerpt: string;
  demoteLinks: boolean;
}) {
  const [Renderer, setRenderer] = useState<Renderer | null>(null);
  useEffect(() => {
    let live = true;
    loadMarkdownRenderer()
      .then((loaded) => {
        if (live) setRenderer(() => loaded);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!Renderer) {
    return <span class="line-clamp-2 block break-words text-sm text-fg">{excerpt}</span>;
  }
  return (
    <Renderer
      content={excerpt}
      demoteLinks={demoteLinks}
      pendingContent={excerpt}
      bare
      class="neo-quote-excerpt line-clamp-2 block break-words text-sm text-fg"
    />
  );
}
