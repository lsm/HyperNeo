export function parsePromptMarkdown(content: string, label: string): { id: string; body: string } {
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

export function expandIncludes(
  body: string,
  label: string,
  registry: Record<string, string>,
  stack: readonly string[] = []
): string {
  return body.replace(includePattern, (_all, rel: string) => {
    const raw = registry[rel];
    if (raw === undefined) throw new Error(`${label}: unknown include ${rel}`);
    if (stack.includes(rel)) throw new Error(`${label}: include cycle at ${rel}`);
    const included = parsePromptMarkdown(raw, rel);
    return expandIncludes(included.body, rel, registry, [...stack, rel]);
  });
}

export function buildPromptRegistry(files: Record<string, string>): Record<string, string> {
  const prompts: Record<string, string> = {};
  for (const rel of Object.keys(files).sort()) {
    const { id, body } = parsePromptMarkdown(files[rel], rel);
    if (id in prompts) throw new Error(`${rel}: duplicate id ${id}`);
    prompts[id] = expandIncludes(body, rel, files, [rel]);
  }
  return prompts;
}
