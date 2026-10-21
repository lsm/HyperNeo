import { fromHtml } from 'hast-util-from-html';
import { toHtml } from 'hast-util-to-html';

type Root = ReturnType<typeof fromHtml>;
type Child = Root['children'][number];
type Element = Extract<Child, { type: 'element' }>;
type Content = Element['children'][number];
type Node = Root | Child;

export const ARTIFACT_HTML_CSP =
  "default-src 'none'; script-src 'none'; connect-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";

const KEPT = new Set(
  'html head body title style div span p h1 h2 h3 h4 h5 h6 ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col pre code blockquote em strong b i u s small sub sup mark br hr img figure figcaption section article header footer main nav aside details summary abbr time kbd samp var q cite del ins'.split(
    ' '
  )
);
const DROPPED = new Set(
  'script noscript template iframe frame frameset object embed applet svg math base link meta input button select textarea option optgroup datalist output audio video source track canvas portal param map area'.split(
    ' '
  )
);
const SCRIPTED = new Set(['script', 'noscript']);
const GLOBAL_PROPERTIES = new Set(['className', 'id', 'title', 'lang', 'dir', 'style']);
const PROPERTIES: Record<string, readonly string[]> = {
  img: ['alt', 'src', 'width', 'height'],
  td: ['colSpan', 'rowSpan'],
  th: ['colSpan', 'rowSpan', 'scope'],
  col: ['span'],
  colgroup: ['span'],
  ol: ['start', 'reversed'],
  details: ['open'],
  time: ['dateTime'],
};
const RASTER = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\s]*$/i;
const LINK_LIMIT = 200;
const CSS_URL = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

export interface ArtifactHtmlLink {
  readonly text: string;
  readonly href: string;
}

export interface PreparedArtifactHtml {
  readonly document: string;
  readonly links: readonly ArtifactHtmlLink[];
  readonly scriptsRemoved: boolean;
}

function cleanCss(css: string): string {
  const source = css.replace(/\/\*[\s\S]*?\*\//g, '');
  if (
    /[\\<]|\/\*|expression\s*\(|javascript:|behavior\s*:|-moz-binding|image-set|@font-face/i.test(
      source
    )
  )
    return '';
  const cleaned = source
    .replace(/@import[^;]*(?:;|$)/gi, '')
    .replace(CSS_URL, (match, _quote, target: string) =>
      RASTER.test(target.trim()) ? match : 'none'
    );
  return /url\s*\(|@import|:\/\//i.test(cleaned.replace(CSS_URL, '')) ? '' : cleaned;
}

function scripted(node: Node): boolean {
  if (node.type === 'element') {
    if (
      SCRIPTED.has(node.tagName.toLowerCase()) ||
      Object.entries(node.properties).some(
        ([name, value]) =>
          /^on/i.test(name) || (typeof value === 'string' && /^\s*javascript:/i.test(value))
      ) ||
      ('content' in node && node.content && scripted(node.content))
    )
      return true;
  }
  return 'children' in node && node.children.some(scripted);
}

function textOf(node: Node): string {
  if (node.type === 'text') return node.value;
  return 'children' in node ? node.children.map(textOf).join('') : '';
}

function linkTarget(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  try {
    const url = new URL(href.trim());
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function cleanChildren(
  children: readonly Child[],
  links: ArtifactHtmlLink[],
  removed: { scripts: boolean }
): Content[] {
  return children.flatMap((child): Content[] => {
    if (child.type === 'text') return [child];
    if (child.type !== 'element') return [];
    return cleanElement(child, links, removed);
  });
}

function cleanElement(
  element: Element,
  links: ArtifactHtmlLink[],
  removed: { scripts: boolean }
): Content[] {
  const tag = element.tagName.toLowerCase();
  if (Object.keys(element.properties).some((name) => /^on/i.test(name))) removed.scripts = true;
  if (DROPPED.has(tag)) {
    if (scripted(element)) removed.scripts = true;
    return [];
  }
  if (tag === 'a') {
    const href = element.properties.href;
    if (typeof href === 'string' && /^\s*javascript:/i.test(href)) removed.scripts = true;
    const target = linkTarget(href);
    if (target && links.length < LINK_LIMIT)
      links.push({ text: textOf(element).trim().slice(0, LINK_LIMIT), href: target });
  }
  const children = cleanChildren(
    'content' in element && element.content ? element.content.children : element.children,
    links,
    removed
  );
  if (!KEPT.has(tag)) return children;
  if (tag === 'img' && !RASTER.test(String(element.properties.src ?? '').trim())) return [];
  const allowed = new Set([...GLOBAL_PROPERTIES, ...(PROPERTIES[tag] ?? [])]);
  const properties = Object.fromEntries(
    Object.entries(element.properties).filter(([name]) => allowed.has(name))
  );
  if (typeof properties.style === 'string') {
    properties.style = cleanCss(properties.style);
    if (!properties.style) delete properties.style;
  }
  if (tag === 'style') {
    const css = cleanCss(textOf(element));
    return css ? [{ ...element, properties: {}, children: [{ type: 'text', value: css }] }] : [];
  }
  return [{ ...element, tagName: tag, properties, children }];
}

function find(root: Node, tag: string): Element | null {
  if (root.type === 'element' && root.tagName === tag) return root;
  if (!('children' in root)) return null;
  for (const child of root.children) {
    const found = find(child, tag);
    if (found) return found;
  }
  return null;
}

export function prepareArtifactHtml(html: string): PreparedArtifactHtml {
  const tree = fromHtml(html);
  const links: ArtifactHtmlLink[] = [];
  const removed = {
    scripts: ['html', 'head', 'body'].some((tag) =>
      Object.keys(find(tree, tag)?.properties ?? {}).some((name) => /^on/i.test(name))
    ),
  };
  const head = cleanChildren(find(tree, 'head')?.children ?? [], links, removed).filter(
    (child) => child.type === 'element' && (child.tagName === 'title' || child.tagName === 'style')
  );
  const body = cleanChildren(find(tree, 'body')?.children ?? [], links, removed);
  const element = (tagName: string, properties: Element['properties'], children: Content[]) =>
    ({ type: 'element', tagName, properties, children }) as Element;
  const document: Root = {
    type: 'root',
    children: [
      { type: 'doctype' },
      element('html', {}, [
        element('head', {}, [
          element('meta', { charSet: 'utf-8' }, []),
          element('meta', { httpEquiv: 'Content-Security-Policy', content: ARTIFACT_HTML_CSP }, []),
          ...head,
        ]),
        element('body', {}, body),
      ]),
    ],
  };
  return { document: toHtml(document), links, scriptsRemoved: removed.scripts };
}
