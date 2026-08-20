import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { SCOPED_BASH_TOOL_PATTERN } from '@hyperneo/shared';

export function parseScopedBashPrefix(entry: string): string | null {
  const match = SCOPED_BASH_TOOL_PATTERN.exec(entry);
  if (!match) return null;
  const prefix = match[1].trim();
  return prefix.length > 0 ? prefix : null;
}

export function extractBashScopePrefixes(entries: readonly string[]): string[] {
  const prefixes: string[] = [];
  for (const entry of entries) {
    const prefix = parseScopedBashPrefix(entry);
    if (prefix) prefixes.push(prefix);
  }
  return prefixes;
}

export function bashScopeDenyReason(prefixes: readonly string[]): string {
  return (
    'Bash is permission-scoped to read-only gh PR inspection and review posting; ' +
    `allowed command prefixes: ${prefixes.join(', ')}. This denial is the permission boundary ` +
    'working as designed — the Reviewer does not run tests, builds, or app code. Do not retry ' +
    'with command variants and do not route around it (no sh -c / bash -c, no writing scripts ' +
    'to files to execute them, no interpreters). Validate by reading; CI and QA run the code.'
  );
}

export function createBashScopeHook(prefixes: readonly string[]): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const command = (input.tool_input as Record<string, unknown> | undefined)?.command;
    if (typeof command !== 'string') return {};
    if (isBashCommandAllowed(command, prefixes)) return {};
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse' as const,
        permissionDecision: 'deny' as const,
        permissionDecisionReason: bashScopeDenyReason(prefixes),
      },
    };
  };
}

interface BalancedSpan {
  content: string;
  end: number;
}

function extractBalancedParen(text: string, openIndex: number): BalancedSpan {
  const n = text.length;
  let depth = 0;
  let i = openIndex;
  while (i < n) {
    const ch = text[i];
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      i = close === -1 ? n : close + 1;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          i += 2;
          continue;
        }
        if (text[i] === '$' && text[i + 1] === '(') {
          i = extractBalancedParen(text, i + 1).end;
          continue;
        }
        if (text[i] === '`') {
          i = extractBacktick(text, i).end;
          continue;
        }
        i++;
      }
      if (i < n) i++;
      continue;
    }
    if (ch === '\\' && i + 1 < n) {
      i += 2;
      continue;
    }
    if (ch === '(') {
      depth++;
      i++;
      continue;
    }
    if (ch === ')') {
      depth--;
      i++;
      if (depth === 0) return { content: text.slice(openIndex + 1, i - 1), end: i };
      continue;
    }
    if (ch === '`') {
      i = extractBacktick(text, i).end;
      continue;
    }
    i++;
  }
  return { content: text.slice(openIndex + 1), end: n };
}

function extractBacktick(text: string, startIndex: number): BalancedSpan {
  const n = text.length;
  let i = startIndex + 1;
  while (i < n) {
    const ch = text[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      i = close === -1 ? n : close + 1;
      continue;
    }
    if (ch === '`') return { content: text.slice(startIndex + 1, i), end: i + 1 };
    i++;
  }
  return { content: text.slice(startIndex + 1), end: n };
}

interface HeredocMarker {
  found: boolean;
  quoted: boolean;
  markerEnd: number;
  bodyEnd: number;
}

function extractHeredocSpan(text: string, start: number): HeredocMarker {
  const n = text.length;
  let i = start;
  const dashed = text[i] === '-';
  if (dashed) i++;
  while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
  let quote = '';
  if (text[i] === '"' || text[i] === "'") {
    quote = text[i];
    i++;
  }
  let delimiter = '';
  while (i < n && /[A-Za-z0-9_]/.test(text[i])) {
    delimiter += text[i];
    i++;
  }
  if (quote && text[i] === quote) i++;
  if (!delimiter) return { found: false, quoted: false, markerEnd: i, bodyEnd: i };
  const markerEnd = i;
  while (i < n && text[i] !== '\n') i++;
  if (i < n) i++;
  while (i < n) {
    let lineEnd = text.indexOf('\n', i);
    if (lineEnd === -1) lineEnd = n;
    const line = text.slice(i, lineEnd);
    const candidate = dashed ? line.replace(/^\t+/, '') : line;
    if (candidate.trim() === delimiter) {
      return { found: true, quoted: quote !== '', markerEnd, bodyEnd: lineEnd + 1 };
    }
    i = lineEnd + 1;
  }
  return { found: true, quoted: quote !== '', markerEnd, bodyEnd: n };
}

const DENIED_ASSIGNMENT_NAMES = new Set([
  'PATH',
  'ENV',
  'BASH_ENV',
  'SHELLOPTS',
  'BASHOPTS',
  'IFS',
  'SHELL',
  'CDPATH',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'DYLD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'PS4',
]);

function stripLeadingAssignments(segment: string): string | null {
  let s = segment;
  for (;;) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(s);
    if (!match) return s;
    if (DENIED_ASSIGNMENT_NAMES.has(match[1])) return null;
    let rest = match[2];
    if (rest.startsWith('"') || rest.startsWith("'")) {
      const close = rest.indexOf(rest[0], 1);
      if (close === -1) return '';
      rest = rest.slice(close + 1);
    } else {
      const boundary = rest.search(/[\s;|&]/);
      rest = boundary === -1 ? '' : rest.slice(boundary);
    }
    s = rest.replace(/^[ \t]+/, '');
    if (!s) return '';
  }
}

function segmentHasAllowedHead(segment: string, prefixes: readonly string[]): boolean {
  let s = segment.trim();
  if (!s) return true;
  s = s
    .replace(/^[({]+/, '')
    .replace(/[})]+$/, '')
    .trim();
  if (!s) return true;
  const stripped = stripLeadingAssignments(s);
  if (stripped === null) return false;
  s = stripped;
  if (!s) return true;
  for (const prefix of prefixes) {
    if (s === prefix) return true;
    if (!s.startsWith(prefix)) continue;
    const next = s.charAt(prefix.length);
    if (
      next === '' ||
      next === ' ' ||
      next === '\t' ||
      next === '>' ||
      next === '<' ||
      next === '/'
    ) {
      return true;
    }
  }
  return false;
}

export function isBashCommandAllowed(command: string, prefixes: readonly string[]): boolean {
  if (prefixes.length === 0) return false;
  const normalized = command.replace(/\\\r?\n/g, ' ');
  return checkCommandText(normalized, prefixes);
}

function checkCommandText(text: string, prefixes: readonly string[]): boolean {
  const n = text.length;
  let i = 0;
  let current = '';
  let lineHasContent = false;
  let pendingHeredoc: HeredocMarker | null = null;
  let ok = true;

  const flush = (): boolean => {
    const segment = current;
    current = '';
    lineHasContent = false;
    if (!segmentHasAllowedHead(segment, prefixes)) ok = false;
    return ok;
  };

  const skipPendingHeredocBody = (): number => {
    if (!pendingHeredoc) return -1;
    const bodyEnd = pendingHeredoc.bodyEnd;
    pendingHeredoc = null;
    return bodyEnd;
  };

  while (i < n) {
    const ch = text[i];
    if (ch === "'") {
      const close = text.indexOf("'", i + 1);
      const stop = close === -1 ? n : close + 1;
      current += text.slice(i, stop);
      lineHasContent = true;
      i = stop;
      continue;
    }
    if (ch === '"') {
      i++;
      let inner = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          inner += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === '$' && text[i + 1] === '(') {
          const span = extractBalancedParen(text, i + 1);
          if (!checkCommandText(span.content, prefixes)) ok = false;
          i = span.end;
          continue;
        }
        if (text[i] === '`') {
          const span = extractBacktick(text, i);
          if (!checkCommandText(span.content, prefixes)) ok = false;
          i = span.end;
          continue;
        }
        inner += text[i];
        i++;
      }
      current += `"${inner}"`;
      lineHasContent = true;
      if (i < n) i++;
      continue;
    }
    if (ch === '\\' && i + 1 < n) {
      current += ch + text[i + 1];
      lineHasContent = true;
      i += 2;
      continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      const span = extractBalancedParen(text, i + 1);
      if (!checkCommandText(span.content, prefixes)) ok = false;
      current += '$()';
      lineHasContent = true;
      i = span.end;
      continue;
    }
    if (ch === '`') {
      const span = extractBacktick(text, i);
      if (!checkCommandText(span.content, prefixes)) ok = false;
      current += '``';
      lineHasContent = true;
      i = span.end;
      continue;
    }
    if (ch === '<' && text[i + 1] === '<' && text[i + 2] !== '<') {
      const span = extractHeredocSpan(text, i + 2);
      if (!span.found) {
        current += '<<';
        lineHasContent = true;
        i += 2;
        continue;
      }
      current += '<<HEREDOC';
      if (!span.quoted) ok = false;
      pendingHeredoc = span;
      i = span.markerEnd;
      continue;
    }
    if (ch === '<' && text[i + 1] === '<' && text[i + 2] === '<') {
      current += '<<<';
      lineHasContent = true;
      i += 3;
      continue;
    }
    if (ch === '#' && (!lineHasContent || /[ \t]$/.test(current))) {
      let lineEnd = text.indexOf('\n', i);
      if (lineEnd === -1) lineEnd = n;
      flush();
      const bodyEnd = skipPendingHeredocBody();
      i = bodyEnd === -1 ? lineEnd + 1 : bodyEnd;
      continue;
    }
    if (ch === ';' || ch === '\n') {
      const isLineEnd = ch === '\n';
      flush();
      const bodyEnd = isLineEnd ? skipPendingHeredocBody() : -1;
      i = bodyEnd === -1 ? i + 1 : bodyEnd;
      continue;
    }
    if (ch === '&') {
      if (text[i + 1] === '&') {
        flush();
        i += 2;
        continue;
      }
      if (text[i + 1] === '>') {
        current += '&>';
        i += 2;
        continue;
      }
      if (current.endsWith('>')) {
        current += ch;
        i++;
        continue;
      }
      flush();
      i++;
      continue;
    }
    if (ch === '|') {
      flush();
      i += text[i + 1] === '|' ? 2 : 1;
      continue;
    }
    if (ch === '(' || ch === ')') {
      flush();
      i++;
      continue;
    }
    if (ch !== ' ' && ch !== '\t' && ch !== '\r') lineHasContent = true;
    current += ch;
    i++;
  }
  flush();
  return ok;
}
