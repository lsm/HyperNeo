#!/usr/bin/env bun

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const daemon = resolve(import.meta.dir, '../packages/daemon');
const core = join(daemon, 'src/lib/neo');
const packs = join(core, 'packs') + sep;
const config = ts.readConfigFile(join(daemon, 'tsconfig.json'), ts.sys.readFile);
if (config.error) throw new Error(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, daemon);
const violations: string[] = [];
for (const entry of readdirSync(core, { recursive: true }).map(String)) {
  if (!entry.endsWith('.ts') || entry.startsWith(`packs${sep}`)) continue;
  const file = join(core, entry);
  for (const imported of ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles) {
    const target = ts.resolveModuleName(imported.fileName, file, options, ts.sys).resolvedModule;
    const path = target?.resolvedFileName ?? resolve(dirname(file), imported.fileName);
    if (path.startsWith(packs))
      violations.push(`${relative(daemon, file)} -> ${imported.fileName}`);
  }
}
if (violations.length) {
  console.error('Neo core may not import pack implementations:\n' + violations.join('\n'));
  process.exit(1);
}
console.log('Neo core imports no pack implementations.');
