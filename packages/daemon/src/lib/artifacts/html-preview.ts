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
const MAX_NESTING = 512;
const UNNESTED = new Set(
  'area base br col embed hr img input link meta param source track wbr p li dt dd tr td th option optgroup thead tbody tfoot colgroup caption rp rt html head body'.split(
    ' '
  )
);

export interface ArtifactHtmlLink {
  readonly text: string;
  readonly href: string;
}

export interface PreparedArtifactHtml {
  readonly document: string;
  readonly links: readonly ArtifactHtmlLink[];
  readonly scriptsRemoved: boolean;
}

function stripComments(css: string): string | null {
  let out = '';
  let at = 0;
  for (;;) {
    const open = css.indexOf('/*', at);
    if (open < 0) return out + css.slice(at);
    const close = css.indexOf('*/', open + 2);
    if (close < 0) return null;
    out += css.slice(at, open);
    at = close + 2;
  }
}

function cleanCss(css: string): string {
  const source = stripComments(css);
  if (
    source === null ||
    /[\\<]|@import|expression\s*\(|javascript:|behavior\s*:|-moz-binding|image-set|@font-face/i.test(
      source
    )
  )
    return '';
  const opener = /url\(/gi;
  let out = '';
  let at = 0;
  for (let match = opener.exec(source); match; match = opener.exec(source)) {
    const close = source.indexOf(')', opener.lastIndex);
    if (close < 0) return '';
    const target = source
      .slice(opener.lastIndex, close)
      .trim()
      .replace(/^(['"])(.*)\1$/s, '$2');
    out += source.slice(at, match.index);
    out += RASTER.test(target) ? source.slice(match.index, close + 1) : 'none';
    at = opener.lastIndex = close + 1;
  }
  out += source.slice(at);
  return out.includes('://') ? '' : out;
}

function scripted(node: Node): boolean {
  const stack: Node[] = [node];
  for (let next = stack.pop(); next; next = stack.pop()) {
    if (next.type === 'element') {
      if (
        SCRIPTED.has(next.tagName.toLowerCase()) ||
        Object.entries(next.properties).some(
          ([name, value]) =>
            /^on/i.test(name) || (typeof value === 'string' && /^\s*javascript:/i.test(value))
        )
      )
        return true;
      if ('content' in next && next.content) stack.push(next.content);
    }
    if ('children' in next) for (const child of next.children) stack.push(child);
  }
  return false;
}

function textOf(node: Node): string {
  let text = '';
  const stack: Node[] = [node];
  for (let next = stack.pop(); next; next = stack.pop()) {
    if (next.type === 'text') text += next.value;
    else if ('children' in next)
      for (let index = next.children.length - 1; index >= 0; index--)
        stack.push(next.children[index]);
  }
  return text;
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

function find(root: Root, tag: string): Element | null {
  const html = root.children.find(
    (child): child is Element => child.type === 'element' && child.tagName === 'html'
  );
  if (tag === 'html' || !html) return html ?? null;
  return (
    html.children.find(
      (child): child is Element => child.type === 'element' && child.tagName === tag
    ) ?? null
  );
}

function nesting(html: string): number {
  const tag = /<(\/?)([a-z][a-z0-9-]*)/gi;
  let depth = 0;
  let deepest = 0;
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    if (UNNESTED.has(match[2].toLowerCase())) continue;
    depth = match[1] ? Math.max(0, depth - 1) : depth + 1;
    deepest = Math.max(deepest, depth);
  }
  return deepest;
}

export function prepareArtifactHtml(html: string): PreparedArtifactHtml | null {
  if (nesting(html) > MAX_NESTING) return null;
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
