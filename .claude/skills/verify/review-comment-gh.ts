#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [run, ...args] = process.argv.slice(2);
appendFileSync(join(run, 'evidence/gh.log'), `gh ${JSON.stringify(args)}\n`);
const store = join(run, 'comments.json');
const comments: { path: string; body: string }[] = existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : [];
if (args[0] === 'api' && args.includes('/rate_limit')) {
  const reset = Math.floor(Date.now() / 1000) + 600;
  console.log(JSON.stringify({ resources: { core: { remaining: 0, reset } } }));
  process.exit(0);
}
if (existsSync(join(run, 'rate-limited'))) {
  console.error('gh: API rate limit exceeded for user ID 1. (HTTP 403)');
  process.exit(1);
}
const path = args.find((arg) => /^repos\/.+\/issues\/\d+\/comments$/.test(arg));
if (args[0] !== 'api' || !path) {
  console.error(`review comment gh stub: unsupported gh ${args.join(' ')}`);
  process.exit(1);
}
if (args.includes('GET')) {
  console.log(JSON.stringify([comments.filter((item) => item.path === path).map(({ body }) => ({ body }))]));
  process.exit(0);
}
const body = args.find((arg) => arg.startsWith('body='))?.slice('body='.length);
if (!args.includes('POST') || body === undefined) {
  console.error('review comment gh stub: expected POST body');
  process.exit(1);
}
comments.push({ path, body });
writeFileSync(store, JSON.stringify(comments, null, 2));
process.stdout.write(`HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ id: comments.length })}`);
