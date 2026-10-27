import { createHash } from 'node:crypto';
import type { NeoAskTodoRepository } from '../../../storage/repositories/neo-ask-todo-repository.ts';
import { readNeoQuestion } from '../question-operations.ts';
import {
  type HomeSaveInput,
  type HomeSavePlan,
  isVisibleHomeProposal,
  requireHomeSave,
} from './save.ts';

export function requireHomeConfirmation(
  input: HomeSaveInput,
  store: NeoAskTodoRepository,
  sessionId: string | undefined
): { value: HomeSavePlan } | { reason: { ok: false; reason: string } } {
  if (!['direction.md', 'mandate.md'].includes(input.path.split('/').at(-1)!.toLowerCase()))
    return { value: input };
  const question = store.getQuestion(input.questionId ?? '');
  const read = readNeoQuestion(question);
  const confirm = question?.confirm;
  const sha256 = createHash('sha256').update(input.content, 'utf8').digest('hex');
  if (
    !question ||
    !read.ok ||
    !read.answeredByHuman ||
    read.question.kind !== 'yesno' ||
    read.question.answer !== 'yes' ||
    read.question.answeredAt === null ||
    !sessionId ||
    store.getAsk(question.askId)?.sessionId !== sessionId ||
    !confirm ||
    confirm.path !== input.path ||
    confirm.sha256 !== sha256 ||
    !isVisibleHomeProposal(question.text, confirm)
  )
    return {
      reason: {
        ok: false as const,
        reason:
          'confirmation_required: provide a matching human yes on a root-Neo question bound to this exact path and content SHA-256.',
      },
    };
  const entry = `\n## ${new Date(read.question.answeredAt).toISOString()}\n\n${input.message}\n\nPath: ${input.path}\nSHA-256: ${sha256}\nConfirmed by human: question ${question.id}\n\n${question.text}\n`;
  const content = requireHomeSave({ ...input, content: entry }, false);
  return content.reason
    ? content
    : { value: { ...input, confirmation: { questionId: question.id, entry } } };
}
