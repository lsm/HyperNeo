#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const NEO_ROOT = join(import.meta.dir, '..', 'packages', 'web', 'src', 'neo');
const ALLOWLIST_PATH = join(import.meta.dir, 'neo-strings-allowlist.json');
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
const LETTERS = /[A-Za-z]/;
const TEXT_ATTRIBUTES = new Set(['aria-label', 'title']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return entry === '__tests__' ? [] : walk(full);
    return entry.endsWith('.tsx') ? [full] : [];
  });
}

export function findHardCodedStrings(source: string, fileName = 'file.tsx'): string[] {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const found: string[] = [];
  const at = (node: ts.Node) => `${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
  const rendered = (expression: ts.Expression): Array<ts.Node & { text: string }> => {
    if (ts.isStringLiteralLike(expression)) return [expression];
    if (ts.isTemplateExpression(expression))
      return [expression.head, ...expression.templateSpans.map((span) => span.literal)];
    if (ts.isParenthesizedExpression(expression)) return rendered(expression.expression);
    if (ts.isConditionalExpression(expression))
      return [...rendered(expression.whenTrue), ...rendered(expression.whenFalse)];
    if (ts.isBinaryExpression(expression)) {
      const operator = expression.operatorToken.kind;
      if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return rendered(expression.right);
      if (
        operator === ts.SyntaxKind.BarBarToken ||
        operator === ts.SyntaxKind.QuestionQuestionToken
      )
        return [...rendered(expression.left), ...rendered(expression.right)];
    }
    return [];
  };
  const report = (label: string, expression: ts.Expression | undefined) => {
    for (const literal of expression ? rendered(expression) : [])
      if (LETTERS.test(literal.text)) found.push(`line ${at(literal)}: ${label} "${literal.text}"`);
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node) && LETTERS.test(node.text.trim()))
      found.push(`line ${at(node)}: JSX text "${node.text.trim()}"`);
    if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent))
      report('JSX expression', node.expression);
    if (
      ts.isJsxAttribute(node) &&
      TEXT_ATTRIBUTES.has(node.name.getText(file)) &&
      node.initializer
    ) {
      const value = node.initializer;
      report(node.name.getText(file), ts.isJsxExpression(value) ? value.expression : value);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

export function checkNeoStrings(): string[] {
  const allowlist = new Set(JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')) as string[]);
  const failures: string[] = [];
  for (const file of walk(NEO_ROOT)) {
    const rel = relative(NEO_ROOT, file).split('\\').join('/');
    const source = readFileSync(file, 'utf8');
    if (allowlist.has(rel)) continue;
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      if (CJK.test(line)) failures.push(`${rel} line ${index + 1}: CJK text outside lib/i18n`);
    });
    for (const finding of findHardCodedStrings(source, rel)) failures.push(`${rel} ${finding}`);
  }
  return failures;
}

if (import.meta.main) {
  const failures = checkNeoStrings();
  if (failures.length) {
    console.error('Hard-coded Neo UI strings (use t() from lib/i18n):');
    for (const failure of failures) console.error(`  ${failure}`);
    process.exit(1);
  }
  console.log('neo strings: all non-allowlisted files use t()');
}
