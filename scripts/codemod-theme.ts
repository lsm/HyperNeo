#!/usr/bin/env bun

import * as ts from 'typescript';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countRawPalette } from './check-raw-palette.ts';

export interface ThemeMapping {
  utilities: Record<string, string>;
  pairs: Record<string, string>;
}

const SEMANTIC_TOKEN_RE =
  /^(bg|text|border|ring|divide|fill|stroke)-(bg|surface|fg|line|fill|scrim|accent|success|warning|danger|info|cat)/;

export function loadMapping(): ThemeMapping {
  const parsed: unknown = JSON.parse(
    readFileSync(join(import.meta.dir, 'theme-mapping.json'), 'utf8')
  );
  const record = (
    typeof parsed === 'object' && parsed !== null ? parsed : {}
  ) as Partial<ThemeMapping>;
  return { utilities: record.utilities ?? {}, pairs: record.pairs ?? {} };
}

function lookupUtility(mapping: ThemeMapping, key: string): string | undefined {
  return Object.hasOwn(mapping.utilities, key) ? mapping.utilities[key] : undefined;
}

export function rewriteClassString(
  text: string,
  mapping: ThemeMapping
): { text: string; changes: string[] } {
  const changes: string[] = [];
  const words = text.split(/\s+/).filter(Boolean);

  for (const [pairKey, replacement] of Object.entries(mapping.pairs)) {
    const [lightToken, darkToken] = pairKey.split('|');
    const lightIdx = words.indexOf(lightToken);
    const darkIdx = words.indexOf(darkToken);
    if (lightIdx === -1 || darkIdx === -1) continue;
    words[lightIdx] = replacement;
    words.splice(darkIdx, 1);
    changes.push(`${pairKey} -> ${replacement}`);
  }

  const mapped = words.map((token) => {
    const direct = lookupUtility(mapping, token);
    if (direct) {
      changes.push(`${token} -> ${direct}`);
      return direct;
    }
    const variantIdx = token.lastIndexOf(':');
    const head = variantIdx === -1 ? '' : token.slice(0, variantIdx + 1);
    if (head.split(':').includes('dark')) return token;
    const body = variantIdx === -1 ? token : token.slice(variantIdx + 1);
    const bodyExact = lookupUtility(mapping, body);
    if (bodyExact) {
      const next = `${head}${bodyExact}`;
      changes.push(`${token} -> ${next}`);
      return next;
    }
    const suffixMatch = /^(.*?)(\/\d{1,3}|\/\[[\d.]+\])?$/.exec(body);
    const base = suffixMatch?.[1] ?? body;
    const rawSuffix = suffixMatch?.[2] ?? '';
    const mappedBase = lookupUtility(mapping, base);
    if (!mappedBase) return token;
    const suffix = mappedBase.includes('/') ? '' : rawSuffix;
    const next = `${head}${mappedBase}${suffix}`;
    changes.push(`${token} -> ${next}`);
    return next;
  });

  const finalWords = mapped.filter((token) => {
    if (!token.startsWith('dark:')) return true;
    const body = token.slice(5);
    const suffixMatch = /^(.*?)(\/\d{1,3}|\/\[[\d.]+\])?$/.exec(body);
    const base = suffixMatch?.[1] ?? body;
    const darkMapped = lookupUtility(mapping, body) ?? lookupUtility(mapping, base);
    const peer = mapped.find(
      (other) =>
        !other.includes(':') &&
        other.split('-')[0] === body.split('-')[0] &&
        SEMANTIC_TOKEN_RE.test(other)
    );
    if (!peer) return true;
    if (darkMapped && darkMapped !== peer) return true;
    changes.push(`drop ${token}`);
    return false;
  });

  if (changes.length === 0) return { text, changes };
  const leading = /^\s*/.exec(text)?.[0] ?? '';
  const trailing = /\s*$/.exec(text)?.[0] ?? '';
  return { text: `${leading}${finalWords.join(' ')}${trailing}`, changes };
}

interface Rewrite {
  start: number;
  end: number;
  replacement: string;
}

function isClassAttribute(node: ts.Node): node is ts.JsxAttribute {
  return (
    ts.isJsxAttribute(node) &&
    ts.isIdentifier(node.name) &&
    (node.name.text === 'class' || node.name.text === 'className')
  );
}

function isClassComposerCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    (node.expression.text === 'cn' || node.expression.text === 'clsx')
  );
}

export function collectRewrites(
  sourceText: string,
  fileName: string,
  mapping: ThemeMapping,
  allStrings = false
): { rewrites: Rewrite[]; changes: string[] } {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.ESNext,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const rewrites: Rewrite[] = [];
  const changes: string[] = [];

  const rewriteLiteral = (node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral): void => {
    const raw = node.getText(sourceFile);
    const delimiter = raw[0];
    const result = rewriteClassString(raw.slice(1, -1), mapping);
    if (result.changes.length === 0) return;
    rewrites.push({
      start: node.getStart(sourceFile),
      end: node.getEnd(),
      replacement: `${delimiter}${result.text}${delimiter}`,
    });
    changes.push(...result.changes);
  };

  const rewriteTemplatePart = (
    node: ts.TemplateHead | ts.TemplateMiddle | ts.TemplateTail,
    prefix: string,
    suffix: string
  ): void => {
    const result = rewriteClassString(node.text, mapping);
    if (result.changes.length === 0) return;
    rewrites.push({
      start: node.getStart(sourceFile),
      end: node.getEnd(),
      replacement: `${prefix}${result.text}${suffix}`,
    });
    changes.push(...result.changes);
  };

  const visitTemplate = (node: ts.TemplateExpression): void => {
    rewriteTemplatePart(node.head, '`', '${');
    for (const span of node.templateSpans) {
      const isMiddle = span.literal.kind === ts.SyntaxKind.TemplateMiddle;
      rewriteTemplatePart(span.literal, '}', isMiddle ? '${' : '`');
    }
  };

  const visitStrings = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      rewriteLiteral(node);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      visitTemplate(node);
    }
    node.forEachChild(visitStrings);
  };

  const visit = (node: ts.Node): void => {
    if (allStrings) {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        rewriteLiteral(node);
        return;
      }
      if (ts.isTemplateExpression(node)) {
        visitTemplate(node);
      }
      node.forEachChild(visit);
      return;
    }
    if (isClassAttribute(node)) {
      if (node.initializer) visitStrings(node.initializer);
      return;
    }
    if (isClassComposerCall(node)) {
      for (const arg of node.arguments) visitStrings(arg);
      return;
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return { rewrites, changes };
}

export function applyRewrites(sourceText: string, rewrites: Rewrite[]): string {
  let out = sourceText;
  for (const rewrite of [...rewrites].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, rewrite.start) + rewrite.replacement + out.slice(rewrite.end);
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = args.includes('--write');
  const allStrings = args.includes('--all-strings');
  const pathIdx = args.indexOf('--path');
  const targets = pathIdx === -1 ? [] : args.slice(pathIdx + 1).filter((a) => !a.startsWith('--'));
  if (targets.length === 0) {
    process.stderr.write(
      'usage: codemod-theme.ts --path <file-or-dir> [--write] [--all-strings]\n'
    );
    process.exit(2);
  }

  const mapping = loadMapping();
  const { glob } = await import('node:fs/promises');
  const files: string[] = [];
  for (const target of targets) {
    const pattern = target.endsWith('.tsx') || target.endsWith('.ts') ? target : `${target}/**/*`;
    for await (const entry of glob(pattern)) {
      if (/\.(ts|tsx)$/.test(entry)) files.push(entry);
    }
  }

  let totalChanges = 0;
  let totalRemaining = 0;
  for (const file of files) {
    const sourceText = readFileSync(file, 'utf8');
    const { rewrites, changes } = collectRewrites(sourceText, file, mapping, allStrings);
    const next = applyRewrites(sourceText, rewrites);
    const remaining = countRawPalette(next);
    if (changes.length > 0) {
      totalChanges += changes.length;
      process.stdout.write(`${file}: ${changes.length} rewrites, ${remaining} raw remaining\n`);
      if (write) await Bun.write(file, next);
    } else if (remaining > 0) {
      totalRemaining += remaining;
      process.stdout.write(`${file}: 0 rewrites, ${remaining} raw remaining (unmapped)\n`);
    }
  }
  process.stdout.write(
    `${write ? 'applied' : 'dry-run'}: ${totalChanges} rewrites across ${files.length} files\n`
  );
}

if (import.meta.main) {
  await main();
}
