#!/usr/bin/env bun

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_ROOT = join(import.meta.dir, '..', 'packages', 'web', 'src');
const BASELINE_PATH = join(import.meta.dir, 'raw-palette-baseline.json');

export const RAW_PALETTE_RE =
  /(?:[A-Za-z0-9-]+:)*(?:bg|text|border-[trblxy]|border|ring-offset|ring|from|via|to|divide|outline|placeholder|caret|accent|fill|stroke|decoration|shadow)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}(?:\/(?:\d{1,3}|\[[\d.]+\]))?/g;

export const DARK_SCALE_RE =
  /(?:[A-Za-z0-9-]+:)*(?:bg|text|border-[trblxy]|border|ring-offset|ring|divide|outline|fill|stroke|from|via|to)-dark-\d{3}(?:\/(?:\d{1,3}|\[[\d.]+\]))?/g;

export const WHITE_ALPHA_RE =
  /(?:[A-Za-z0-9-]+:)*(?:bg|text|border-[trblxy]|border|ring-offset|ring|from|via|to|divide|outline|placeholder|caret|accent|fill|stroke|decoration|shadow)-(?:white|black)(?:\/(?:\d{1,3}|\[[\d.]+\]))?/g;

export function countRawPalette(text: string): number {
  return (
    (text.match(RAW_PALETTE_RE) ?? []).length +
    (text.match(DARK_SCALE_RE) ?? []).length +
    (text.match(WHITE_ALPHA_RE) ?? []).length
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

export function areaOf(relPath: string): string {
  const parts = relPath.split('/');
  if (parts[0] === 'components' && parts.length > 2) return `components/${parts[1]}`;
  if (parts.length === 1) return '(root)';
  return parts[0];
}

interface Baseline {
  allowlist: Array<{ file: string; reason: string }>;
  areas: Record<string, number>;
}

export function collectCounts(): { counts: Record<string, number>; total: number } {
  const baseline = loadBaseline();
  const allowlisted = new Set(baseline.allowlist.map((entry) => entry.file));
  const counts: Record<string, number> = {};
  let total = 0;
  for (const file of walk(SRC_ROOT)) {
    const rel = relative(SRC_ROOT, file).split('\\').join('/');
    if (allowlisted.has(rel)) continue;
    const count = countRawPalette(readFileSync(file, 'utf8'));
    if (count === 0) continue;
    const area = areaOf(rel);
    counts[area] = (counts[area] ?? 0) + count;
    total += count;
  }
  return { counts, total };
}

export function loadBaseline(): Baseline {
  try {
    const parsed: unknown = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return { allowlist: [], areas: {} };
    const record = parsed as Partial<Baseline>;
    return {
      allowlist: Array.isArray(record.allowlist) ? record.allowlist : [],
      areas:
        typeof record.areas === 'object' && record.areas !== null
          ? (record.areas as Record<string, number>)
          : {},
    };
  } catch {
    return { allowlist: [], areas: {} };
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.includes('--write-baseline')) {
    const baseline = loadBaseline();
    const { counts } = collectCounts();
    const sorted: Record<string, number> = {};
    for (const key of Object.keys(counts).sort()) sorted[key] = counts[key];
    const next: Baseline = { allowlist: baseline.allowlist, areas: sorted };
    await Bun.write(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`);
    process.stdout.write(`baseline written: ${BASELINE_PATH}\n`);
    return;
  }

  const baseline = loadBaseline();
  const { counts, total } = collectCounts();
  let failed = false;
  const areas = new Set([...Object.keys(baseline.areas), ...Object.keys(counts)]);
  for (const area of [...areas].sort()) {
    const before = baseline.areas[area] ?? 0;
    const after = counts[area] ?? 0;
    if (after > before) {
      failed = true;
      process.stdout.write(`REGRESSION ${area}: ${before} -> ${after}\n`);
    } else if (after < before) {
      failed = true;
      process.stdout.write(
        `STALE BASELINE ${area}: ${before} -> ${after} (commit the tightened baseline with --write-baseline)\n`
      );
    }
  }
  const baselineTotal = Object.values(baseline.areas).reduce((sum, n) => sum + n, 0);
  process.stdout.write(`raw palette utilities: ${total} (baseline ${baselineTotal})\n`);
  if (failed) process.exit(1);
}

if (import.meta.main) {
  await main();
}
