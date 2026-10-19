import type { ChatMessage } from '@hyperneo/shared';
import superpipe, { type PipelineAPI } from 'superpipe';
import { getToolHeader } from '../components/sdk/tools/tool-utils.ts';
import { projectNeoMessageImageSources } from './neo-message-images.ts';

export type SessionItemKind =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool'; name: string; summary: string; result: string | null; isError: boolean }
  | { type: 'thinking'; text: string };

export type SessionItem = {
  id: string;
  kind: SessionItemKind;
  date: number;
  images: unknown[];
  finished?: number;
};

export type SessionSteps = {
  id: string;
  items: SessionItem[];
  running: boolean;
  start: number;
  end: number;
};

export type SessionEntry =
  | { type: 'item'; id: string; item: SessionItem }
  | { type: 'steps'; id: string; steps: SessionSteps };

type Row = {
  type?: unknown;
  uuid?: unknown;
  id?: unknown;
  timestamp?: unknown;
  parent_tool_use_id?: unknown;
  inputKind?: unknown;
  message?: { content?: unknown };
};

type Block = Record<string, unknown>;

const summaryKeys = [
  'command',
  'file_path',
  'path',
  'pattern',
  'url',
  'query',
  'description',
  'prompt',
];

export function isSessionStep(item: SessionItem): boolean {
  return item.kind.type === 'tool' || item.kind.type === 'thinking';
}

export function sessionToolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  for (const key of summaryKeys) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === 'string' && value) return value.split('\n')[0];
  }
  return '';
}

export function sessionToolResult(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const texts = content.flatMap((block: Block) =>
    block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  );
  return texts.length ? texts.join('\n') : null;
}

function imageBlocks(content: unknown): unknown[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => projectNeoMessageImageSources([block]).length > 0);
}

const NEO_TURN_END = 'Done.';

export function sessionItems(messages: readonly ChatMessage[], neo = false): SessionItem[] {
  const out: SessionItem[] = [];
  const toolIndex = new Map<string, number>();
  for (const row of messages as readonly Row[]) {
    if (row.parent_tool_use_id) continue;
    const date = typeof row.timestamp === 'number' ? row.timestamp : 0;
    const rowId = String(row.uuid ?? row.id ?? `${out.length}`);
    const content = row.message?.content;
    const blocks: Block[] = Array.isArray(content) ? content : [];
    const system = row.inputKind === 'system';
    if (row.type === 'user') {
      if (typeof content === 'string') {
        if (content && !system)
          out.push({ id: rowId, kind: { type: 'user', text: content }, date, images: [] });
        continue;
      }
      const texts: string[] = [];
      let hadToolResult = false;
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
        if (block?.type !== 'tool_result') continue;
        hadToolResult = true;
        const at = toolIndex.get(String(block.tool_use_id));
        const tool = at === undefined ? undefined : out[at];
        if (!tool || tool.kind.type !== 'tool') continue;
        out[at!] = {
          ...tool,
          finished: date,
          kind: {
            ...tool.kind,
            result: sessionToolResult(block.content) ?? '',
            isError: block.is_error === true,
          },
        };
      }
      const images = imageBlocks(content);
      if ((texts.length || (images.length && !hadToolResult)) && !system)
        out.push({ id: rowId, kind: { type: 'user', text: texts.join('\n\n') }, date, images });
      continue;
    }
    if (row.type !== 'assistant') continue;
    const images = imageBlocks(content);
    let imagesPlaced = false;
    blocks.forEach((block, index) => {
      const id = `${rowId}#${index}`;
      if (neo && block?.type === 'text' && String(block.text).trim() === NEO_TURN_END) return;
      if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
        out.push({
          id,
          kind: { type: 'assistant', text: block.text },
          date,
          images: imagesPlaced ? [] : images,
        });
        imagesPlaced = true;
      } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') {
        const text = typeof block.thinking === 'string' ? block.thinking : '';
        out.push({ id, kind: { type: 'thinking', text }, date, images: [] });
      } else if (block?.type === 'tool_use') {
        const toolId = typeof block.id === 'string' ? block.id : id;
        toolIndex.set(toolId, out.length);
        const raw = typeof block.name === 'string' ? block.name : 'Tool';
        const header =
          raw.startsWith('mcp__') || raw === 'invoke' ? getToolHeader(raw, block.input) : null;
        const name = header?.name ?? raw;
        const summary = header ? (header.detail ?? '') : sessionToolSummary(block.input);
        out.push({
          id: toolId,
          kind: { type: 'tool', name, summary, result: null, isError: false },
          date,
          images: [],
        });
      }
    });
    if (!imagesPlaced && images.length)
      out.push({ id: rowId, kind: { type: 'assistant', text: '' }, date, images });
  }
  return out;
}

type Group = { message: SessionItem | null; steps: SessionItem[] };

function flushTurn(turn: SessionItem[], last: boolean, running: boolean): SessionEntry[] {
  const groups: Group[] = [];
  for (const item of turn) {
    if (isSessionStep(item) && groups.length) groups[groups.length - 1].steps.push(item);
    else if (isSessionStep(item)) groups.push({ message: null, steps: [item] });
    else groups.push({ message: item, steps: [] });
  }
  return groups.flatMap((group, index): SessionEntry[] => {
    const out: SessionEntry[] = group.message
      ? [{ type: 'item', id: group.message.id, item: group.message }]
      : [];
    const first = group.steps[0];
    if (!first) return out;
    const live = last && running && index === groups.length - 1;
    if (group.steps.length === 1 && !live)
      return [...out, { type: 'item', id: first.id, item: first }];
    const following = groups[index + 1];
    const next = following ? (following.message ?? following.steps[0]).date : null;
    const steps: SessionSteps = {
      id: `steps-${first.id}`,
      items: group.steps,
      running: live,
      start: group.message?.date ?? first.date,
      end: next ?? Math.max(...group.steps.map((step) => step.finished ?? step.date)),
    };
    return [...out, { type: 'steps', id: steps.id, steps }];
  });
}

export function sessionEntries(items: readonly SessionItem[], running: boolean): SessionEntry[] {
  const out: SessionEntry[] = [];
  let turn: SessionItem[] = [];
  for (const item of items) {
    if (item.kind.type !== 'user') {
      turn.push(item);
      continue;
    }
    out.push(...flushTurn(turn, false, running), { type: 'item', id: item.id, item });
    turn = [];
  }
  return [...out, ...flushTurn(turn, true, running)];
}

export function sessionEntryBlocks(entries: readonly SessionEntry[]): SessionEntry[][] {
  const out: SessionEntry[][] = [];
  for (const entry of entries) {
    const last = out[out.length - 1];
    const lead = last?.length === 1 ? last[0] : null;
    const step = entry.type === 'steps' || isSessionStep(entry.item);
    if (lead?.type === 'item' && lead.item.kind.type === 'assistant' && step) last.push(entry);
    else out.push([entry]);
  }
  return out;
}

export function sessionStepCounts(steps: SessionSteps): { tools: number; thinking: number } {
  return {
    tools: steps.items.filter((item) => item.kind.type === 'tool').length,
    thinking: steps.items.filter((item) => item.kind.type === 'thinking').length,
  };
}

export function sessionDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

export function sessionClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return s < 3600 ? `${Math.floor(s / 60)}:${ss}` : `${Math.floor(s / 3600)}:${mm}:${ss}`;
}

export const projectSessionTranscript = (superpipe({})('neo-session-transcript') as PipelineAPI)
  .input(['messages', 'running', 'neo'])
  .pipe(sessionItems, ['messages', 'neo'], 'items')
  .pipe(sessionEntries, ['items', 'running'], 'entries')
  .pipe(sessionEntryBlocks, 'entries', 'blocks')
  .end('blocks') as (
  messages: readonly ChatMessage[],
  running: boolean,
  neo?: boolean
) => SessionEntry[][];
