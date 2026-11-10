import type { NeoAskEntry } from '@hyperneo/shared/types/neo-ask';
import superpipe, { type PipelineAPI } from 'superpipe';
import { LOCAL_RPC_PRINCIPAL } from '../operations/caller.ts';
import { invokeOperation, type OperationOutcome } from '../operations/invoke.ts';
import { resolveOperationRegistry, type OperationRegistrySource } from '../operations/registry.ts';
import type { UpgradeIdentity } from '../pairing/upgrade-auth.ts';
import { AGENT_READ_HINT } from '../pairing/agent-read.ts';

function inline(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[\\`*_[\]<>#]/g, '\\$&');
}

export function renderAskMarkdown(entry: NeoAskEntry): string {
  const sections = [`# ${inline(entry.ask.title)}`, `Status: ${entry.state}`];
  if (entry.todos.length) {
    sections.push('## Todos');
    sections.push(
      entry.todos.map((todo) => `- ${inline(todo.title)} — ${inline(todo.status)}`).join('\n')
    );
  }
  const questions = entry.questions.filter((question) => question.state === 'open');
  if (questions.length) {
    sections.push('## Open questions');
    for (const question of questions) {
      sections.push(`### ${inline(question.text)}`);
      const options =
        question.kind === 'yesno'
          ? [question.yesLabel ?? 'Yes', question.noLabel ?? 'No']
          : (question.options ?? []);
      if (options.length) sections.push(options.map((option) => `- ${inline(option)}`).join('\n'));
    }
  }
  if (entry.ask.outcome) sections.push('## Outcome', entry.ask.outcome);
  return `${sections.join('\n\n')}\n`;
}

function errorResponse(message: string, status: number): Response {
  return new Response(message, { status, headers: { 'Cache-Control': 'no-store' } });
}

function markdownResponse(outcome: OperationOutcome): Response {
  if (outcome.kind === 'failed') {
    const status = {
      forbidden: 403,
      invalid_input: 400,
      unknown_operation: 503,
      execution_failed: 500,
      invalid_result: 500,
    }[outcome.code];
    return errorResponse('Unable to read card', status);
  }
  const result = outcome.value as { ok: true; entry: NeoAskEntry } | { ok: false; reason: string };
  if (!result.ok) {
    return result.reason.startsWith('not_found:')
      ? errorResponse('Not found', 404)
      : errorResponse('Unable to read card', 500);
  }
  return new Response(renderAskMarkdown(result.entry), {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export function createAskMarkdownHandler(
  registry: OperationRegistrySource,
  authenticateUpgrade: (
    req: Request,
    remoteAddress: string | null
  ) => Promise<UpgradeIdentity | null>
): (req: Request, remoteAddress: string | null) => Promise<Response | null> {
  const read = (superpipe({})('ask-markdown-http') as PipelineAPI)
    .input(['req', 'remoteAddress', 'encodedId'])
    .pipe(authenticateUpgrade, ['req', 'remoteAddress'], 'device')
    .pipe(
      (device: UpgradeIdentity | null) =>
        device ? { value: device } : { reason: errorResponse(AGENT_READ_HINT, 401) },
      'device',
      'result:response'
    )
    .pipe(
      (encodedId: string) => {
        try {
          return { value: decodeURIComponent(encodedId) };
        } catch {
          return { reason: errorResponse('Invalid card id', 400) };
        }
      },
      'encodedId',
      'result:response'
    )
    .pipe(
      (askId: string, device: UpgradeIdentity) =>
        invokeOperation(
          resolveOperationRegistry(registry),
          'neo.ask.read',
          { askId },
          {
            source: 'rpc',
            principal: LOCAL_RPC_PRINCIPAL,
            ...(device.kind === 'agent' ? {} : { device }),
          }
        ),
      ['response', 'device'],
      'outcome'
    )
    .pipe(markdownResponse, 'outcome', 'response')
    .endAsync('response') as (
    req: Request,
    remoteAddress: string | null,
    encodedId: string
  ) => Promise<Response>;
  return async (req, remoteAddress) => {
    const match = /^\/ask\/([^/]+)\.md$/.exec(new URL(req.url).pathname);
    return req.method === 'GET' && match ? read(req, remoteAddress, match[1]) : null;
  };
}
