import { describe, expect, it } from 'bun:test';
import {
  noteStreamFed,
  noteStreamMessage,
  planStreamSilence,
  type StreamSilenceState,
} from '../../../../src/lib/agent/stream-silence-watch';

const quiet: StreamSilenceState = { lastActivityAt: 0, openTools: [] };
const TOOL_STALL_MS = 1000;
const plan = (state: StreamSilenceState, now: number, processing = true) =>
  planStreamSilence({
    state,
    processing,
    now,
    thresholdMs: 100,
    openToolStallMs: TOOL_STALL_MS,
  });

describe('a silent model request', () => {
  it('stalls a processing turn after the threshold of silence and waits out the rest before it', () => {
    expect(plan(quiet, 40)).toEqual({ stalled: false, waitMs: 60 });
    expect(plan(quiet, 100)).toEqual({ stalled: true, silentMs: 100 });
  });

  it('is not armed while idle', () => {
    expect(plan(quiet, 500, false)).toEqual({ stalled: false, waitMs: 100 });
  });

  it('waits out an open tool up to the tool bound, then stalls instead of hanging forever', () => {
    const tool = noteStreamMessage(
      quiet,
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1' }] } },
      0
    );
    expect(plan(tool, 500)).toEqual({ stalled: false, waitMs: 500 });
    expect(plan(tool, TOOL_STALL_MS)).toEqual({ stalled: true, silentMs: TOOL_STALL_MS });
    const done = noteStreamMessage(
      tool,
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } },
      900
    );
    expect(done.openTools).toEqual([]);
    expect(plan(done, 950)).toEqual({ stalled: false, waitMs: 50 });
  });
});

describe('noteStreamMessage', () => {
  it('counts every message and a fed prompt as activity, and waits out an SDK retry delay', () => {
    expect(noteStreamMessage(quiet, { type: 'stream_event' }, 30).lastActivityAt).toBe(30);
    expect(noteStreamFed(quiet, 70).lastActivityAt).toBe(70);
    const retrying = noteStreamMessage(
      quiet,
      { type: 'system', subtype: 'api_retry', retry_delay_ms: 500 },
      10
    );
    expect(plan(retrying, 400)).toEqual({ stalled: false, waitMs: 210 });
  });

  it('ignores subagent tool calls and clears open tools when the turn ends', () => {
    const sub = noteStreamMessage(
      quiet,
      {
        type: 'assistant',
        parent_tool_use_id: 'task',
        message: { content: [{ type: 'tool_use', id: 'inner' }] },
      },
      5
    );
    expect(sub).toEqual({ lastActivityAt: 5, openTools: [] });
    const open = { lastActivityAt: 0, openTools: ['t1'] };
    expect(noteStreamMessage(open, { type: 'result' }, 9)).toEqual({
      lastActivityAt: 9,
      openTools: [],
    });
  });
});
