export function fitLines(lines: readonly string[], budget: number, used = 0): string[] {
  const kept: string[] = [];
  let total = used;
  for (const line of lines) {
    if (total + line.length + 1 > budget) break;
    kept.push(line);
    total += line.length + 1;
  }
  return kept;
}
