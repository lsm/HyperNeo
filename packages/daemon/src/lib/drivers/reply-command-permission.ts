const POSIX_REPLY_COMMAND =
  /^hyperneo send(?: +(?:'[^'\r\n]*'|"[^"$`\\\r\n]*"|\\[^\r\n]|[^\s'";&|`$<>(){}\\])+)+$/;
const WINDOWS_REPLY_COMMAND = /^hyperneo send(?: +[^\s'";&|`$<>(){}\\%^!\r\n]+)+$/;

export function isReplyCommand(
  command: string | undefined,
  platform: NodeJS.Platform = process.platform
): boolean {
  const rule = platform === 'win32' ? WINDOWS_REPLY_COMMAND : POSIX_REPLY_COMMAND;
  return command !== undefined && rule.test(command);
}

export function replyCommandPermission(
  options: readonly { optionId: string; kind: string }[],
  command: string | undefined,
  platform: NodeJS.Platform = process.platform
) {
  const allow = options.find((option) => option.kind === 'allow_once');
  return allow && isReplyCommand(command, platform)
    ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}
