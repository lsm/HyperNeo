import { describe, expect, it } from 'bun:test';
import type { ServerResponse } from 'node:http';
import {
  ToolBridgeRegistry,
  mapAnthropicToolsToSdkTools,
} from '../../../../../src/lib/providers/anthropic-copilot/tool-bridge';
import type { AnthropicTool } from '../../../../../src/lib/providers/anthropic-copilot/types';
import { AnthropicStreamWriter } from '../../../../../src/lib/providers/anthropic-copilot/sse';

function makeRes(): { written: string[]; ended: boolean; res: ServerResponse } {
  const written: string[] = [];
  let ended = false;
  const res = {
    writeHead: () => {},
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    end: () => {
      ended = true;
    },
  } as unknown as ServerResponse;
  return { written, ended, res };
}

describe('ToolBridgeRegistry', () => {
  it('resolveToolResult returns false for unknown id', () => {
    const reg = new ToolBridgeRegistry();
    expect(reg.resolveToolResult('unknown', 'result')).toBe(false);
  });

  it('hasPending returns false initially', () => {
    const reg = new ToolBridgeRegistry();
    expect(reg.hasPending()).toBe(false);
  });

  it('emitToolUseAndWait resolves when resolveToolResult is called', async () => {
    const reg = new ToolBridgeRegistry();
    const writer = new AnthropicStreamWriter();
    const { res } = makeRes();
    writer.start(res, 'model');
    reg.setActiveResponse(writer, res);

    const promise = reg.emitToolUseAndWait('tc_1', 'bash', { command: 'ls' });
    expect(reg.hasPending()).toBe(true);
    expect(reg.pendingIds()).toContain('tc_1');

    const resolved = reg.resolveToolResult('tc_1', 'output here');
    expect(resolved).toBe(true);

    const result = await promise;
    expect(result).toEqual({ text: 'output here', isError: false });
    expect(reg.hasPending()).toBe(false);
  });

  it('emitToolUseAndWait throws when no active response', async () => {
    const reg = new ToolBridgeRegistry();
    await expect(reg.emitToolUseAndWait('tc_1', 'bash', {})).rejects.toThrow(
      'no active SSE response'
    );
  });

  it('rejectAll prevents stale microtask from writing after response is closed', async () => {
    const reg = new ToolBridgeRegistry();
    const writer = new AnthropicStreamWriter();
    const { written, res } = makeRes();
    writer.start(res, 'model');
    reg.setActiveResponse(writer, res);

    const p1 = reg.emitToolUseAndWait('tc_1', 'bash', {});
    void p1.catch(() => {});

    reg.rejectAll(new Error('disconnect'));

    const writtenBefore = written.length;
    await Promise.resolve();
    expect(written.length).toBe(writtenBefore);
    expect(
      (reg as unknown as Record<string, unknown>)['pendingEmissions'] as unknown[]
    ).toHaveLength(0);
  });

  it('rejectAll rejects all pending promises', async () => {
    const reg = new ToolBridgeRegistry();
    const writer = new AnthropicStreamWriter();
    const { res } = makeRes();
    writer.start(res, 'model');
    reg.setActiveResponse(writer, res);
    const p1 = reg.emitToolUseAndWait('tc_1', 'bash', {});
    const p2 = reg.emitToolUseAndWait('tc_2', 'read', {});

    void p1.catch(() => {});
    void p2.catch(() => {});
    reg.rejectAll(new Error('session closed'));

    await expect(p1).rejects.toThrow('session closed');
    await expect(p2).rejects.toThrow('session closed');
    expect(reg.hasPending()).toBe(false);
  });

  it('calls onToolUseEmitted callback after writing SSE', async () => {
    const reg = new ToolBridgeRegistry();
    const writer = new AnthropicStreamWriter();
    const { res } = makeRes();
    writer.start(res, 'model');
    reg.setActiveResponse(writer, res);

    let emittedIds: string[] | null = null;
    reg.setOnToolUseEmitted((ids) => {
      emittedIds = ids;
    });

    const promise = reg.emitToolUseAndWait('tc_x', 'myTool', {});
    await Promise.resolve();
    expect(emittedIds).toEqual(['tc_x']);

    reg.resolveToolResult('tc_x', 'done');
    await promise;
  });

  it('parallel tool calls are batched into a single SSE response', async () => {
    const reg = new ToolBridgeRegistry();
    const writer = new AnthropicStreamWriter();
    const { written, res } = makeRes();
    writer.start(res, 'model');
    reg.setActiveResponse(writer, res);

    let emittedIds: string[] | null = null;
    reg.setOnToolUseEmitted((ids) => {
      emittedIds = ids;
    });

    const p1 = reg.emitToolUseAndWait('tc_1', 'bash', { cmd: 'ls' });
    const p2 = reg.emitToolUseAndWait('tc_2', 'read_file', { path: '/tmp' });

    expect(reg.hasPending()).toBe(true);
    expect(reg.pendingIds()).toContain('tc_1');
    expect(reg.pendingIds()).toContain('tc_2');
    expect(emittedIds).toBeNull();

    await Promise.resolve();

    expect(emittedIds).toEqual(['tc_1', 'tc_2']);

    const output = written.join('');
    expect(output).toContain('"tc_1"');
    expect(output).toContain('"tc_2"');
    expect(output).toContain('"bash"');
    expect(output).toContain('"read_file"');

    expect(reg.resolveToolResult('tc_1', 'result1')).toBe(true);
    expect(reg.resolveToolResult('tc_2', 'result2')).toBe(true);

    expect(await p1).toEqual({ text: 'result1', isError: false });
    expect(await p2).toEqual({ text: 'result2', isError: false });
    expect(reg.hasPending()).toBe(false);
  });

  it('calls onPendingToolCall callback when tool call is suspended', async () => {
    const reg = new ToolBridgeRegistry();
    const writer = new AnthropicStreamWriter();
    const { res } = makeRes();
    writer.start(res, 'model');
    reg.setActiveResponse(writer, res);

    let pendingId: string | null = null;
    reg.setOnPendingToolCall((id) => {
      pendingId = id;
    });

    const promise = reg.emitToolUseAndWait('tc_y', 'tool', {});
    expect(pendingId).toBe('tc_y');

    reg.resolveToolResult('tc_y', 'ok');
    await promise;
  });
});

describe('mapAnthropicToolsToSdkTools', () => {
  it('creates one SDK tool per Anthropic tool', () => {
    const tools: AnthropicTool[] = [
      { name: 'bash', input_schema: { type: 'object' } },
      { name: 'read_file', description: 'Read a file', input_schema: { type: 'object' } },
    ];
    const reg = new ToolBridgeRegistry();
    const sdkTools = mapAnthropicToolsToSdkTools(tools, reg);
    expect(sdkTools.length).toBe(2);
    expect(sdkTools[0].name).toBe('bash');
    expect(sdkTools[1].name).toBe('read_file');
  });

  it('sets overridesBuiltInTool on all tools', () => {
    const tools: AnthropicTool[] = [{ name: 'bash', input_schema: {} }];
    const reg = new ToolBridgeRegistry();
    const sdkTools = mapAnthropicToolsToSdkTools(tools, reg);
    expect(sdkTools[0].overridesBuiltInTool).toBe(true);
  });

  it('uses description from AnthropicTool when provided', () => {
    const tools: AnthropicTool[] = [
      { name: 'myTool', description: 'does stuff', input_schema: {} },
    ];
    const reg = new ToolBridgeRegistry();
    const sdkTools = mapAnthropicToolsToSdkTools(tools, reg);
    expect(sdkTools[0].description).toBe('does stuff');
  });

  it('falls back to "Tool: {name}" description when none provided', () => {
    const tools: AnthropicTool[] = [{ name: 'anon', input_schema: {} }];
    const reg = new ToolBridgeRegistry();
    const sdkTools = mapAnthropicToolsToSdkTools(tools, reg);
    expect(sdkTools[0].description).toBe('Tool: anon');
  });

  it('tool handler resolves with resultType:success on success', async () => {
    const tools: AnthropicTool[] = [{ name: 'bash', input_schema: {} }];
    const reg = new ToolBridgeRegistry();
    const sdkTools = mapAnthropicToolsToSdkTools(tools, reg);

    const writer = new AnthropicStreamWriter();
    const { res } = makeRes();
    writer.start(res, 'model');
    reg.setActiveResponse(writer, res);

    const handlerResult = sdkTools[0].handler(
      { command: 'echo hi' },
      { sessionId: 's1', toolCallId: 'tc_1', toolName: 'bash', arguments: { command: 'echo hi' } }
    ) as Promise<unknown>;

    reg.resolveToolResult('tc_1', 'hi\n');

    const result = await handlerResult;
    expect((result as Record<string, unknown>)['textResultForLlm']).toBe('hi\n');
    expect((result as Record<string, unknown>)['resultType']).toBe('success');
  });

  it('tool handler resolves with resultType:failure when is_error=true', async () => {
    const tools: AnthropicTool[] = [{ name: 'bash', input_schema: {} }];
    const reg = new ToolBridgeRegistry();
    const sdkTools = mapAnthropicToolsToSdkTools(tools, reg);

    const writer = new AnthropicStreamWriter();
    const { res } = makeRes();
    writer.start(res, 'model');
    reg.setActiveResponse(writer, res);

    const handlerResult = sdkTools[0].handler(
      { command: 'bad' },
      { sessionId: 's1', toolCallId: 'tc_err', toolName: 'bash', arguments: { command: 'bad' } }
    ) as Promise<unknown>;

    reg.resolveToolResult('tc_err', 'permission denied', true);

    const result = await handlerResult;
    expect((result as Record<string, unknown>)['textResultForLlm']).toBe('permission denied');
    expect((result as Record<string, unknown>)['resultType']).toBe('failure');
  });
});
