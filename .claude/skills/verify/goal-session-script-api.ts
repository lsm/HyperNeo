import { createServer } from 'node:http';

const WAKE = 'This session owns the goal below.';
type Block = { type?: string; text?: string; content?: unknown };
type Body = { stream?: boolean; messages?: { role?: string; content?: unknown }[]; tools?: { name: string }[] };

function nextBlock(body: Body) {
  const invoke = body.tools?.find((tool) => tool.name.endsWith('hyperneo-operations__invoke'));
  const messages = body.messages ?? [];
  const wakeAt = messages.findLastIndex((message) => message.role === 'user' && JSON.stringify(message.content).includes(WAKE));
  if (wakeAt < 0) return { type: 'text', text: 'Noted.' };
  if (!invoke)
    return { type: 'tool_use', id: `toolu_${Date.now()}_search`, name: 'ToolSearch', input: { query: 'select:mcp__hyperneo-operations__invoke', max_results: 1 } };
  const wake = JSON.stringify(messages[wakeAt].content);
  const [, goalId, runId] = /goal\.journal\.append entry for goalId ([^,]+), runId ([^.\\"]+?)\./.exec(wake) ?? [];
  const step = messages.slice(wakeAt).flatMap((message) => (message.role === 'assistant' && Array.isArray(message.content) ? message.content : []))
    .filter((block) => block?.type === 'tool_use' && String(block.name).endsWith('hyperneo-operations__invoke')).length;
  const review = wake.includes('Read the journal pages and rewrite');
  const calls = [
    { name: 'goal.journal.append', input: { goalId, runId, done: 'Posted the guide in two forums', effect: 'Three readers arrived', worked: 'Forum posts with one example' } },
    ...(review
      ? [
          { name: 'goal.session.update', input: { goalId, worksNote: 'Forum posts with one example bring readers.' } },
          { name: 'session.clone.return', input: { summary: `Review of goal ${goalId}: forum posts with one example worked; three readers arrived.` } },
        ]
      : []),
  ];
  const call = calls[step];
  return call
    ? { type: 'tool_use', id: `toolu_${Date.now()}_${step}`, name: invoke.name, input: call }
    : { type: 'text', text: review ? 'Journaled the run; review sent to Neo.' : 'Journaled the work run.' };
}

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  res.setHeader('content-type', 'application/json');
  if (req.url?.startsWith('/v1/models')) return res.end(JSON.stringify({ data: [], has_more: false }));
  if (req.url?.startsWith('/v1/messages/count_tokens')) return res.end(JSON.stringify({ input_tokens: 100 }));
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Body;
  const block = nextBlock(body);
  console.log(`${new Date().toISOString()} ${req.url} -> ${block.type} ${'input' in block ? (block.input as { name: string }).name : ''}`);
  const message = {
    id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514', content: [block],
    stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 30 },
  };
  if (!body.stream) return res.end(JSON.stringify(message));
  res.setHeader('content-type', 'text/event-stream');
  const event = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
  event('content_block_delta', {
    type: 'content_block_delta', index: 0,
    delta: 'input' in block ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: (block as Block).text },
  });
  event('content_block_stop', { type: 'content_block_stop', index: 0 });
  event('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 30 } });
  event('message_stop', { type: 'message_stop' });
  res.end();
}).listen(Number(process.env.VERIFY_MOCK_PORT ?? 8000), '127.0.0.1', () =>
  console.log(`scripted goal-session model ready on 127.0.0.1:${process.env.VERIFY_MOCK_PORT ?? 8000}`)
);
