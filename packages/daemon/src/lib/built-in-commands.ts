import { MERGE_SESSION_COMMAND_PROMPT } from '@hyperneo/prompts';
export interface BuiltInCommand {
  name: string;
  description: string;
  prompt: string;
}

const BUILT_IN_COMMANDS: BuiltInCommand[] = [
  {
    name: 'merge-session',
    description:
      'Complete the current worktree session by committing, merging to target branch, and pushing',
    prompt: MERGE_SESSION_COMMAND_PROMPT,
  },
];

export function getBuiltInCommandNames(): string[] {
  return BUILT_IN_COMMANDS.map((cmd) => cmd.name);
}

export function expandBuiltInCommand(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const commandName = trimmed.slice(1).split(/\s+/)[0];
  const command = BUILT_IN_COMMANDS.find((cmd) => cmd.name === commandName);

  if (!command) {
    return null;
  }

  return command.prompt;
}
