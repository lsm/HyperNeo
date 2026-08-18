import { useEffect, useRef, useState } from 'preact/hooks';

interface MarkdownRendererProps {
  content: string;
  class?: string;
}

type MarkdownModules = {
  unified: typeof import('unified').unified;
  remarkParse: typeof import('remark-parse').default;
  remarkGfm: typeof import('remark-gfm').default;
  remarkBreaks: typeof import('remark-breaks').default;
  remarkMath: typeof import('remark-math').default;
  remarkRehype: typeof import('remark-rehype').default;
  rehypeStringify: typeof import('rehype-stringify').default;
};

type RehypeHighlight = typeof import('rehype-highlight').default;
type RehypeKatex = typeof import('rehype-katex').default;

let markdownModulesPromise: Promise<MarkdownModules> | null = null;
let rehypeHighlightPromise: Promise<RehypeHighlight> | null = null;
let rehypeKatexPromise: Promise<RehypeKatex> | null = null;
let katexCssPromise: Promise<unknown> | null = null;
let mermaidModulePromise: Promise<typeof import('mermaid').default> | null = null;

function getMarkdownModules() {
  if (!markdownModulesPromise) {
    markdownModulesPromise = Promise.all([
      import('unified'),
      import('remark-parse'),
      import('remark-gfm'),
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
          remarkBreaksModule,
          remarkMathModule,
          remarkRehypeModule,
          rehypeStringifyModule,
        ]) => ({
          unified: unifiedModule.unified,
          remarkParse: remarkParseModule.default,
          remarkGfm: remarkGfmModule.default,
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

function escapeHtml(content: string) {
  return content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderPlainText(content: string) {
  return `<p>${escapeHtml(content).replace(/\n/g, '<br>')}</p>`;
}

type FenceState = {
  char: '`' | '~';
  length: number;
  prefix: string;
  closePrefix: string;
};

type InlineHtmlEscapeResult = {
  line: string;
  codeDelimiter: string | null;
  inCodeAtStart: boolean;
};

const tagNamePattern = String.raw`[A-Za-z][\w:.-]*`;
const rawHtmlLinePattern = new RegExp(
  String.raw`^[ \t]*(?:<!--.*-->|<![A-Za-z][^\n]*>|<\?[^\n]*\?>|<!\[CDATA\[[^\n]*\]\]>|<\/?${tagNamePattern}\b[^\n]*>?[^\n]*)$`
);
const jsxExpressionValuePattern = String.raw`\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\}`;
const inlineHtmlPattern = new RegExp(
  String.raw`(?:<\/?${tagNamePattern}(?:\s+(?:\{\.\.\.[^{}]+\}|[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|${jsxExpressionValuePattern}|[^\s"'=<>` +
    '`' +
    String.raw`]+))?))*\s*\/?>)|<\!--[\s\S]*?-->|<\?[^\n]*\?>|<!\[CDATA\[[^\n]*\]\]>`,
  'g'
);
const singleTagPattern = new RegExp(
  String.raw`^(?:<\/?${tagNamePattern}(?:\s+(?:\{\.\.\.[^{}]+\}|[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|${jsxExpressionValuePattern}|[^\s"'=<>` +
    '`' +
    String.raw`]+))?))*\s*\/?>|<\!--[\s\S]*?-->|<\?[^\n]*\?>|<!\[CDATA\[[^\n]*\]\]>)$`
);
const voidHtmlTags = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function getFenceMarker(line: string, allowIndented = false) {
  const listMatch = line.match(
    /^((?:[ \t]{0,3}>[ \t]?)*)([ \t]*(?:[-+*]|\d+[.)])[ \t]+)(`{3,}|~{3,})/
  );
  if (listMatch) {
    const blockquotePrefix = listMatch[1];
    const afterBlockquote = line.slice(blockquotePrefix.length);
    if (!blockquotePrefix && /^( {4}|\t)/.test(afterBlockquote)) {
      // fall through — indented code block, not a list fence
    } else {
      return {
        marker: listMatch[3],
        prefix: `${listMatch[1]}${listMatch[2]}`,
        closePrefix: `${listMatch[1]}${' '.repeat(listMatch[2].length)}`,
      };
    }
  }

  const prefix = allowIndented
    ? /^(?:[ \t]*|(?:[ \t]{0,3}>[ \t]?)*)/
    : /^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}/;
  const match = line.match(new RegExp(`${prefix.source}(\`{3,}|~{3,})`));
  if (!match) return null;

  const matchedPrefix = line.slice(0, match[0].length - match[1].length);
  return {
    marker: match[1],
    prefix: matchedPrefix,
    closePrefix: matchedPrefix.trim() === '' && matchedPrefix.length <= 3 ? '' : matchedPrefix,
  };
}

function normalizeTabsToSpaces(str: string, tabSize = 4) {
  let result = '';
  let col = 0;
  for (const char of str) {
    if (char === '\t') {
      const spaces = tabSize - (col % tabSize);
      result += ' '.repeat(spaces);
      col += spaces;
    } else {
      result += char;
      col += 1;
    }
  }
  return result;
}

function closesFence(line: string, fence: FenceState) {
  const normalizedLine = normalizeTabsToSpaces(line);
  const normalizedClosePrefix = normalizeTabsToSpaces(fence.closePrefix);
  const quotePrefix = normalizedClosePrefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefixPattern = normalizedClosePrefix === '' ? '[ ]{0,3}' : `${quotePrefix}[ ]{0,3}`;
  const match = normalizedLine.match(new RegExp(`^${prefixPattern}(\`{3,}|~{3,})[ ]*$`));
  return !!match && match[1][0] === fence.char && match[1].length >= fence.length;
}

function getMultiLineHtmlStartTag(line: string) {
  if (isIncompleteOpeningTag(line)) {
    const match = line.match(/^[ \t]*<([A-Za-z][\w:.-]*)\b/);
    return match?.[1].toLowerCase() || null;
  }

  const matches = getTagMatches(line);
  if (matches.length === 0) {
    return null;
  }

  const depths = new Map<string, number>();
  for (const match of matches) {
    const currentDepth = depths.get(match.name) || 0;
    const nextDepth = currentDepth + (match.closing || match.selfClosing ? -1 : 1);
    depths.set(match.name, nextDepth);
  }

  for (const [tagName, depth] of depths) {
    if (depth > 0 && !voidHtmlTags.has(tagName)) {
      return tagName;
    }
  }

  return null;
}

function findUnquotedTagEnd(line: string, startIndex = 0) {
  let quote: '"' | "'" | null = null;
  let braceDepth = 0;

  for (let index = startIndex; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && line[index - 1] !== '\\' && braceDepth === 0) {
      quote = quote === char ? null : quote || char;
    } else if (char === '{' && !quote) {
      braceDepth += 1;
    } else if (char === '}' && !quote && braceDepth > 0) {
      braceDepth -= 1;
    } else if (char === '>' && !quote && braceDepth === 0) {
      return index;
    }
  }

  return -1;
}

function hasCompleteOpeningTag(line: string) {
  return findUnquotedTagEnd(line) !== -1;
}

function getHtmlFencePrefix(line: string) {
  const blockquotePrefix = line.match(/^(?:[ \t]{0,3}>[ \t]?)*/)?.[0];
  if (blockquotePrefix) return blockquotePrefix;

  return line.match(/^[ \t]*/)?.[0] || '';
}

function getFenceDelimiter(lines: string[]) {
  const longestBacktickRun = Math.max(
    2,
    ...lines.flatMap((line) => [...line.matchAll(/`+/g)].map((match) => match[0].length))
  );
  return '`'.repeat(longestBacktickRun + 1);
}

function fenceHtmlBlock(lines: string[]) {
  const prefix = getHtmlFencePrefix(lines[0] || '');
  const delimiter = getFenceDelimiter(lines);
  return `${prefix}${delimiter}html\n${lines.join('\n')}\n${prefix}${delimiter}`;
}

type ListMarkerHtmlLine = {
  markerPrefix: string;
  blockquotePrefix: string;
  contentIndentWidth: number;
  content: string;
};

function columnIndex(s: string): number {
  let col = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '\t') {
      col = Math.floor((col + 4) / 4) * 4;
    } else {
      col += 1;
    }
  }
  return col;
}

function getListMarkerHtmlLine(line: string): ListMarkerHtmlLine | null {
  const blockquotePrefix = line.match(/^(?:[ \t]{0,3}>[ \t]?)*/)?.[0] || '';
  const listMatch = line
    .slice(blockquotePrefix.length)
    .match(/^([ \t]*(?:[-+*]|\d+[.)])[ \t]+)(\S.*)$/);
  if (!listMatch) return null;

  const spacesAfterMarker = listMatch[1].length - listMatch[1].trimEnd().length;
  if (spacesAfterMarker >= 5) return null;

  return {
    markerPrefix: `${blockquotePrefix}${listMatch[1]}`,
    blockquotePrefix,
    contentIndentWidth: columnIndex(listMatch[1]),
    content: listMatch[2],
  };
}

function stripListContinuation(line: string, targetWidth: number) {
  let width = 0;
  let i = 0;
  while (i < line.length && width < targetWidth) {
    if (line[i] === '\t') {
      width = Math.floor((width + 4) / 4) * 4;
    } else {
      width += 1;
    }
    i += 1;
  }
  return line.slice(i);
}

function fenceListHtmlBlock(lines: string[], listLine: ListMarkerHtmlLine) {
  const continuationPrefix = `${listLine.blockquotePrefix}${' '.repeat(listLine.contentIndentWidth)}`;
  const contentLines = [
    listLine.content,
    ...lines
      .slice(1)
      .map((line) =>
        stripListContinuation(stripBlockquotePrefix(line), listLine.contentIndentWidth)
      ),
  ];
  const delimiter = getFenceDelimiter(contentLines);
  const fencedContent = contentLines.map((line) => `${continuationPrefix}${line}`).join('\n');
  return `${listLine.markerPrefix}${delimiter}html\n${fencedContent}\n${continuationPrefix}${delimiter}`;
}

type TagMatch = {
  name: string;
  closing: boolean;
  selfClosing: boolean;
};

function getTagMatches(line: string) {
  const matches: TagMatch[] = [];
  let inComment = false;

  for (let index = 0; index < line.length; index += 1) {
    if (inComment) {
      const commentEnd = line.indexOf('-->', index);
      if (commentEnd === -1) break;
      inComment = false;
      index = commentEnd + 2;
      continue;
    }

    if (line.startsWith('<!--', index)) {
      inComment = true;
      index += 3;
      continue;
    }

    if (line[index] !== '<') continue;

    const closing = line[index + 1] === '/';
    const nameStart = index + (closing ? 2 : 1);
    const nameMatch = line.slice(nameStart).match(/^([A-Za-z][\w:.-]*)\b/);
    if (!nameMatch) continue;

    const tagEnd = findUnquotedTagEnd(line, nameStart + nameMatch[1].length);
    if (tagEnd === -1) continue;

    matches.push({
      name: nameMatch[1].toLowerCase(),
      closing,
      selfClosing: /\/\s*$/.test(line.slice(index + 1, tagEnd)),
    });
    index = tagEnd;
  }

  return matches;
}

function countTagMatches(line: string, tagName: string, closing: boolean) {
  return getTagMatches(line).filter(
    (match) =>
      match.name === tagName && match.closing === closing && (closing || !match.selfClosing)
  ).length;
}

function updateCommentState(line: string, inComment: boolean) {
  let cursor = 0;
  while (cursor < line.length) {
    if (inComment) {
      const commentEnd = line.indexOf('-->', cursor);
      if (commentEnd === -1) return { inComment: true, onlyComment: true };
      inComment = false;
      cursor = commentEnd + 3;
      continue;
    }

    const commentStart = line.indexOf('<!--', cursor);
    if (commentStart === -1) {
      return { inComment: false, onlyComment: line.slice(cursor).trim() === '' };
    }
    if (line.slice(cursor, commentStart).trim() !== '') {
      return { inComment, onlyComment: false };
    }
    inComment = true;
    cursor = commentStart + 4;
  }

  return { inComment, onlyComment: true };
}

function getTagDepth(line: string, tagName: string) {
  return getTagMatches(line).reduce((depth, match) => {
    if (match.name !== tagName) return depth;
    return depth + (match.closing || match.selfClosing ? -1 : 1);
  }, 0);
}

function isMultilineHtmlCommentStart(line: string) {
  const trimmed = line.trim();
  return trimmed.startsWith('<!--') && !trimmed.includes('-->');
}

const safeUriSchemes = new Set(['http', 'https', 'ftp', 'ftps', 'mailto', 'irc', 'ircs', 'urn']);

function isAutolink(html: string) {
  const match = /^<([a-z][a-z0-9+.-]+):([^<>\s]+)>$/i.exec(html);
  if (match) {
    return safeUriSchemes.has(match[1].toLowerCase());
  }
  return /^<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>$/i.test(html);
}

function isEscaped(content: string, index: number) {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && content[cursor] === '\\'; cursor -= 1) {
    backslashes += 1;
  }

  return backslashes % 2 === 1;
}

function escapeInlineHtmlSegment(segment: string) {
  return segment.replace(inlineHtmlPattern, (html, index) => {
    if (isAutolink(html) || isEscaped(segment, index)) {
      return html;
    }

    const longestBacktickRun = Math.max(0, ...html.matchAll(/`+/g).map((match) => match[0].length));
    const delimiter = '`'.repeat(longestBacktickRun + 1);
    return `${delimiter}${html}${delimiter}`;
  });
}

function isInsideInlineHtml(line: string, index: number) {
  const openIndex = line.lastIndexOf('<', index);
  if (openIndex === -1) return false;

  const closeIndex = findUnquotedTagEnd(line, openIndex);
  return closeIndex !== -1 && closeIndex > index;
}

function escapeInlineHtml(line: string, codeDelimiter: string | null): InlineHtmlEscapeResult {
  const inCodeAtStart = codeDelimiter != null;
  let escapedLine = '';
  let textBuffer = '';
  let cursor = 0;

  const flushTextBuffer = () => {
    escapedLine += codeDelimiter ? textBuffer : escapeInlineHtmlSegment(textBuffer);
    textBuffer = '';
  };

  for (const match of line.matchAll(/`+/g)) {
    const delimiter = match[0];
    const index = match.index;
    textBuffer += line.slice(cursor, index);

    if (isEscaped(line, index) || isInsideInlineHtml(line, index)) {
      textBuffer += delimiter;
      cursor = index + delimiter.length;
      continue;
    }

    flushTextBuffer();
    if (codeDelimiter === delimiter) {
      codeDelimiter = null;
    } else if (!codeDelimiter) {
      codeDelimiter = delimiter;
    }
    escapedLine += delimiter;
    cursor = index + delimiter.length;
  }

  textBuffer += line.slice(cursor);
  flushTextBuffer();

  return { line: escapedLine, codeDelimiter, inCodeAtStart };
}

function isListItem(line: string) {
  return /^[ \t]{0,3}(?:[-+*]|\d+[.)])[ \t]+\S/.test(line);
}

function isIndentedCodeLine(line: string, inList: boolean) {
  return !inList && /^( {4}|\t)/.test(stripBlockquotePrefix(line));
}

function isSelfClosingTagEnd(line: string) {
  return /\/\s*>\s*$/.test(line);
}

function isIncompleteOpeningTag(line: string) {
  return !hasCompleteOpeningTag(line);
}

function isStandaloneHtmlLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('<') || isAutolink(trimmed)) return false;
  if (/^<\?[^\n]*\?>$/.test(trimmed)) return true;
  if (/^<!\[CDATA\[[^\n]*\]\]>$/.test(trimmed)) return true;

  const firstTagEnd = findUnquotedTagEnd(trimmed, 1);
  if (firstTagEnd === -1) return true;

  const remainder = trimmed.slice(firstTagEnd + 1).trim();
  const startTag = trimmed.match(/^<([A-Za-z][\w:.-]*)\b/)?.[1].toLowerCase();
  if (startTag && new RegExp(`</${startTag}>\\s*$`, 'i').test(trimmed)) return true;
  if (startTag) {
    const closingMatch = new RegExp(`</${startTag}>`, 'i').exec(trimmed);
    const trailingText = closingMatch
      ? trimmed.slice(closingMatch.index + closingMatch[0].length).trim()
      : '';

    if (trailingText) {
      const tokens = trailingText.split(/\s+/).filter(Boolean);
      if (tokens.length > 0 && !tokens.every((token) => singleTagPattern.test(token))) {
        return false;
      }
    }
    if (!closingMatch && !voidHtmlTags.has(startTag) && /^<[^>]+>\S/.test(trimmed)) return true;
    if (trailingText && !trailingText.startsWith('<')) return false;
  }
  if (startTag && !voidHtmlTags.has(startTag) && /^<[^>]+>\S/.test(trimmed)) {
    return /<\/?[A-Za-z][\w:.-]*\b/.test(remainder);
  }

  return remainder === '' || /<\/?[A-Za-z][\w:-]*\b/.test(remainder);
}

function stripBlockquotePrefix(line: string) {
  return line.replace(/^(?:[ \t]{0,3}>[ \t]?)*/, '');
}

function stripHtmlBlockContinuation(line: string, listLine: ListMarkerHtmlLine | null) {
  const unquotedLine = stripBlockquotePrefix(line);
  return listLine ? stripListContinuation(unquotedLine, listLine.contentIndentWidth) : unquotedLine;
}

function collectHtmlBlock(
  lines: string[],
  startIndex: number,
  lineForHtml: string,
  startTag: string,
  listLine: ListMarkerHtmlLine | null
) {
  const blockLines = [lines[startIndex]];
  if (voidHtmlTags.has(startTag)) {
    for (let nextIndex = startIndex + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextLine = lines[nextIndex];
      const nextLineForHtml = stripHtmlBlockContinuation(nextLine, listLine);
      blockLines.push(nextLine);

      if (hasCompleteOpeningTag(nextLineForHtml) || isSelfClosingTagEnd(nextLineForHtml)) {
        return { blockLines, endIndex: nextIndex, foundClose: true };
      }
    }

    return { blockLines, endIndex: startIndex, foundClose: false };
  }

  let depth = Math.max(1, getTagDepth(lineForHtml, startTag));
  let collectingOpeningTag = isIncompleteOpeningTag(lineForHtml);
  let inComment = updateCommentState(lineForHtml, false).inComment;
  for (let nextIndex = startIndex + 1; nextIndex < lines.length; nextIndex += 1) {
    const nextLine = lines[nextIndex];
    const nextLineForHtml = stripHtmlBlockContinuation(nextLine, listLine);
    blockLines.push(nextLine);

    const commentState = updateCommentState(nextLineForHtml, inComment);
    inComment = commentState.inComment;
    if (commentState.onlyComment) {
      continue;
    }

    if (collectingOpeningTag) {
      if (isSelfClosingTagEnd(nextLineForHtml)) {
        return { blockLines, endIndex: nextIndex, foundClose: true };
      }
      if (!hasCompleteOpeningTag(nextLineForHtml)) {
        continue;
      }
      collectingOpeningTag = false;
    }

    depth += countTagMatches(nextLineForHtml, startTag, false);
    depth -= countTagMatches(nextLineForHtml, startTag, true);

    if (depth === 0) {
      return { blockLines, endIndex: nextIndex, foundClose: true };
    }
  }

  return { blockLines, endIndex: startIndex, foundClose: false };
}

function retryLines(escapedLines: string[], lines: string[], fromIndex: number, toIndex: number) {
  for (let i = fromIndex; i < toIndex; i += 1) {
    escapedLines[i] = escapeInlineHtmlSegment(lines[i]);
  }
}

function escapeRawHtmlBlocks(content: string, escapeMultilineCodeSpans = false): string {
  const lines = content.split('\n');
  const escapedLines: string[] = [];
  let fence: FenceState | null = null;
  let inList = false;
  let inIndentedCode = false;
  let inBlockquote = false;
  let codeDelimiter: string | null = null;
  let unmatchedDelimiterIndex = -1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = getFenceMarker(line, inList);
    const isBlockquoteLine = stripBlockquotePrefix(line) !== line;

    if (isBlockquoteLine !== inBlockquote) {
      if (codeDelimiter && unmatchedDelimiterIndex !== -1) {
        retryLines(escapedLines, lines, unmatchedDelimiterIndex, index);
      }
      codeDelimiter = null;
      unmatchedDelimiterIndex = -1;
    }
    inBlockquote = isBlockquoteLine;

    if (isListItem(stripBlockquotePrefix(line))) {
      if (codeDelimiter && unmatchedDelimiterIndex !== -1) {
        retryLines(escapedLines, lines, unmatchedDelimiterIndex, index);
      }
      inList = true;
      inIndentedCode = false;
      codeDelimiter = null;
      unmatchedDelimiterIndex = -1;
    } else if (/^#{1,6}\s/.test(stripBlockquotePrefix(line))) {
      if (codeDelimiter && unmatchedDelimiterIndex !== -1) {
        retryLines(escapedLines, lines, unmatchedDelimiterIndex, index);
      }
      codeDelimiter = null;
      unmatchedDelimiterIndex = -1;
    } else if (/^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}(={3,}|-{3,})\s*$/.test(line)) {
      if (codeDelimiter && unmatchedDelimiterIndex !== -1) {
        retryLines(escapedLines, lines, unmatchedDelimiterIndex, index);
      }
      codeDelimiter = null;
      unmatchedDelimiterIndex = -1;
    } else if (line.trim() === '') {
      if (codeDelimiter && unmatchedDelimiterIndex !== -1) {
        retryLines(escapedLines, lines, unmatchedDelimiterIndex, index);
      }
      inList = false;
      codeDelimiter = null;
      unmatchedDelimiterIndex = -1;
    } else if (/^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}(?:[-*_][ \t]*){3,}\s*$/.test(line)) {
      if (codeDelimiter && unmatchedDelimiterIndex !== -1) {
        retryLines(escapedLines, lines, unmatchedDelimiterIndex, index);
      }
      codeDelimiter = null;
      unmatchedDelimiterIndex = -1;
    } else if (/^(?:[ \t]{0,3}>[ \t]?)*[ \t]*\|/.test(line)) {
      if (codeDelimiter && unmatchedDelimiterIndex !== -1) {
        retryLines(escapedLines, lines, unmatchedDelimiterIndex, index);
      }
      codeDelimiter = null;
      unmatchedDelimiterIndex = -1;
    } else {
      const strippedLine = stripBlockquotePrefix(line);
      if (strippedLine.trim() === '' && line !== strippedLine) {
        if (codeDelimiter && unmatchedDelimiterIndex !== -1) {
          retryLines(escapedLines, lines, unmatchedDelimiterIndex, index);
        }
        codeDelimiter = null;
        unmatchedDelimiterIndex = -1;
      }
    }

    if (fence) {
      if (closesFence(line, fence)) {
        fence = null;
      }
      escapedLines.push(line);
      continue;
    }

    if (fenceMatch) {
      if (codeDelimiter && unmatchedDelimiterIndex !== -1) {
        retryLines(escapedLines, lines, unmatchedDelimiterIndex, index);
      }
      fence = {
        char: fenceMatch.marker[0] as '`' | '~',
        length: fenceMatch.marker.length,
        prefix: fenceMatch.prefix,
        closePrefix: fenceMatch.closePrefix,
      };
      inIndentedCode = false;
      codeDelimiter = null;
      unmatchedDelimiterIndex = -1;
      escapedLines.push(line);
      continue;
    }

    if (isIndentedCodeLine(line, inList) && !codeDelimiter) {
      if (inIndentedCode || index === 0 || lines[index - 1].trim() === '') {
        inIndentedCode = true;
        escapedLines.push(line);
        continue;
      }
    }

    inIndentedCode = false;

    let listLine = getListMarkerHtmlLine(line);
    if (listLine && !inList && /^( {4}|\t)/.test(stripBlockquotePrefix(line))) {
      listLine = null;
    }
    const lineForHtml = stripBlockquotePrefix(listLine?.content ?? line);
    const escaped = escapeInlineHtml(line, escapeMultilineCodeSpans ? null : codeDelimiter);
    codeDelimiter = escaped.codeDelimiter;

    if (!escapeMultilineCodeSpans) {
      if (escaped.inCodeAtStart && !codeDelimiter) {
        unmatchedDelimiterIndex = -1;
      } else if (!escaped.inCodeAtStart && codeDelimiter && unmatchedDelimiterIndex === -1) {
        unmatchedDelimiterIndex = index;
      }
    }

    if (isMultilineHtmlCommentStart(lineForHtml) && !escaped.inCodeAtStart) {
      const blockLines = [line];
      let foundEnd = false;
      for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
        const nextLine = lines[nextIndex];
        blockLines.push(nextLine);

        if (nextLine.includes('-->')) {
          foundEnd = true;
          index = nextIndex;
          break;
        }
      }

      if (foundEnd) {
        escapedLines.push(
          listLine ? fenceListHtmlBlock(blockLines, listLine) : fenceHtmlBlock(blockLines)
        );
        continue;
      } else {
        escapedLines.push(listLine ? fenceListHtmlBlock([line], listLine) : fenceHtmlBlock([line]));
        continue;
      }
    }

    if (!rawHtmlLinePattern.test(lineForHtml) || escaped.inCodeAtStart) {
      escapedLines.push(escaped.line);
      continue;
    }

    if (!isStandaloneHtmlLine(lineForHtml)) {
      escapedLines.push(escaped.line);
      continue;
    }

    const startTag = getMultiLineHtmlStartTag(lineForHtml);
    if (!startTag) {
      escapedLines.push(listLine ? fenceListHtmlBlock([line], listLine) : fenceHtmlBlock([line]));
      continue;
    }

    const block = collectHtmlBlock(lines, index, lineForHtml, startTag, listLine);
    if (block.foundClose) {
      index = block.endIndex;
    }

    if (listLine) {
      escapedLines.push(
        block.foundClose
          ? fenceListHtmlBlock(block.blockLines, listLine)
          : fenceListHtmlBlock([line], listLine)
      );
    } else {
      escapedLines.push(
        block.foundClose ? fenceHtmlBlock(block.blockLines) : fenceHtmlBlock([line])
      );
    }
  }

  if (codeDelimiter && !escapeMultilineCodeSpans) {
    const retryContent = lines.slice(unmatchedDelimiterIndex).join('\n');
    const retryResult = escapeRawHtmlBlocks(retryContent, true);
    return [...escapedLines.slice(0, unmatchedDelimiterIndex), retryResult].join('\n');
  }

  return escapedLines.join('\n');
}

function hasCodeBlock(content: string) {
  return (
    /(^|\n)(?:[ \t]{0,3}>[ \t]?)*(?:[ \t]*|[ \t]*(?:[-+*]|\d+[.)])[ \t]+)(```|~~~)/.test(content) ||
    /(^|\n)(?:[ \t]{0,3}>[ \t]?)*(?: {4}|\t)\S/.test(content)
  );
}

function getMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = import('mermaid')
      .then((module) => {
        module.default.initialize({ startOnLoad: false });
        return module.default;
      })
      .catch((error) => {
        mermaidModulePromise = null;
        throw error;
      });
  }

  return mermaidModulePromise;
}

async function renderMermaidBlocks(container: HTMLElement, isCancelled?: () => boolean) {
  const blocks = Array.from(container.querySelectorAll('pre code.language-mermaid'));
  if (blocks.length === 0) return;

  const mermaid = await getMermaid();
  if (isCancelled?.()) return;

  await Promise.all(
    blocks.map(async (block) => {
      if (isCancelled?.()) return;
      const pre = block.parentElement;
      if (!pre) return;

      const source = block.textContent || '';
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid';
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
    })
  );
}

async function renderMarkdown(content: string) {
  const modules = await getMarkdownModules();
  const escapedContent = escapeRawHtmlBlocks(content);
  const shouldRenderMath = hasMath(content);
  const shouldHighlightCode = hasCodeBlock(escapedContent);
  const rehypeKatex = shouldRenderMath ? await getRehypeKatex() : null;
  const rehypeHighlight = shouldHighlightCode ? await getRehypeHighlight() : null;

  if (shouldRenderMath) {
    loadKatexCss().catch(() => undefined);
  }

  const processor = modules
    .unified()
    .use(modules.remarkParse)
    .use(modules.remarkGfm)
    .use(modules.remarkMath, { singleDollarTextMath: false })
    .use(modules.remarkBreaks)
    .use(modules.remarkRehype);

  if (rehypeKatex) {
    processor.use(rehypeKatex);
  }

  if (rehypeHighlight) {
    processor.use(rehypeHighlight, { detect: true, ignoreMissing: true, plainText: ['mermaid'] });
  }

  const file = await processor.use(modules.rehypeStringify).process(escapedContent);
  const htmlStr = String(file).replace(/(^|>[^<]*)-->([^<]*<|$)/g, '$1--&gt;$2');
  return htmlStr;
}

export default function MarkdownRenderer({ content, class: className }: MarkdownRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const rafId = requestAnimationFrame(() => {
      renderMarkdown(content)
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
  }, [content]);

  useEffect(() => {
    if (html == null || !containerRef.current) return;
    containerRef.current.innerHTML = html;

    let mermaidCancelled = false;
    renderMermaidBlocks(containerRef.current, () => mermaidCancelled).catch(() => undefined);

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
      mermaidCancelled = true;
    };
  }, [html]);

  return <div ref={containerRef} class={`prose ${className || ''}`} />;
}
