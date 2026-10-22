#!/usr/bin/env bun
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2).filter((arg) => arg !== '--include');
appendFileSync(join(root, 'evidence', 'gh.log'), `${JSON.stringify(args)}\n`);
if (args[0] === 'pr' && args[1] === 'view') {
 await Bun.write(Bun.stdout, readFileSync(join(root, 'pr.json'), 'utf8')); process.exit(0);
}
if (args.length === 4 && args[0] === 'api' && args[1] === '--hostname' && args[2] === 'github.com') {
 const fixtures = JSON.parse(readFileSync(join(root, 'git-fixtures.json'), 'utf8'));
 if (Object.hasOwn(fixtures, args[3])) { const fixture = fixtures[args[3]]; await Bun.write(Bun.stdout, fixture?.rawText ?? JSON.stringify(fixture)); process.exit(0); }
}
process.stderr.write('unsupported isolated gh fixture'); process.exit(1);
