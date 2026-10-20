import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
type Block = { type: string; id?: string; name?: string; input?: unknown; text?: string };
type Body = { stream?: boolean; messages?: { content?: Block[] | string }[]; tools?: { name: string }[] };
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  if (req.url?.startsWith('/v1/models')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [], has_more: false })); return; }
  if (req.url?.startsWith('/v1/messages/count_tokens')) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ input_tokens: 100 })); return; }
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}') as Body;
  const results = body.messages?.flatMap((message) => Array.isArray(message.content) ? message.content.filter((block) => block.type === 'tool_result') : []) ?? [];
  if (results.length) await writeFile(join(process.env.HOME!, '..', 'evidence', 'sdk-tool-results.json'), JSON.stringify(results, null, 2));
  let content: Block[] = [{ type: 'text', text: 'Home guard SDK verification complete.' }];
  if (JSON.stringify(body.messages ?? []).includes('verify-home-guard-sdk') && !results.length) {
    content = [
      { type: 'tool_use', id: 'toolu_home_read', name: 'Read', input: { file_path: '../../README.md' } },
      { type: 'tool_use', id: 'toolu_home_redirect', name: 'Bash', input: { command: 'echo changed > ../../sdk-should-not-exist.md' } },
      { type: 'tool_use', id: 'toolu_home_clobber', name: 'Bash', input: { command: 'echo clobbered >| ../../sdk-clobber-should-not-exist.md' } },
      { type: 'tool_use', id: 'toolu_home_git', name: 'Bash', input: { command: 'git branch sdk-should-not-exist' } },
      { type: 'tool_use', id: 'toolu_home_git_absolute', name: 'Bash', input: { command: '/usr/bin/git branch sdk-absolute-should-not-exist' } },
      { type: 'tool_use', id: 'toolu_home_git_env', name: 'Bash', input: { command: `cd / && GIT_DIR=${join(process.env.HOME!, '..', 'data', 'Neo', '.git')} git branch sdk-env-should-not-exist` } },
      { type: 'tool_use', id: 'toolu_home_grep_git', name: 'Grep', input: { path: '../..', pattern: '.', glob: '**/.git/**', output_mode: 'files_with_matches' } },
      { type: 'tool_use', id: 'toolu_home_grep_coordinators', name: 'Grep', input: { path: '../..', pattern: '.', glob: '.coordinators/**', output_mode: 'files_with_matches' } },
      { type: 'tool_use', id: 'toolu_home_ignored_read', name: 'Read', input: { file_path: '../../human-private/draft.md' } },
      { type: 'tool_use', id: 'toolu_home_ignored_grep', name: 'Grep', input: { path: '../..', pattern: '.', glob: '**/draft.md', output_mode: 'files_with_matches' } },
      { type: 'tool_use', id: 'toolu_home_ignored_glob', name: 'Glob', input: { path: '../..', pattern: '**/draft.md' } },
      { type: 'tool_use', id: 'toolu_home_public_grep', name: 'Grep', input: { path: '../../projects', pattern: 'Release', glob: '*.md', output_mode: 'files_with_matches' } },
      { type: 'tool_use', id: 'toolu_home_public_glob', name: 'Glob', input: { path: '../..', pattern: 'projects/**/*.md' } },
    ];
  }
  if (JSON.stringify(body.messages ?? []).includes('verify-home-uninitialized-sdk') && !results.length) {
    content = [
      { type: 'tool_use', id: 'toolu_uninitialized_read', name: 'Read', input: { file_path: '../../human-private/draft.md' } },
      { type: 'tool_use', id: 'toolu_uninitialized_grep', name: 'Grep', input: { path: '../../human-private', pattern: '.', output_mode: 'files_with_matches' } },
      { type: 'tool_use', id: 'toolu_uninitialized_glob', name: 'Glob', input: { path: '../..', pattern: '**/draft.md' } },
    ];
  }
  const message = { id: `msg_${Date.now()}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-20250514', content, stop_reason: content[0].type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 30 } };
  if (!body.stream) { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)); return; }
  res.setHeader('content-type', 'text/event-stream');
  const event = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  event('message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } });
  content.forEach((block, index) => {
    event('content_block_start', { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' } });
    event('content_block_delta', { type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text } });
    event('content_block_stop', { type: 'content_block_stop', index });
  });
  event('message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 30 } });
  event('message_stop', { type: 'message_stop' }); res.end();
}).listen(8000, '127.0.0.1');
