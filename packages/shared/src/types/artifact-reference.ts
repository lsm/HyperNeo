import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { PREVIEWABLE_FILE_EXTENSIONS } from './artifact-file.ts';

export type PreviewReferenceCandidate =
  | { kind: 'local'; reference: string; path: string }
  | { kind: 'git-blob'; reference: string; repository: string; sha: string; path: string }
  | { kind: 'github-pr'; reference: string; repository: string; number: number };

interface Node {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  children?: Node[];
  position?: { start?: { offset?: number }; end?: { offset?: number } };
}

const markdown = unified().use(remarkParse).use(remarkGfm);
const documentPath = /\.(?:md|markdown|html?|png|jpe?g|webp|gif|svg|json|jsonl|log|txt|csv)$/i;

function candidate(reference: string, explicit: boolean): PreviewReferenceCandidate | null {
  if (!reference || /[\u0000-\u001f\u007f\\]/.test(reference)) return null;
  if (/(?:^|\/)\.{1,2}(?:\/|$)/.test(reference) && reference.includes('://')) return null;
  if (/^https:\/\//i.test(reference)) {
    const url = new URL(reference);
    if (url.username || url.password || url.port || url.search || url.hash) return null;
    const match = /^\/([\w.-]+)\/([\w.-]+)\/(?:pull\/([1-9]\d*)|blob\/([a-f0-9]{40})\/(.+))$/.exec(
      url.pathname
    );
    if (!match) return null;
    const repository = `${url.hostname}/${match[1]}/${match[2]}`.toLowerCase();
    if (match[3])
      return Number.isSafeInteger(Number(match[3]))
        ? { kind: 'github-pr', reference, repository, number: Number(match[3]) }
        : null;
    return { kind: 'git-blob', reference, repository, sha: match[4], path: match[5] };
  }
  let path = reference;
  if (reference.startsWith('file:')) {
    const url = new URL(reference);
    if (url.host || url.search || url.hash || /%(?!20)/i.test(url.pathname)) return null;
    path = url.pathname.replace(/%20/gi, ' ');
  } else if (reference.includes(':') || /[?#]/.test(reference)) return null;
  return (documentPath.test(path) ||
    ((explicit || path.startsWith('/') || path.startsWith('~/')) && /\.[\w-]+$/.test(path))) &&
    !/[;$|&<>`]/.test(path) &&
    (explicit || !/\s/.test(path))
    ? { kind: 'local', reference, path }
    : null;
}

const pathStops = new Set([...',;:\'"!?()[]{}<>`|，。；：、！？（）【】《》「」“”']);

function plainPaths(token: string): string[] {
  const paths: string[] = [];
  for (let i = 0; i < token.length; ) {
    const previous = token[i - 1] ?? '';
    const start =
      (token[i] === '/' && token[i + 1] !== '/') || (token[i] === '~' && token[i + 1] === '/');
    if (
      !start ||
      /[A-Za-z0-9_.\/~-]/.test(previous) ||
      (previous === ':' && /[A-Za-z0-9]/.test(token[i - 2] ?? ''))
    ) {
      i++;
      continue;
    }
    let end = i;
    while (end < token.length && !pathStops.has(token[end])) end++;
    const span = token.slice(i, end);
    const match = /^(.*\.[A-Za-z0-9_-]+)/.exec(span);
    if (match && !span.endsWith('/')) paths.push(match[1]);
    i = Math.max(end, i + 1);
  }
  return paths;
}

export function previewReferenceCandidates(text: string): PreviewReferenceCandidate[] {
  if (text.length > 2 * 1024 * 1024) return [];
  const tree: Node = markdown.parse(text);
  const definitions = new Map<string, string>();
  const result = new Map<string, PreviewReferenceCandidate>();
  function collect(node: Node) {
    if (node.type === 'definition' && node.identifier && node.url)
      definitions.set(node.identifier, node.url);
    for (const child of node.children ?? []) collect(child);
  }
  function add(reference: string, explicit: boolean) {
    try {
      const parsed = candidate(reference, explicit);
      if (parsed) result.set(reference, parsed);
    } catch {}
  }
  function walk(node: Node) {
    if (['code', 'html', 'image', 'imageReference', 'definition'].includes(node.type)) return;
    if (node.type === 'link' && node.url) {
      add(node.url, true);
      return;
    }
    if (node.type === 'linkReference') {
      const url = definitions.get(node.identifier ?? '');
      if (url) add(url, true);
      return;
    }
    if (node.type === 'inlineCode') {
      add(node.value ?? '', true);
      return;
    }
    if (node.type === 'text') {
      for (const token of (node.value ?? '').split(/\s+/)) {
        const path = token.replace(/^[('"“]+|[),.!?;:'"”]+$/g, '');
        if (!path.startsWith('/') && !path.startsWith('~/')) add(path, false);
        for (const reference of plainPaths(token)) add(reference, false);
      }
    }
    for (const child of node.children ?? []) walk(child);
  }
  collect(tree);
  walk(tree);
  return result.size <= 256 ? [...result.values()] : [];
}

export function previewLinkedReferenceCandidates(text: string): PreviewReferenceCandidate[] {
  return previewReferenceCandidates(text).filter(
    (item) =>
      item.kind !== 'local' ||
      ((item.path.startsWith('/') || item.path.startsWith('~/')) &&
        (!item.reference.startsWith('file:') || item.reference.startsWith('file:/')) &&
        PREVIEWABLE_FILE_EXTENSIONS.has(item.path.split('.').at(-1)?.toLowerCase() ?? ''))
  );
}

export function previewLinkedReferenceSpans(
  text: string
): { start: number; end: number; reference: string }[] {
  const references = previewLinkedReferenceCandidates(text)
    .filter((item) => item.kind === 'local')
    .map((item) => item.reference)
    .sort((a, b) => b.length - a.length);
  if (!references.length) return [];
  const escaped = references.map((ref) => ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_./~-])(?<![A-Za-z0-9]:)(${escaped.join('|')})(?![A-Za-z0-9_/-]|[.~]+[A-Za-z0-9_/-])`,
    'g'
  );
  const spans: { start: number; end: number; reference: string }[] = [];
  function walk(node: Node) {
    if (
      ['code', 'html', 'image', 'imageReference', 'linkReference', 'definition'].includes(node.type)
    )
      return;
    if (node.type === 'link' && (!node.url || !references.includes(node.url))) return;
    if (['text', 'inlineCode', 'link'].includes(node.type)) {
      const start = node.position?.start?.offset;
      const end = node.position?.end?.offset;
      if (start !== undefined && end !== undefined) {
        for (const match of text.slice(start, end).matchAll(pattern)) {
          const offset = start + match.index;
          spans.push({ start: offset, end: offset + match[0].length, reference: match[0] });
        }
      }
      return;
    }
    for (const child of node.children ?? []) walk(child);
  }
  walk(markdown.parse(text));
  return spans;
}
