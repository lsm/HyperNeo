import type { EvalCase, EvalTopic, EvalTurn, SystemOneRequest } from './types.ts';

export const RECENT_TURN_CHARS = 3_000;
const ASK_CHARS = 300;
const ANSWER_CHARS = 160;
const SUMMARY_CHARS = 240;

export const MAIN_ID = 'main';
export const INBOX_ID = 'inbox';

export const ROUTE_RULES = [
  'A message that continues a recent turn goes to that turn’s topic.',
  'An answer to a WAITING question goes to that topic.',
  'A standalone message goes to the topic it matches, to inbox if it is a self-contained one-off, or to main if it starts a new subject.',
  'If unsure, or if more than one topic is WAITING for the answer, choose main.',
];

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function ageLabel(at: string, now: string): string {
  const minutes = Math.max(0, Math.round((Date.parse(now) - Date.parse(at)) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}

export function renderTopic(topic: EvalTopic): string {
  const lines = [
    `- id: ${topic.id}`,
    `  title: ${clip(topic.title, 120)}`,
    `  summary: ${clip(topic.summary, SUMMARY_CHARS) || '(none)'}`,
  ];
  if (topic.latest) {
    lines.push(
      `  latest: you: ${clip(topic.latest.ask, ASK_CHARS)} → ${clip(topic.latest.answer, ANSWER_CHARS)}`
    );
  }
  if (topic.waiting) lines.push(`  WAITING: asked you "${clip(topic.waiting, ANSWER_CHARS)}"`);
  return lines.join('\n');
}

export function renderRecentTurns(turns: readonly EvalTurn[], now: string): string {
  const lines: string[] = [];
  let used = 0;
  for (const turn of [...turns].reverse()) {
    const line = `[${turn.topic} · ${ageLabel(turn.at, now)}] you: ${clip(turn.ask, ASK_CHARS)} → ${clip(turn.answer, ANSWER_CHARS)}`;
    if (used + line.length > RECENT_TURN_CHARS) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length > 0 ? lines.join('\n') : '(none)';
}

export function buildRouteState(evalCase: EvalCase): string {
  const topics = evalCase.topics.map(renderTopic).join('\n');
  return `Topics:\n${topics || '(none)'}\n\nRecent turns (newest first):\n${renderRecentTurns(evalCase.turns, evalCase.now)}\n\nNew message:\n${evalCase.message}`;
}

export function routeCriteria(evalCase: EvalCase): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const topic of evalCase.topics) {
    criteria[topic.id] = topic.waiting
      ? `Topic “${clip(topic.title, 80)}”, waiting for the user’s answer`
      : `Topic “${clip(topic.title, 80)}”`;
  }
  criteria[INBOX_ID] = 'Inbox: a self-contained one-off that needs no continuing topic';
  criteria[MAIN_ID] = 'Main Neo: a new subject, several topics at once, or unclear';
  return criteria;
}

export function buildRouteRequest(evalCase: EvalCase, model?: string): SystemOneRequest {
  return {
    state: buildRouteState(evalCase),
    ...(model ? { model } : {}),
    questions: {
      route: {
        type: 'choice',
        instructions: `Where should the new message go? ${ROUTE_RULES.join(' ')}`,
        criteria: routeCriteria(evalCase),
      },
    },
  };
}

export function buildContextPrompt(evalCase: EvalCase): string {
  const ids = [...evalCase.topics.map((topic) => topic.id), INBOX_ID, MAIN_ID].join(', ');
  return `Route the user's new message to the place that should answer it.

${buildRouteState(evalCase)}

Rules:
${ROUTE_RULES.map((rule) => `- ${rule}`).join('\n')}

Reply with exactly one id and nothing else, one of: ${ids}.`;
}

export function readRouteAnswer(raw: string, evalCase: EvalCase): string {
  const answer = raw
    .trim()
    .replace(/^[`"']+|[`"']+$/g, '')
    .trim();
  const ids = new Set([...evalCase.topics.map((topic) => topic.id), INBOX_ID]);
  return ids.has(answer) ? answer : MAIN_ID;
}
