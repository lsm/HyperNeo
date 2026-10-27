import { createServer } from 'node:http';

const MARKER = 'verify-cross-repo';
const pr = (repo: string, number: number) => ({
  title: `Attach lsm/${repo}#${number}`,
  doneWhen: `lsm/${repo}#${number} merged`,
  check: {
    pack: 'coding',
    kind: 'pr_merged',
    params: { urls: [`https://github.com/lsm/${repo}/pull/${number}`] },
  },
});
const ASK = {
  name: 'neo.ask.open',
  input: {
    title: 'Attach open PRs',
    request: 'Attach the open PRs to their sessions',
    todos: [pr('HyperNeo', 101), pr('open-agent-protocol', 202), pr('HyperNeo', 103)],
  },
};

type Body = {
  stream?: boolean;
  messages?: { role?: string; content?: unknown }[];
  tools?: { name: string }[];
};

createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (req.url?.startsWith('/v1/models')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [], has_more: false }));
    return;
  }
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Body;
  if (req.url?.startsWith('/v1/messages/count_tokens')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ input_tokens: 100 }));
    return;
  }
  const invoke = body.tools?.find((tool) => tool.name.endsWith('hyperneo-operations__invoke'));
  const afterAssistant = (body.messages?.findLastIndex((message) => message.role === 'assistant') ?? -1) + 1;
  const content = body.messages?.slice(afterAssistant).flatMap((message) => message.content) ?? [];
  const toolResult = content.some((block) => typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result');
  const last = JSON.stringify(content ?? '');
  const goalId = /verify-goal-ask:([a-zA-Z0-9-]+)/.exec(last)?.[1];
  const ask = goalId ? {
    name: 'neo.ask.open',
    input: { title: 'Ship the goal guide', request: 'Publish the adapter guide', goalId,
      todos: [{ title: 'Publish guide', doneWhen: 'Guide published' }] },
  } : ASK;
  const block =
    invoke && (goalId || last.includes(MARKER)) && !toolResult
      ? { type: 'tool_use', id: `toolu_${Date.now()}`, name: invoke.name, input: ask }
      : { type: 'text', text: 'Filed the request. Done.' };
  console.log(`${new Date().toISOString()} ${req.url} -> ${block.type}`);
  const message = {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-20250514',
    content: [block],
    stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 30 },
  };
  if (!body.stream) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(message));
    return;
  }
  res.setHeader('content-type', 'text/event-stream');
  const event = (type: string, data: unknown) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  event('message_start', {
    type: 'message_start',
    message: { ...message, content: [], stop_reason: null },
  });
  event('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' },
  });
  event('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta:
      'input' in block
        ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) }
        : { type: 'text_delta', text: block.text },
  });
  event('content_block_stop', { type: 'content_block_stop', index: 0 });
  event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: 30 },
  });
  event('message_stop', { type: 'message_stop' });
  res.end();
}).listen(Number(process.env.VERIFY_MOCK_PORT ?? 8000), '127.0.0.1', () =>
  console.log(`scripted Neo model ready on 127.0.0.1:${process.env.VERIFY_MOCK_PORT ?? 8000}`)
);
