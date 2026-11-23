import { escapeRawHtmlBlocks, hasCodeBlock, renderPlainText } from './markdown-escape.ts';
export { renderPlainText } from './markdown-escape.ts';
import { render } from 'preact';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { systemState } from '../../lib/state.ts';
import { ownerPathLabels } from '../../lib/owner-path-label.ts';
import { resolvedTheme } from '../../lib/theme.ts';
import { CopyButton } from '../ui/CopyButton.tsx';
import { MermaidFigureToolbar, getMermaidForTheme } from './MermaidViewer.tsx';
import { decideMarkdownImage, isAllowedMarkdownUrl } from './markdown-image.ts';
import { LruCache } from '../../lib/lru-cache.ts';
import { decideArtifactImage, decideArtifactLink } from '../../lib/artifact-link-policy.ts';
import { demoteLocalFileLinks, markPreviewReferences } from './markdown-references.ts';
import { attachQuoteCopyButtons } from './markdown-quote-copy.tsx';

interface MarkdownRendererProps {
  content: string;
  class?: string;
  artifactLinks?: boolean;
  demoteLinks?: boolean;
  pendingContent?: string;
  bare?: boolean;
  references?: readonly string[];
  onReference?: (reference: string) => void;
  referenceHome?: string | null;
}

function demoteAnchorLinks(container: HTMLElement) {
  container.querySelectorAll('a').forEach((anchor) => {
    const span = document.createElement('span');
    span.setAttribute('data-demoted-link', '');
    while (anchor.firstChild) span.appendChild(anchor.firstChild);
    anchor.replaceWith(span);
  });
}

type MarkdownModules = {
  unified: typeof import('unified').unified;
  remarkParse: typeof import('remark-parse').default;
  remarkGfm: typeof import('remark-gfm').default;
  remarkCjkFriendly: typeof import('remark-cjk-friendly/parseOnly').default;
  remarkBreaks: typeof import('remark-breaks').default;
  remarkMath: typeof import('remark-math').default;
  remarkRehype: typeof import('remark-rehype').default;
  rehypeStringify: typeof import('rehype-stringify').default;
};

type RehypeHighlight = typeof import('rehype-highlight').default;
type RehypeKatex = typeof import('rehype-katex').default;

const RENDERED_MARKDOWN_CACHE_LIMIT = 200;
const renderedMarkdownCache = new LruCache<string, string>(RENDERED_MARKDOWN_CACHE_LIMIT);
const renderedArtifactCache = new LruCache<string, string>(RENDERED_MARKDOWN_CACHE_LIMIT);
const markdownProcessors = new Map<string, Promise<MarkdownProcessor>>();

let markdownModulesPromise: Promise<MarkdownModules> | null = null;
let rehypeHighlightPromise: Promise<RehypeHighlight> | null = null;
let rehypeKatexPromise: Promise<RehypeKatex> | null = null;
let katexCssPromise: Promise<unknown> | null = null;

function getMarkdownModules() {
  if (!markdownModulesPromise) {
    markdownModulesPromise = Promise.all([
      import('unified'),
      import('remark-parse'),
      import('remark-gfm'),
      import('remark-cjk-friendly/parseOnly'),
      import('remark-breaks'),
      import('remark-math'),
      import('remark-rehype'),
      import('rehype-stringify'),
    ])
      .then(
        ([
          unifiedModule,
          remarkParseModule,
          remarkGfmModule,
          remarkCjkFriendlyModule,
          remarkBreaksModule,
          remarkMathModule,
          remarkRehypeModule,
          rehypeStringifyModule,
        ]) => ({
          unified: unifiedModule.unified,
          remarkParse: remarkParseModule.default,
          remarkGfm: remarkGfmModule.default,
          remarkCjkFriendly: remarkCjkFriendlyModule.default,
          remarkBreaks: remarkBreaksModule.default,
          remarkMath: remarkMathModule.default,
          remarkRehype: remarkRehypeModule.default,
          rehypeStringify: rehypeStringifyModule.default,
        })
      )
      .catch((error) => {
        markdownModulesPromise = null;
        throw error;
      });
  }

  return markdownModulesPromise;
}

function getRehypeHighlight() {
  if (!rehypeHighlightPromise) {
    rehypeHighlightPromise = import('rehype-highlight')
      .then((module) => module.default)
      .catch((error) => {
        rehypeHighlightPromise = null;
        throw error;
      });
  }

  return rehypeHighlightPromise;
}

function getRehypeKatex() {
  if (!rehypeKatexPromise) {
    rehypeKatexPromise = import('rehype-katex')
      .then((module) => module.default)
      .catch((error) => {
        rehypeKatexPromise = null;
        throw error;
      });
  }

  return rehypeKatexPromise;
}

function loadKatexCss() {
  if (!katexCssPromise) {
    katexCssPromise = import('katex/dist/katex.min.css').catch((error) => {
      katexCssPromise = null;
      throw error;
    });
  }

  return katexCssPromise;
}

function hasMath(content: string) {
  return /\$\$[\s\S]+?\$\$/.test(content);
}

const codeBlockCopyGutter = '2.5rem';
const mermaidToolbarGutter = '5.75rem';

async function renderMermaidBlocks(
  container: HTMLElement,
  mounts: Array<HTMLElement>,
  isCancelled?: () => boolean
) {
  const blocks = Array.from(container.querySelectorAll('pre code.language-mermaid'));
  if (blocks.length === 0) return;

  const mermaid = await getMermaidForTheme(resolvedTheme.value === 'dark' ? 'dark' : 'default');
  if (isCancelled?.()) return;

  await Promise.all(
    blocks.map(async (block) => {
      if (isCancelled?.()) return;
      const pre = block.parentElement;
      if (!pre) return;

      const source = block.textContent || '';
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid';
      wrapper.style.paddingRight = mermaidToolbarGutter;
      wrapper.textContent = source;

      try {
        await mermaid.parse(source);
      } catch {
        return;
      }

      if (!pre.isConnected || isCancelled?.()) return;
      pre.replaceWith(wrapper);

      try {
        if (!wrapper.isConnected || isCancelled?.()) {
          if (wrapper.isConnected) wrapper.replaceWith(pre);
          return;
        }
        await mermaid.run({ nodes: [wrapper] });
      } catch (error) {
        if (wrapper.isConnected) {
          wrapper.replaceWith(pre);
        }
        throw error;
      }

      if (!isCancelled?.() && wrapper.parentElement) {
        const mount = document.createElement('div');
        mount.className = 'mermaid-toolbar-mount absolute top-2 right-12';
        wrapper.parentElement.appendChild(mount);
        render(<MermaidFigureToolbar source={source} />, mount);
        mounts.push(mount);
      }
    })
  );
}

function attachCodeBlockCopyButtons(container: HTMLElement) {
  const mounts: Array<HTMLElement> = [];
  container.querySelectorAll('pre').forEach((pre) => {
    const code = pre.querySelector('code');
    pre.style.paddingRight = codeBlockCopyGutter;
    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper relative';
    pre.parentNode?.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);
    const mount = document.createElement('div');
    mount.className = 'absolute top-2 right-2';
    wrapper.appendChild(mount);
    render(<CopyButton text={code?.textContent || ''} label="Copy code" />, mount);
    mounts.push(mount);
  });
  return mounts;
}

type MarkdownImageNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: MarkdownImageNode[];
  value?: string;
};

function transformMarkdownUrlNodes(node: MarkdownImageNode, insideAnchor = false) {
  const { children } = node;
  if (!children) return;

  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child.type === 'element' && child.tagName === 'img') {
      if (!child.properties) child.properties = {};
      const properties = child.properties;
      const admission = decideMarkdownImage({
        src: typeof properties.src === 'string' ? properties.src : '',
        alt: typeof properties.alt === 'string' ? properties.alt : '',
        title: typeof properties.title === 'string' ? properties.title : '',
      });
      if (admission.kind === 'downgrade') {
        children[index] = { type: 'text', value: admission.text };
        continue;
      }
      properties.loading = 'lazy';
      properties.referrerpolicy = 'no-referrer';
      if (!insideAnchor) {
        children[index] = {
          type: 'element',
          tagName: 'a',
          properties: {
            className: ['markdown-image-link'],
            href: admission.src,
            target: '_blank',
            rel: 'noopener noreferrer',
            ariaLabel: admission.alt || 'Open image',
          },
          children: [child],
        };
      }
      continue;
    }
    if (child.type === 'element' && child.tagName === 'a') {
      const href = child.properties?.href;
      if (typeof href === 'string' && !isAllowedMarkdownUrl(href, 'link')) {
        child.tagName = 'span';
        child.properties = {};
      }
    }
    transformMarkdownUrlNodes(child, insideAnchor || child.tagName === 'a');
  }
}

function rehypeMarkdownUrls() {
  return (tree: MarkdownImageNode) => {
    transformMarkdownUrlNodes(tree);
  };
}

function transformArtifactNodes(node: MarkdownImageNode) {
  node.children?.forEach((child, index, children) => {
    const properties = child.properties ?? {};
    if (child.type === 'element' && child.tagName === 'img') {
      const src = typeof properties.src === 'string' ? properties.src : '';
      if (decideArtifactImage(src).kind === 'refused')
        children[index] = { type: 'text', value: `[image: ${properties.alt ?? ''}]` };
      return;
    }
    if (child.type === 'element' && child.tagName === 'a') {
      const link = decideArtifactLink(typeof properties.href === 'string' ? properties.href : '');
      if (link.kind === 'external') {
        delete properties.href;
        properties.dataExternalHref = link.url;
        properties.role = 'link';
        properties.tabIndex = 0;
      }
      if (link.kind === 'refused')
        children[index] = {
          type: 'element',
          tagName: 'span',
          properties: { dataRefusedLink: '', title: 'This link is not available in the preview' },
          children: child.children,
        };
    }
    transformArtifactNodes(children[index]);
  });
}

function rehypeArtifactLinks() {
  return (tree: MarkdownImageNode) => {
    transformArtifactNodes(tree);
  };
}

type MarkdownProcessor = Awaited<ReturnType<typeof buildMarkdownProcessor>>;

async function buildMarkdownProcessor(
  shouldRenderMath: boolean,
  shouldHighlightCode: boolean,
  artifactLinks: boolean
) {
  const modules = await getMarkdownModules();
  const rehypeKatex = shouldRenderMath ? await getRehypeKatex() : null;
  const rehypeHighlight = shouldHighlightCode ? await getRehypeHighlight() : null;

  const processor = modules
    .unified()
    .use(modules.remarkParse)
    .use(modules.remarkGfm)
    .use(modules.remarkCjkFriendly)
    .use(modules.remarkMath, { singleDollarTextMath: false })
    .use(modules.remarkBreaks)
    .use(modules.remarkRehype)
    .use(artifactLinks ? rehypeArtifactLinks : rehypeMarkdownUrls);

  if (rehypeKatex) {
    processor.use(rehypeKatex);
  }

  if (rehypeHighlight) {
    processor.use(rehypeHighlight, { detect: true, ignoreMissing: true, plainText: ['mermaid'] });
  }

  return processor.use(modules.rehypeStringify).freeze();
}

function getMarkdownProcessor(
  shouldRenderMath: boolean,
  shouldHighlightCode: boolean,
  artifactLinks: boolean
) {
  const key = `${shouldRenderMath}:${shouldHighlightCode}:${artifactLinks}`;
  let processor = markdownProcessors.get(key);
  if (!processor) {
    processor = buildMarkdownProcessor(shouldRenderMath, shouldHighlightCode, artifactLinks);
    processor.catch(() => markdownProcessors.delete(key));
    markdownProcessors.set(key, processor);
  }
  return processor;
}

export const clearArtifactRenderCache = () => renderedArtifactCache.clear();

const renderCache = (artifactLinks: boolean) =>
  artifactLinks ? renderedArtifactCache : renderedMarkdownCache;

async function renderMarkdown(content: string, artifactLinks: boolean) {
  const cache = renderCache(artifactLinks);
  const cached = cache.get(content);
  if (cached !== undefined) return cached;

  const escapedContent = escapeRawHtmlBlocks(content);
  const shouldRenderMath = hasMath(content);
  const shouldHighlightCode = hasCodeBlock(escapedContent);

  if (shouldRenderMath) {
    loadKatexCss().catch(() => undefined);
  }

  const processor = await getMarkdownProcessor(
    shouldRenderMath,
    shouldHighlightCode,
    artifactLinks
  );
  const file = await processor.process(escapedContent);
  const htmlStr = String(file).replace(/(^|>[^<]*)-->([^<]*<|$)/g, '$1--&gt;$2');
  cache.set(content, htmlStr);
  return htmlStr;
}

export default function MarkdownRenderer({
  content,
  class: className,
  artifactLinks = false,
  demoteLinks = false,
  pendingContent,
  bare = false,
  references,
  onReference,
  referenceHome,
}: MarkdownRendererProps) {
  const home = referenceHome === undefined ? systemState.value?.homeDirectory : referenceHome;
  const labels = useMemo(() => ownerPathLabels(content, home), [content, home]);
  const containerRef = useRef<HTMLDivElement>(null);
  const referenceHandler = useRef(onReference);
  referenceHandler.current = onReference;
  const referenceKey = JSON.stringify(references ?? []);
  const [html, setHtml] = useState<string | null>(
    () => renderCache(artifactLinks).get(content) ?? null
  );
  const theme = resolvedTheme.value;

  useEffect(() => {
    const cached = renderCache(artifactLinks).get(content);
    if (cached !== undefined) {
      setHtml(cached);
      return;
    }
    let cancelled = false;
    const rafId = requestAnimationFrame(() => {
      renderMarkdown(content, artifactLinks)
        .then((renderedHtml) => {
          if (!cancelled) {
            setHtml(renderedHtml);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setHtml(renderPlainText(content));
          }
        });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
    };
  }, [content, artifactLinks, theme]);

  useLayoutEffect(() => {
    if (html == null || !containerRef.current) return;
    const container = containerRef.current;
    container.innerHTML = html;
    if (demoteLinks) demoteAnchorLinks(container);

    if (references) demoteLocalFileLinks(container);
    markPreviewReferences(container, JSON.parse(referenceKey), labels);
    const handleReference = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Enter') return;
      const target = event.target instanceof Element ? event.target : null;
      const reference = target
        ?.closest('[data-preview-reference]')
        ?.getAttribute('data-preview-reference');
      if (!reference || !referenceHandler.current) return;
      event.preventDefault();
      referenceHandler.current(reference);
    };
    container.addEventListener('click', handleReference);
    container.addEventListener('keydown', handleReference);

    const copyMounts = bare
      ? []
      : [
          ...attachQuoteCopyButtons(container, codeBlockCopyGutter),
          ...attachCodeBlockCopyButtons(container),
        ];

    let mermaidCancelled = false;
    const mermaidMounts: Array<HTMLElement> = [];
    if (!artifactLinks && !bare)
      renderMermaidBlocks(containerRef.current, mermaidMounts, () => mermaidCancelled).catch(
        () => undefined
      );

    const tables = containerRef.current.querySelectorAll('table');
    tables.forEach((table) => {
      if (!table.parentElement?.classList.contains('prose-table-wrapper')) {
        const wrapper = document.createElement('div');
        wrapper.className = 'prose-table-wrapper';
        table.parentNode?.insertBefore(wrapper, table);
        wrapper.appendChild(table);
      }
    });

    const paragraphs = containerRef.current.querySelectorAll('p');
    if (paragraphs.length > 0) {
      const firstP = paragraphs[0] as HTMLElement;
      const lastP = paragraphs[paragraphs.length - 1] as HTMLElement;
      firstP.style.marginTop = '0';
      lastP.style.marginBottom = '0';
    }

    return () => {
      container.removeEventListener('click', handleReference);
      container.removeEventListener('keydown', handleReference);
      copyMounts.forEach((mount) => {
        render(null, mount);
      });
      mermaidMounts.forEach((mount) => {
        render(null, mount);
      });
      mermaidCancelled = true;
    };
  }, [html, theme, artifactLinks, demoteLinks, bare, referenceKey, labels]);

  return (
    <div ref={containerRef} class={`prose ${className || ''}`}>
      {html == null ? pendingContent : null}
    </div>
  );
}
