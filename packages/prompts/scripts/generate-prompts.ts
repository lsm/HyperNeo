import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const srcDir = join(import.meta.dir, '..', 'src');
const generatedPath = join(srcDir, 'generated', 'prompts.generated.ts');
const checkMode = process.argv.includes('--check');

function listMarkdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listMarkdownFiles(full));
    else if (entry.name.endsWith('.md')) found.push(full);
  }
  return found.sort();
}

function parseMarkdown(content: string, label: string): { id: string; body: string } {
  if (!content.startsWith('---\n')) throw new Error(`${label}: missing frontmatter`);
  const end = content.indexOf('\n---\n', 3);
  if (end === -1) throw new Error(`${label}: unterminated frontmatter`);
  const match = content.slice(4, end).match(/^id:[ \t]*(\S+)[ \t]*$/m);
  if (!match?.[1]) throw new Error(`${label}: missing id`);
  let body = content.slice(end + 5);
  if (body.endsWith('\n')) body = body.slice(0, -1);
  return { id: match[1], body };
}

const includePattern = /(?:\n)?<!--[ \t]*include:[ \t]*(\S+?)[ \t]*-->\n?/g;

function expand(body: string, label: string, stack: readonly string[]): string {
  return body.replace(includePattern, (_all, rel: string) => {
    const includePath = join(srcDir, rel);
    if (stack.includes(includePath)) throw new Error(`${label}: include cycle at ${rel}`);
    const included = parseMarkdown(readFileSync(includePath, 'utf8'), rel);
    return expand(included.body, rel, [...stack, includePath]);
  });
}

const lines: string[] = [];
const ids = new Set<string>();
for (const file of listMarkdownFiles(srcDir)) {
  const rel = relative(srcDir, file).split('\\').join('/');
  const { id, body } = parseMarkdown(readFileSync(file, 'utf8'), rel);
  if (ids.has(id)) throw new Error(`${rel}: duplicate id ${id}`);
  ids.add(id);
  lines.push(`export const ${id} = ${JSON.stringify(expand(body, rel, [file]))};`);
}
const output = `${lines.join('\n')}\n`;

if (checkMode) {
  let current = '';
  try {
    current = readFileSync(generatedPath, 'utf8');
  } catch {
    current = '';
  }
  if (current !== output) {
    console.error(
      `packages/prompts: generated registry is stale — run 'bun run prompts:generate' and commit`
    );
    process.exit(1);
  }
  console.log(`packages/prompts: ${ids.size} prompts in sync`);
} else {
  mkdirSync(join(srcDir, 'generated'), { recursive: true });
  writeFileSync(generatedPath, output);
  console.log(`packages/prompts: generated ${ids.size} prompts`);
}
