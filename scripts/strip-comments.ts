#!/usr/bin/env bun

import * as ts from 'typescript';

const KEEP_PATTERNS: RegExp[] = [
  /^#!/,
  /^\/\/\/\s*</,
  /^(?:\/\/|\/\*+)\s*@ts-(ignore|expect-error|nocheck|check)\b/,
  /^(?:\/\/|\/\*+)\s*biome-ignore\b/,
  /^(?:\/\/|\/\*+)\s*eslint-/,
  /^(?:\/\/|\/\*+)\s*oxlint-(disable|enable)\b/,
  /^(?:\/\/|\/\*+)[\s*]*@public\b/,
  /^(?:\/\/|\/\*+)\s*(?:v8|istanbul|c8) ignore\b/,
  /^(?:\/\/|\/\*+)\s*knip-ignore\b/,
];

interface Range {
  start: number;
  end: number;
  jsx?: boolean;
}

const COMMENT_RE = /\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\//g;

function collectCommentRanges(text: string, fileName: string, isTsx: boolean): Range[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.ESNext,
    true,
    isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const ranges: Range[] = [];
  const seenWindows = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (ts.isJsxExpression(node) && node.expression === undefined) {
      const start = node.getStart(sourceFile);
      const end = node.getEnd();
      const inner = text.slice(start + 1, end - 1);
      const matches = [...inner.matchAll(new RegExp(COMMENT_RE.source, 'g'))];
      if (matches.length > 0 && matches.every((m) => !KEEP_PATTERNS.some((p) => p.test(m[0])))) {
        for (const m of matches) {
          ranges.push({
            start: start + 1 + m.index,
            end: start + 1 + m.index + m[0].length,
            jsx: true,
          });
        }
        return;
      }
    }
    const fullStart = node.getFullStart();
    const start = node.getStart(sourceFile);
    if (fullStart < start && !seenWindows.has(fullStart)) {
      seenWindows.add(fullStart);
      const trivia = text.slice(fullStart, start);
      COMMENT_RE.lastIndex = 0;
      for (let m = COMMENT_RE.exec(trivia); m !== null; m = COMMENT_RE.exec(trivia)) {
        if (KEEP_PATTERNS.some((p) => p.test(m[0]))) continue;
        ranges.push({ start: fullStart + m.index, end: fullStart + m.index + m[0].length });
      }
    }
    for (const child of node.getChildren()) visit(child);
  };
  visit(sourceFile);
  return ranges;
}

function expandRange(text: string, range: Range): Range {
  const { start, end } = range;
  let lineStart = 0;
  for (let i = start - 1; i >= 0; i--) {
    if (LINE_TERMINATOR.test(text[i])) {
      lineStart = i + 1;
      break;
    }
  }
  let nlAfter = -1;
  for (let i = end; i < text.length; i++) {
    if (LINE_TERMINATOR.test(text[i])) {
      nlAfter = i;
      break;
    }
  }
  const lineEnd = nlAfter === -1 ? text.length : nlAfter;
  const prefix = text.slice(lineStart, start);
  const suffix = text.slice(end, lineEnd);
  if (!range.jsx && /^\s*$/.test(prefix) && /^\s*$/.test(suffix)) {
    const ltLen = nlAfter === -1 ? 0 : text[nlAfter] === '\r' && text[nlAfter + 1] === '\n' ? 2 : 1;
    return { ...range, start: lineStart, end: Math.min(nlAfter + ltLen, text.length) };
  }
  let e = end;
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
  return { ...range, end: e };
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
      last.jsx = last.jsx || r.jsx;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

const IDENT_CONTINUE = /[\p{L}\p{N}_$]/u;

const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

const ASI_KEYWORDS = new Set(['return', 'throw', 'break', 'continue', 'yield']);

const PUNCTUATOR = /[{}()[\];,<>=!+\-*/%&|^?:~.@#'"`]/;

const EXTENDABLE_PUNCTUATOR = /[+\-<>=!&|?*%^.]/;

function mergesTokens(text: string, before: number, after: number): boolean {
  if (before < 0 || after >= text.length) return false;
  const continuesIdentifier = IDENT_CONTINUE.test(text[before]);
  const startsIdentifier = IDENT_CONTINUE.test(text[after]) || text[after] === '\\';
  if (continuesIdentifier && startsIdentifier) return true;
  return EXTENDABLE_PUNCTUATOR.test(text[before]) && PUNCTUATOR.test(text[after]);
}

function followsPostfixOperand(text: string, before: number, after: number): boolean {
  if (after + 1 >= text.length) return false;
  let b = before;
  while (b >= 0 && /\s/.test(text[b])) b--;
  if (b < 0) return false;
  const endsOperand = IDENT_CONTINUE.test(text[b]) || /[)\]'"`]/.test(text[b]);
  const op = text.slice(after, after + 2);
  return endsOperand && (op === '++' || op === '--');
}

function precedesAsiKeyword(text: string, before: number): boolean {
  let end = before;
  while (end >= 0 && /\s/.test(text[end])) end--;
  if (end < 0 || !IDENT_CONTINUE.test(text[end])) return false;
  let start = end;
  while (start >= 0 && IDENT_CONTINUE.test(text[start])) start--;
  return ASI_KEYWORDS.has(text.slice(start + 1, end + 1));
}

function trailingNewlines(s: string): number {
  let n = 0;
  while (s[s.length - 1 - n] === '\n') n++;
  return n;
}

function leadingNewlines(s: string): number {
  let n = 0;
  while (s[n] === '\n') n++;
  return n;
}

export function stripComments(text: string, fileName: string, isTsx: boolean): string {
  const comments = collectCommentRanges(text, fileName, isTsx);
  if (comments.length === 0) return text;
  const removals = mergeRanges(comments.map((r) => expandRange(text, r)));
  let out = '';
  let cursor = 0;
  let afterRemoval = false;
  const appendUpTo = (upTo: number): void => {
    let chunk = text.slice(cursor, upTo);
    if (afterRemoval) {
      if (cursor >= text.length || LINE_TERMINATOR.test(text[cursor])) {
        out = out.replace(/[ \t]+$/, '');
      }
      const trail = trailingNewlines(out);
      const lead = leadingNewlines(chunk);
      const excess = trail + lead - 2;
      if (excess > 0) {
        const fromOut = Math.min(trail, excess);
        out = out.slice(0, out.length - fromOut);
        chunk = chunk.slice(Math.min(lead, excess - fromOut));
      }
    }
    out += chunk;
  };
  for (const { start, end, jsx } of removals) {
    appendUpTo(start);
    const hadLineTerminator = LINE_TERMINATOR.test(text.slice(start, end));
    const retainsLineTerminator =
      (start > 0 && LINE_TERMINATOR.test(text[start - 1])) ||
      (end < text.length && LINE_TERMINATOR.test(text[end]));
    const emitLineBreak = (): void => {
      out = out.replace(/[ \t]+$/, '');
      out += '\n';
    };
    if (!jsx && mergesTokens(text, start - 1, end)) {
      if (hadLineTerminator) emitLineBreak();
      else out += ' ';
    } else if (
      !jsx &&
      hadLineTerminator &&
      !retainsLineTerminator &&
      (precedesAsiKeyword(text, start - 1) || followsPostfixOperand(text, start - 1, end))
    ) {
      emitLineBreak();
    }
    cursor = end;
    afterRemoval = true;
  }
  appendUpTo(text.length);
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const stats = args.includes('--stats');
  const filesIdx = args.indexOf('--files');

  let files: string[];
  if (filesIdx !== -1) {
    files = args.slice(filesIdx + 1).filter((a) => !a.startsWith('--'));
  } else {
    const lsArgs = check
      ? ['git', 'ls-files', '*.ts', '*.tsx']
      : ['git', 'ls-files', '--cached', '--others', '--exclude-standard', '*.ts', '*.tsx'];
    const proc = Bun.spawnSync(lsArgs);
    files = proc.stdout
      .toString()
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
  }

  let dirty = 0;
  let removed = 0;
  for (const file of files) {
    const entry = Bun.file(file);
    if (!(await entry.exists())) continue;
    const text = await entry.text();
    const isTsx = file.endsWith('.tsx');
    const stripped = stripComments(text, file, isTsx);
    if (stripped === text) continue;
    dirty++;
    const count = collectCommentRanges(text, file, isTsx).length;
    removed += count;
    if (stats) process.stdout.write(`${file}: ${count}\n`);
    if (check) {
      process.stdout.write(`comments remain: ${file}\n`);
    } else {
      await Bun.write(file, stripped);
    }
  }
  process.stdout.write(
    `${check ? 'files with comments' : 'files stripped'}: ${dirty}, comments removed: ${removed}\n`
  );
  if (check && dirty > 0) process.exit(1);
}

if (import.meta.main) {
  await main();
}
