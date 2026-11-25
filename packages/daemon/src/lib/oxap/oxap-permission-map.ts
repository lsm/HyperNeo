import superpipe, { type PipelineAPI } from 'superpipe';
import { z } from 'zod';

const Identifier = z.string().min(1);
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

export const mapUserInputRequest = (superpipe({})('oap.question.request') as PipelineAPI)
  .input('request')
  .pipe(parseUserInput, 'request', 'parsed')
  .pipe(userInputToTool, 'parsed', 'mapped')
  .end('mapped') as (
  request: unknown
) => CanUseInput | { kind: 'unsupported'; reason: 'unsupported text question' };
