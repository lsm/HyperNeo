import type { EvolutionLesson, SpaceTask } from '@hyperneo/shared';

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'you',
  'all',
  'can',
  'had',
  'her',
  'was',
  'one',
  'our',
  'out',
  'day',
  'get',
  'has',
  'him',
  'his',
  'how',
  'its',
  'may',
  'new',
  'now',
  'old',
  'see',
  'two',
  'way',
  'who',
  'boy',
  'did',
  'she',
  'use',
  'her',
  'its',
  'say',
  'too',
  'any',
  'set',
  'she',
  'try',
  'let',
  'put',
  'end',
  'why',
  'per',
  'via',
]);

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 3 && !STOP_WORDS.has(word)) {
      tokens.add(word);
    }
  }
  return tokens;
}

function buildTaskTokens(task: SpaceTask): Set<string> {
  const tokens = tokenize(`${task.title} ${task.description}`);
  for (const label of task.labels) {
    const clean = label.toLowerCase().trim();
    if (clean.length >= 2) tokens.add(clean);
  }
  return tokens;
}

function buildLessonTokens(lesson: EvolutionLesson): Set<string> {
  const tokens = tokenize(`${lesson.rule} ${lesson.why}`);
  for (const tag of lesson.appliesTo) {
    const clean = tag.toLowerCase().trim();
    if (clean.length >= 2) tokens.add(clean);
  }
  return tokens;
}

function countOverlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const item of a) {
    if (b.has(item)) count++;
  }
  return count;
}

function normalizeRecencyScore(lessons: EvolutionLesson[]): Map<string, number> {
  const scores = new Map<string, number>();
  if (lessons.length <= 1) {
    for (const lesson of lessons) scores.set(lesson.id, 0);
    return scores;
  }
  let minUpdated = Infinity;
  let maxUpdated = -Infinity;
  for (const lesson of lessons) {
    if (lesson.updatedAt < minUpdated) minUpdated = lesson.updatedAt;
    if (lesson.updatedAt > maxUpdated) maxUpdated = lesson.updatedAt;
  }
  const range = maxUpdated - minUpdated || 1;
  for (const lesson of lessons) {
    scores.set(lesson.id, ((lesson.updatedAt - minUpdated) / range) * 0.49);
  }
  return scores;
}

export function rankLessonsByTaskRelevance(
  lessons: EvolutionLesson[],
  task: SpaceTask
): EvolutionLesson[] {
  if (lessons.length <= 1) return [...lessons];
  const taskTokens = buildTaskTokens(task);
  const recencyScores = normalizeRecencyScore(lessons);
  const scored = lessons.map((lesson) => {
    const lessonTokens = buildLessonTokens(lesson);
    const tagOverlap = countOverlap(
      new Set(lesson.appliesTo.map((t) => t.trim().toLowerCase())),
      new Set(task.labels.map((l) => l.trim().toLowerCase()))
    );
    const keywordOverlap = countOverlap(taskTokens, lessonTokens);
    const score =
      tagOverlap * 10 +
      keywordOverlap * 2 +
      lesson.confidence * 0.5 +
      (recencyScores.get(lesson.id) ?? 0);
    return { lesson, score };
  });
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.lesson.updatedAt - a.lesson.updatedAt;
  });
  return scored.map((s) => s.lesson);
}
