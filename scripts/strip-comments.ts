#!/usr/bin/env bun

import * as ts from 'typescript';

const KEEP_PATTERNS: RegExp[] = [
  /^#!/,
  /^\/\/\/\s*</,
  /@ts-(ignore|expect-error|nocheck|check)\b/,
  /biome-ignore/,
  /^(?:\/\/|\/\*)\s*eslint-/,
  /oxlint-(disable|enable)/,
  /@public\b/,
  /(v8|istanbul|c8) ignore/,
  /knip-ignore/,
];

interface Range {
  start: number;
  end: number;
}

const COMMENT_RE = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

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
        ranges.push({ start, end });
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

function expandRange(text: string, { start, end }: Range): Range {
  let lineStart = 0;
  if (start > 0) {
    const nl = text.lastIndexOf('\n', start - 1);
    lineStart = nl === -1 ? 0 : nl + 1;
  }
  let nlAfter = text.indexOf('\n', end);
  if (nlAfter === -1) nlAfter = text.length;
  const prefix = text.slice(lineStart, start);
  const suffix = text.slice(end, nlAfter);
  if (/^\s*$/.test(prefix) && /^\s*$/.test(suffix)) {
    return { start: lineStart, end: Math.min(nlAfter + 1, text.length) };
  }
  let e = end;
  while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
  return { start, end: e };
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const r of sorted) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) {
      last.end = Math.max(last.end, r.end);
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

export function stripComments(text: string, fileName: string, isTsx: boolean): string {
  const comments = collectCommentRanges(text, fileName, isTsx);
  if (comments.length === 0) return text;
  const removals = mergeRanges(comments.map((r) => expandRange(text, r)));
  let out = '';
  let cursor = 0;
  for (const { start, end } of removals) {
    out += text.slice(cursor, start);
    cursor = end;
  }
  out += text.slice(cursor);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
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
    const proc = Bun.spawnSync(['git', 'ls-files', '*.ts', '*.tsx']);
    files = proc.stdout
      .toString()
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
  }

  let dirty = 0;
  let removed = 0;
  for (const file of files) {
    const text = await Bun.file(file).text();
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
