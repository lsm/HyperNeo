import { createInterface } from 'node:readline';

const profile = 'open-agent-protocol.agent-control-core';
const revision = 'fake-r1';
let sequence = 0;

function write(type, payload, scope = {}) {
  const envelope = {
    protocol: 'open-agent-protocol',
    version: '0.1',
    profile,
    type,
    id: `e-${++sequence}`,
    ...scope,
    payload,
  };
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}

function event(type, payload) {
  write(
    type,
    { session_id: 's-1', run_id: 'run-1', ...payload },
    { session_id: 's-1', run_id: 'run-1', sequence }
  );
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  const reply = { in_reply_to: request.id };
  const revised = request.capability_revision === revision;
  switch (request.type) {
    case 'protocol.initialize.request':
      write('protocol.initialize.response', { protocol_version: '0.1', profile }, reply);
      return;
    case 'capabilities.request':
      write(
        'capabilities.response',
        { endpoint: { id: 'fake' }, features: {} },
        { ...reply, capability_revision: revision }
      );
      return;
    case 'session.open.request':
      if (!revised) {
        write(
          'error.response',
          { error: { code: 'stale_revision', message: 'cite the revision' } },
          reply
        );
        return;
      }
      write(
        'session.open.response',
        { session_id: request.payload.session_id },
        { ...reply, session_id: 's-1' }
      );
      return;
    case 'session.message.submit.request': {
      const prompt = request.payload.messages[0].content;
      write(
        'session.message.submit.response',
        { session_id: 's-1', accepted: true, run_id: 'run-1', admission: 'started' },
        { ...reply, session_id: 's-1' }
      );
      event('run.started', { status: 'running' });
      if (prompt === 'ask') {
        event('action.permission.requested', {
          interaction_id: 'i-1',
          tool_call_id: 't-9',
          title: 'Run a command',
        });
        return;
      }
      event('content.delta', { part: { type: 'reasoning', reasoning: 'thinking' } });
      event('content.delta', { part: { type: 'text', text: 'Look' } });
      event('action.call.started', {
        tool_call_id: 't-1',
        execution_owner: 'agent',
        name: 'Read',
        arguments_json: { path: 'a.txt' },
      });
      event('action.call.completed', {
        tool_call_id: 't-1',
        execution_owner: 'agent',
        result: 'contents',
      });
      event('content.delta', { part: { type: 'text', text: 'Done' } });
      event('run.completed', {
        final_response: { role: 'assistant', content: 'Done' },
        stop_reason: 'end_turn',
        usage: { input_tokens: 2, output_tokens: 3 },
      });
      return;
    }
    case 'run.cancel.request':
      write(
        'run.cancel.response',
        { session_id: 's-1', run_id: 'run-1', accepted: true },
        { ...reply, session_id: 's-1', run_id: 'run-1' }
      );
      event('run.cancelled', { reason: 'cancel requested' });
      return;
    default:
      write('error.response', { error: { code: 'unsupported', message: request.type } }, reply);
  }
});
