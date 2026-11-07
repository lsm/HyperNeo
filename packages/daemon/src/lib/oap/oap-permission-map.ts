import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';

const Identifier = z.string().min(1);
const Scope = z.object({
  interaction_id: Identifier,
  session_id: Identifier,
  run_id: Identifier,
  requested_by: Identifier,
  responded_by: Identifier,
});
const Permission = Scope.extend({
  tool_call_id: Identifier,
  arguments_json: z.record(z.string(), z.unknown()).optional(),
  choices: z.array(z.object({ id: Identifier, label: z.string() })).min(1),
});
const ToolCall = z.object({
  tool_call_id: Identifier,
  name: Identifier,
  arguments_json: z.record(z.string(), z.unknown()).optional(),
});
const Question = z.object({
  id: Identifier,
  prompt: Identifier,
  kind: z.enum(['text', 'single_choice', 'multi_choice']),
  options: z
    .array(z.object({ id: Identifier, label: Identifier, description: z.string().optional() }))
    .optional(),
});
const UserInput = z.object({
  interaction_id: Identifier,
  tool_call_id: Identifier.optional(),
  title: z.string(),
  questions: z.array(Question).min(1).max(4),
});

type CanUseInput = { toolName: string; input: Record<string, unknown>; toolUseID: string };
type PermissionPayload = z.infer<typeof Permission>;
type Resolution = {
  interaction_id: string;
  session_id: string;
  run_id: string;
  requested_by: string;
  responded_by: string;
  granted: boolean;
  choice_id: string;
  reason?: string;
  updated_arguments_json?: Record<string, unknown>;
};

function parsePermission(value: unknown): PermissionPayload {
  return Permission.parse(value);
}

function parseToolCall(value: unknown) {
  return ToolCall.parse(value);
}

function permissionInput(
  permission: PermissionPayload,
  call: z.infer<typeof ToolCall>
): CanUseInput {
  if (permission.tool_call_id !== call.tool_call_id)
    throw new Error('Permission tool call mismatch');
  const input = permission.arguments_json ?? call.arguments_json;
  if (!input) throw new Error('Permission tool arguments unavailable');
  return { toolName: call.name, input, toolUseID: call.tool_call_id };
}

function permissionResolution(permission: PermissionPayload, result: PermissionResult): Resolution {
  if (result.behavior === 'allow' && result.updatedPermissions?.length) {
    throw new Error('Persistent permission updates are unsupported');
  }
  if (result.behavior === 'deny' && result.interrupt) {
    throw new Error('Interrupting permission denial is unsupported');
  }
  const ids = result.behavior === 'allow' ? ['accept', 'approve'] : ['decline', 'deny'];
  const choice = ids.find((id) => permission.choices.some((candidate) => candidate.id === id));
  if (!choice) throw new Error('No supported permission choice');
  return {
    interaction_id: permission.interaction_id,
    session_id: permission.session_id,
    run_id: permission.run_id,
    requested_by: permission.requested_by,
    responded_by: permission.responded_by,
    granted: result.behavior === 'allow',
    choice_id: choice,
    ...(result.behavior === 'deny' ? { reason: result.message } : {}),
    ...(result.behavior === 'allow' && result.updatedInput
      ? { updated_arguments_json: result.updatedInput }
      : {}),
  };
}

function parseUserInput(value: unknown) {
  return UserInput.parse(value);
}

function userInputToTool(
  request: z.infer<typeof UserInput>
): CanUseInput | { kind: 'unsupported'; reason: 'unsupported text question' } {
  if (request.questions.some((question) => question.kind === 'text' || !question.options?.length)) {
    return { kind: 'unsupported', reason: 'unsupported text question' };
  }
  const questions = request.questions.map((question) => {
    if (!question.options?.length || question.options.length > 64) {
      throw new Error('Question cannot be represented by AskUserQuestion');
    }
    if (new Set(question.options.map((option) => option.label)).size !== question.options.length) {
      throw new Error('Question option labels must be unique');
    }
    return {
      question: question.prompt,
      header: request.title,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description ?? '',
      })),
      multiSelect: question.kind === 'multi_choice',
    };
  });
  return {
    toolName: 'AskUserQuestion',
    toolUseID: request.tool_call_id ?? request.interaction_id,
    input: { questions },
  };
}

export const mapPermissionRequest = (superpipe({})('oap.permission.request') as PipelineAPI)
  .input(['request', 'call'])
  .pipe(parsePermission, 'request', 'permission')
  .pipe(parseToolCall, 'call', 'toolCall')
  .pipe(permissionInput, ['permission', 'toolCall'], 'mapped')
  .end('mapped') as (request: unknown, call: unknown) => CanUseInput;

export const mapPermissionResolution = (superpipe({})('oap.permission.resolve') as PipelineAPI)
  .input(['request', 'result'])
  .pipe(parsePermission, 'request', 'permission')
  .pipe(permissionResolution, ['permission', 'result'], 'mapped')
  .end('mapped') as (request: unknown, result: PermissionResult) => Resolution;

export const mapUserInputRequest = (superpipe({})('oap.question.request') as PipelineAPI)
  .input('request')
  .pipe(parseUserInput, 'request', 'parsed')
  .pipe(userInputToTool, 'parsed', 'mapped')
  .end('mapped') as (
  request: unknown
) => CanUseInput | { kind: 'unsupported'; reason: 'unsupported text question' };
