const REPLY_COMMAND = /^hyperneo send [^;&|`$<>(){}\\\r\n]+$/;

export function isReplyCommand(command: string | undefined): boolean {
  return command !== undefined && REPLY_COMMAND.test(command);
}

export function replyCommandPermission(
  options: readonly { optionId: string; kind: string }[],
  command: string | undefined
) {
  const allow = options.find((option) => option.kind === 'allow_once');
  return allow && isReplyCommand(command)
    ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}
